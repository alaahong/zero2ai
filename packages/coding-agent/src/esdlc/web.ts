/**
 * ESDLC web workspace.
 *
 * Loopback-only HTTP server + JSON API + one embedded page. Free of build steps
 * and third-party assets: the whole UI is the string below, so it runs on an
 * air-gapped host and can be reviewed by reading this file.
 *
 * Threat model: local tool. Binds 127.0.0.1, rejects non-loopback `Host`
 * headers (DNS-rebinding guard), same-origin only (no CORS headers), confines
 * artifact reads to the workspace, and caps request/artifact sizes.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ESDLC_PHASES, ESDLC_PHASE_LABELS, readEsdlcState, renderEsdlcBannerArt, runEsdlcPhase } from "./index";
import { esdlcCatalogs, isEsdlcLocale } from "./i18n";
import { currentImpact } from "./code-graph";
import type { EsdlcCodeGraph } from "./code-graph";
import type { EsdlcDeployFacts, EsdlcQualityReport, EsdlcScaffoldResult } from "./types";
import {
	readPhaseEvents,
	readPhaseJson,
	readRunLogTail,
	readProjectTree,
	readQualityHistory,
	writePhaseConfig,
	writeWorkspaceLocale,
	writeWorkspaceNotes,
} from "./state";
import { listBoundModels } from "./models";
import { isEsdlcPhaseId, type EsdlcPhaseId } from "./types";

export const ESDLC_WEB_HOST = "127.0.0.1";
export const DEFAULT_ESDLC_WEB_PORT = 3848;

const LOOPBACK_HOSTS: Readonly<Record<string, true>> = {
	"127.0.0.1": true,
	localhost: true,
	"[::1]": true,
	"::1": true,
};
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 512 * 1024;
const MAX_WRITE_BYTES = 1024 * 1024;
const MAX_SPEC_SOURCES = 20;
const MAX_CONFIG_FIELD_CHARS = 500;
const MAX_PROMPT_CHARS = 4000;

export interface EsdlcWebOptions {
	readonly projectRoot: string;
	readonly port?: number;
	readonly host?: string;
}

export interface EsdlcWebHandle {
	readonly url: string;
	readonly port: number;
	stop(): void;
}

function hostIsLoopback(request: Request): boolean {
	const header = request.headers.get("host");
	if (!header) return false;
	const hostname = header.startsWith("[") ? header.slice(0, header.indexOf("]") + 1) : (header.split(":")[0] ?? "");
	return LOOPBACK_HOSTS[hostname.toLowerCase()] === true;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});
}

/**
 * Files are served from the project the workspace belongs to, never from outside it.
 *
 * The tree spans the whole project (an artifact-only tree hides the code a build wrote), so
 * the boundary is the project root: absolute paths and `../` escapes are refused.
 */
function resolveInside(projectRoot: string, requested: string): string {
	const root = path.resolve(projectRoot);
	const resolved = path.resolve(root, requested);
	if (resolved !== root && !resolved.startsWith(root + path.sep)) {
		throw new Error("path escapes the project directory");
	}
	return resolved;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
	const raw = await request.text();
	if (raw.length > MAX_BODY_BYTES) throw new Error("request body too large");
	const parsed: unknown = JSON.parse(raw);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("request body must be a JSON object");
	}
	return parsed as Record<string, unknown>;
}

/** Parse a JSON body, turning any parse/size failure into a 400 response. */
async function parseBody(request: Request): Promise<Record<string, unknown> | Response> {
	try {
		return await readBody(request);
	} catch (error) {
		return json({ error: (error as Error).message }, 400);
	}
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
	const value = body[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Answer channels for phases parked on a human question, keyed by the question id the runner
 * persisted (the same id the page echoes back to `/api/answer`).
 */
const pendingQuestions = new Map<string, (text: string) => void>();

/** Resume a parked phase. Returns false when the question is no longer pending. */
function answerQuestion(questionId: string, text: string): boolean {
	const resolve = pendingQuestions.get(questionId);
	if (!resolve) return false;
	pendingQuestions.delete(questionId);
	resolve(text);
	return true;
}

/** Start a phase without awaiting it: the page polls for progress and questions. */
function startPhase(projectRoot: string, body: Record<string, unknown>): Response {
	const phase = stringField(body, "phase") ?? "";
	if (!isEsdlcPhaseId(phase)) return json({ error: `phase must be one of: ${ESDLC_PHASES.join(", ")}` }, 400);
	void runEsdlcPhase(projectRoot, phase as EsdlcPhaseId, {
		...(stringField(body, "input") ? { input: stringField(body, "input") } : {}),
		...(stringField(body, "prompt") ? { prompt: stringField(body, "prompt") } : {}),
		...(stringField(body, "model") ? { model: stringField(body, "model") } : {}),
		...(stringField(body, "command") ? { command: stringField(body, "command") } : {}),
		// Park the phase on the question until the page submits an answer.
		requestInput: question => {
			const { promise, resolve } = Promise.withResolvers<string>();
			pendingQuestions.set(question.id, resolve);
			return promise;
		},
	}).catch(() => {
		// Failures are persisted into the phase record; nothing to report here.
	});
	return json({ started: true, phase });
}

/** NUL bytes mean the file is not text; the editor must not round-trip it. */
async function looksBinary(file: string): Promise<boolean> {
	try {
		const sample = await Bun.file(file).slice(0, 8192).arrayBuffer();
		return new Uint8Array(sample).includes(0);
	} catch {
		return false;
	}
}

/**
 * Save an edit to a project file.
 *
 * The workspace is a review surface: the operator edits the documents and code in it, so writes
 * are allowed anywhere inside the project (never `.git`), and binary payloads are refused rather
 * than silently corrupted.
 */
async function handleWriteFile(projectRoot: string, body: Record<string, unknown>): Promise<Response> {
	const requested = stringField(body, "path") ?? "";
	const text = body.text;
	if (!requested) return json({ error: "path is required" }, 400);
	if (typeof text !== "string") return json({ error: "text must be a string" }, 400);
	if (text.length > MAX_WRITE_BYTES) return json({ error: "text too large to write" }, 413);
	let resolved: string;
	try {
		resolved = resolveInside(projectRoot, requested);
	} catch (error) {
		return json({ error: (error as Error).message }, 403);
	}
	const relative = path.relative(path.resolve(projectRoot), resolved).replaceAll("\\", "/");
	if (relative === ".git" || relative.startsWith(".git/")) return json({ error: "refusing to write into .git" }, 403);
	if (await looksBinary(resolved)) return json({ error: "refusing to overwrite a binary file" }, 400);
	try {
		await Bun.write(resolved, text);
	} catch (error) {
		return json({ error: (error as Error).message }, 500);
	}
	return json({ path: relative, bytes: Buffer.byteLength(text, "utf8") });
}

async function handleArtifact(projectRoot: string, url: URL): Promise<Response> {
	const requested = url.searchParams.get("path") ?? "";
	if (!requested) return json({ error: "path is required" }, 400);
	let resolved: string;
	try {
		resolved = resolveInside(projectRoot, requested);
	} catch (error) {
		return json({ error: (error as Error).message }, 403);
	}
	try {
		const stat = await fs.stat(resolved);
		if (!stat.isFile()) return json({ error: "not a file" }, 400);
		if (stat.size > MAX_ARTIFACT_BYTES) return json({ error: "artifact too large to display" }, 413);
		return new Response(await Bun.file(resolved).text(), {
			headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
		});
	} catch {
		return json({ error: "artifact not found" }, 404);
	}
}

/** Cached on-demand impact graph: cheap to build, but not once per poll. */
let graphCache: { readonly at: number; readonly key: string; readonly graph: EsdlcCodeGraph } | null = null;

async function handleGraph(projectRoot: string): Promise<Response> {
	const state = await readEsdlcState(projectRoot);
	// Key on the workspace's own update stamp: any phase run or edit invalidates the cache.
	const key = state.updatedAt + ":" + state.phases.build.finishedAt;
	if (graphCache && graphCache.key === key && Date.now() - graphCache.at < 15_000) {
		return json(graphCache.graph);
	}
	const graph = await currentImpact(projectRoot);
	graphCache = { at: Date.now(), key, graph };
	return json(graph);
}

/**
 * Live run log for a phase, so a long command is watchable while it runs.
 *
 * The page polls this; the file is written streaming by the phase itself, so the answer is always
 * the truth on disk rather than a buffered copy in the server.
 */
async function handleLog(projectRoot: string, url: URL): Promise<Response> {
	const phase = url.searchParams.get("phase") ?? "";
	if (!isEsdlcPhaseId(phase)) return json({ error: `phase must be one of: ${ESDLC_PHASES.join(", ")}` }, 400);
	const tail = await readRunLogTail(projectRoot, phase as EsdlcPhaseId);
	const state = await readEsdlcState(projectRoot);
	const run = state.phases[phase as EsdlcPhaseId];
	return json({
		...tail,
		status: run.status,
		startedAt: run.startedAt || null,
		finishedAt: run.finishedAt,
		elapsedMs: run.startedAt
			? (run.finishedAt ? Date.parse(run.finishedAt) : Date.now()) - Date.parse(run.startedAt)
			: 0,
	});
}

/**
 * Structured phase data for the workspace UI: quality signals, deployment facts and the build
 * scaffold record. The JSON files are the source of truth; this endpoint only parses them.
 */
async function handleReport(projectRoot: string, url: URL): Promise<Response> {
	const phase = url.searchParams.get("phase") ?? "";
	if (!isEsdlcPhaseId(phase)) return json({ error: `phase must be one of: ${ESDLC_PHASES.join(", ")}` }, 400);
	if (phase === "test") {
		const quality = await readPhaseJson<EsdlcQualityReport>(projectRoot, "test", "quality.json");
		const history = await readQualityHistory(projectRoot);
		return json({ quality, history: history.slice(-20) });
	}
	if (phase === "deploy") {
		return json({ facts: await readPhaseJson<EsdlcDeployFacts>(projectRoot, "deploy", "deploy-facts.json") });
	}
	if (phase === "build") {
		return json({
			scaffold: await readPhaseJson<EsdlcScaffoldResult>(projectRoot, "build", "scaffold.json"),
			graph: await readPhaseJson<EsdlcCodeGraph>(projectRoot, "build", "code-graph.json"),
		});
	}
	return json({});
}

async function handleEvents(projectRoot: string, url: URL): Promise<Response> {
	const phase = url.searchParams.get("phase") ?? "";
	if (!isEsdlcPhaseId(phase)) return json({ error: `phase must be one of: ${ESDLC_PHASES.join(", ")}` }, 400);
	return json(await readPhaseEvents(projectRoot, phase as EsdlcPhaseId));
}

/** Serve the workspace on loopback until {@link EsdlcWebHandle.stop}. */
export function startEsdlcWeb(options: EsdlcWebOptions): EsdlcWebHandle {
	const host = options.host ?? ESDLC_WEB_HOST;
	const server = Bun.serve({
		hostname: host,
		port: options.port ?? DEFAULT_ESDLC_WEB_PORT,
		fetch: async request => {
			if (!hostIsLoopback(request)) return json({ error: "forbidden host" }, 403);
			const url = new URL(request.url);
			const projectRoot = options.projectRoot;
			if (url.pathname === "/" || url.pathname === "/index.html") {
				return new Response(PAGE, {
					headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
				});
			}
			if (url.pathname === "/api/state") return json(await readEsdlcState(projectRoot));
			if (url.pathname === "/api/models") return json(await listBoundModels(projectRoot));
			if (url.pathname === "/api/tree") return json(await readProjectTree(projectRoot));
			if (url.pathname === "/api/events") return await handleEvents(projectRoot, url);
			if (url.pathname === "/api/report") return await handleReport(projectRoot, url);
			if (url.pathname === "/api/log") return await handleLog(projectRoot, url);
			if (url.pathname === "/api/graph") return await handleGraph(projectRoot);
			if (url.pathname === "/api/config" && request.method === "POST") {
				const body = await parseBody(request);
				if (body instanceof Response) return body;
				const phase = stringField(body, "phase") ?? "";
				if (!isEsdlcPhaseId(phase)) return json({ error: `phase must be one of: ${ESDLC_PHASES.join(", ")}` }, 400);
				const patch: { sources?: string[]; prompt?: string; command?: string } = {};
				if (body.sources !== undefined) {
					if (!Array.isArray(body.sources) || body.sources.some(entry => typeof entry !== "string")) {
						return json({ error: "sources must be an array of strings" }, 400);
					}
					if (body.sources.length > MAX_SPEC_SOURCES) {
						return json({ error: `sources accepts at most ${MAX_SPEC_SOURCES} entries` }, 400);
					}
					const sources = (body.sources as string[]).map(entry => entry.trim()).filter(Boolean);
					if (sources.some(entry => entry.length > MAX_CONFIG_FIELD_CHARS)) {
						return json({ error: "a source is too long" }, 400);
					}
					patch.sources = sources;
				}
				for (const [field, limit] of [
					["prompt", MAX_PROMPT_CHARS],
					["command", MAX_CONFIG_FIELD_CHARS],
				] as const) {
					const value = body[field];
					if (value === undefined) continue;
					if (typeof value !== "string") return json({ error: `${field} must be a string` }, 400);
					if (value.length > limit) return json({ error: `${field} is too long` }, 400);
					patch[field] = value.trim();
				}
				return json(await writePhaseConfig(projectRoot, phase as EsdlcPhaseId, patch));
			}
			if (url.pathname === "/api/artifact") return await handleArtifact(projectRoot, url);
			if (url.pathname === "/api/file" && request.method === "PUT") {
				const body = await parseBody(request);
				if (body instanceof Response) return body;
				return await handleWriteFile(projectRoot, body);
			}
			if (url.pathname === "/api/locale" && request.method === "POST") {
				const body = await parseBody(request);
				if (body instanceof Response) return body;
				const locale = stringField(body, "locale") ?? "";
				if (!isEsdlcLocale(locale)) return json({ error: "locale must be one of: zh, en" }, 400);
				return json(await writeWorkspaceLocale(projectRoot, locale));
			}
			if (url.pathname === "/api/notes" && request.method === "POST") {
				const body = await parseBody(request);
				if (body instanceof Response) return body;
				if (typeof body.notes !== "string") return json({ error: "notes must be a string" }, 400);
				return json(await writeWorkspaceNotes(projectRoot, body.notes));
			}
			if (url.pathname === "/api/run" && request.method === "POST") {
				const body = await parseBody(request);
				if (body instanceof Response) return body;
				return startPhase(projectRoot, body);
			}
			if (url.pathname === "/api/answer" && request.method === "POST") {
				const body = await parseBody(request);
				if (body instanceof Response) return body;
				const questionId = stringField(body, "questionId");
				if (!questionId) return json({ error: "questionId is required" }, 400);
				const accepted = answerQuestion(questionId, typeof body.text === "string" ? body.text : "");
				return accepted ? json({ accepted: true }) : json({ error: "question is no longer pending" }, 404);
			}
			return json({ error: "not found" }, 404);
		},
	});
	const port = server.port ?? options.port ?? DEFAULT_ESDLC_WEB_PORT;
	return { url: `http://${host}:${port}`, port, stop: () => void server.stop(true) };
}

const PHASE_ORDER = JSON.stringify(ESDLC_PHASES);
const PHASE_LABELS = JSON.stringify(ESDLC_PHASE_LABELS);
const FLOW_TEXT = ESDLC_PHASES.map(phase => ESDLC_PHASE_LABELS[phase]).join("  →  ");
const BANNER = renderEsdlcBannerArt().join("\n");
const LOCALE_CATALOGS = JSON.stringify(esdlcCatalogs());

const PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ZERO2AI · ESDLC</title>
<style>
  :root { --bg:#0b0c0e; --panel:#14161a; --panel2:#191c21; --line:#24272d; --fg:#eef0f3; --dim:#8b929c;
          --accent:#f97316; --ok:#22c55e; --err:#ef4444; --warn:#facc15; --code:#7dd3fc; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:14px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif; }
  header { padding:16px 22px 10px; border-bottom:1px solid var(--line); background:linear-gradient(180deg,#101216,transparent); }
  pre.banner { margin:0; color:#f5f6f8; font:11px/1.15 ui-monospace,Consolas,monospace; white-space:pre; }
  .flow { color:var(--accent); font:12px ui-monospace,Consolas,monospace; letter-spacing:.6px; margin:10px 0 0; }
  .meta { display:flex; flex-wrap:wrap; gap:14px; align-items:center; margin-top:8px; color:var(--dim); font-size:12px; }
  code { font:11.5px ui-monospace,Consolas,monospace; color:var(--code); }
  .toolbar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-top:10px; }
  .toolbar select, .toolbar textarea { background:#0e1013; color:var(--fg); border:1px solid var(--line);
              border-radius:6px; padding:5px 9px; font:12px ui-monospace,Consolas,monospace; }
  .toolbar select { min-width:300px; }
  button { background:var(--accent); color:#0b0c0e; border:0; border-radius:6px; padding:6px 13px; font-weight:600; cursor:pointer; }
  button.ghost { background:#1b1e23; color:var(--fg); border:1px solid var(--line); font-weight:500; }
  button:disabled { opacity:.45; cursor:default; }
  .notes-box { margin-top:8px; }
  .notes-box textarea { width:100%; background:#0e1013; color:var(--fg); border:1px solid var(--line);
              border-radius:6px; padding:8px; font:12px ui-monospace,Consolas,monospace; resize:vertical; }
  main { padding:14px 22px 48px; }
  nav.stages { display:flex; flex-wrap:wrap; gap:4px; border-bottom:1px solid var(--line); margin-bottom:14px; }
  nav.stages button { background:transparent; color:var(--dim); border:0; border-bottom:2px solid transparent; border-radius:0;
              padding:9px 14px; font-weight:500; font-size:13px; display:flex; align-items:center; gap:7px; }
  nav.stages button[data-active="true"] { color:var(--fg); border-bottom-color:var(--accent); }
  nav.stages .mark { font:10px ui-monospace,monospace; letter-spacing:.7px; padding:1px 6px; border-radius:999px;
              border:1px solid var(--line); color:var(--dim); }
  nav.stages button[data-status="completed"] .mark { color:var(--ok); border-color:#1f3d2a; }
  nav.stages button[data-status="failed"] .mark { color:var(--err); border-color:#41211f; }
  nav.stages button[data-status="running"] .mark, nav.stages button[data-status="awaiting-input"] .mark { color:var(--accent); border-color:#4a2c12; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:9px; padding:14px 16px; }
  .card + .card { margin-top:12px; }
  .card h2 { margin:0; font-size:15px; }
  .card h3 { margin:0 0 8px; font-size:12.5px; color:var(--dim); text-transform:uppercase; letter-spacing:.7px; }
  .row { display:flex; align-items:center; gap:9px; flex-wrap:wrap; }
  .status { font:10px ui-monospace,monospace; text-transform:uppercase; letter-spacing:.8px;
            padding:2px 8px; border-radius:999px; border:1px solid var(--line); color:var(--dim); }
  .status[data-status="completed"] { color:var(--ok); border-color:#1f3d2a; }
  .status[data-status="failed"] { color:var(--err); border-color:#41211f; }
  .status[data-status="running"], .status[data-status="awaiting-input"] { color:var(--accent); border-color:#4a2c12; }
  .desc { color:var(--dim); font-size:12px; margin-top:4px; }
  .summary { font-size:13px; margin-top:8px; }
  .error { font:11.5px/1.5 ui-monospace,monospace; color:var(--err); margin-top:8px; white-space:pre-wrap; }
  .actions { display:flex; gap:8px; margin-top:12px; align-items:flex-start; }
  .actions textarea { flex:1; min-height:36px; background:#0e1013; color:var(--fg); border:1px solid var(--line);
                      border-radius:6px; padding:6px 8px; font:12px ui-monospace,monospace; resize:vertical; }
  .chips { display:flex; flex-wrap:wrap; gap:6px; }
  .chip { background:#1b1e23; color:var(--fg); border:1px solid var(--line); border-radius:999px; padding:3px 11px;
          font:11.5px ui-monospace,monospace; cursor:pointer; }
  .chip:hover { border-color:var(--accent); }
  .hitl { margin:12px 0; padding:12px 14px; border:1px solid #4a2c12; background:#1c1509; border-radius:8px; }
  .hitl h3 { margin:0 0 6px; font-size:13px; color:var(--warn); text-transform:none; letter-spacing:0; }
  .hitl p { margin:0 0 8px; font-size:13px; }
  .hitl textarea { width:100%; min-height:64px; background:#0e1013; color:var(--fg); border:1px solid var(--line);
                   border-radius:6px; padding:8px; font:12px ui-monospace,monospace; }
  table { width:100%; border-collapse:collapse; font:12px ui-monospace,Consolas,monospace; }
  th, td { text-align:left; padding:7px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--dim); font-weight:500; text-transform:uppercase; font-size:10.5px; letter-spacing:.6px; }
  tr.err td { color:var(--err); }
  .calls tr.head { cursor:pointer; }
  .calls tr.head:hover td { background:var(--panel2); }
  .calls tr.detail > td { background:#101317; border-bottom:1px solid var(--line); padding:10px 12px; }
  .tabs-mini { display:flex; gap:6px; margin-bottom:8px; }
  .tabs-mini button { background:#1b1e23; color:var(--dim); border:1px solid var(--line); font-weight:500; font-size:11.5px; padding:4px 10px; }
  .tabs-mini button[data-active="true"] { color:var(--fg); border-color:var(--accent); }
  pre.viewer { margin:0; white-space:pre-wrap; word-break:break-word; font:12px/1.55 ui-monospace,Consolas,monospace;
               max-height:52vh; overflow:auto; }
  .split { display:grid; grid-template-columns:minmax(380px,1.05fr) minmax(420px,1fr); gap:14px; align-items:start; }
  .tree { font:12.5px ui-monospace,Consolas,monospace; max-height:calc(100vh - 300px); overflow:auto; }
  .trow { display:flex; align-items:center; gap:8px; padding:2.5px 6px; border-radius:5px; cursor:pointer; white-space:nowrap; }
  .trow:hover { background:var(--panel2); }
  .trow[data-current="true"] { background:#241a10; }
  .trow .caret { width:12px; color:var(--dim); }
  .trow .dir { color:#cbd5e1; }
  .trow .sz { margin-left:auto; color:var(--dim); font-size:11px; padding-left:10px; }
  .badge { font:9.5px ui-monospace,monospace; letter-spacing:.5px; padding:1px 5px; border-radius:4px; border:1px solid var(--line); color:var(--dim); }
  .badge.chg { color:var(--accent); border-color:#4a2c12; }
  .badge.new { color:var(--ok); border-color:#1f3d2a; }
  .tabbtn[data-active="true"] { border-color:var(--accent); color:var(--fg); }
  button.btn-active { background:var(--accent); color:#0b0c0e; }
  textarea.editor { width:100%; min-height:calc(100vh - 420px); background:#0e1013; color:var(--fg);
                    border:1px solid var(--line); border-radius:6px; padding:10px;
                    font:12.5px/1.6 ui-monospace,Consolas,monospace; resize:vertical; }
  .flow-svg { width:100%; height:auto; }
  .flow-label { fill:var(--fg); font:600 13px ui-sans-serif,-apple-system,"Segoe UI",sans-serif; }
  .flow-state { font:600 11px ui-monospace,Consolas,monospace; letter-spacing:.5px; }
  .flow-meta { fill:var(--dim); font:10.5px ui-monospace,Consolas,monospace; }
  .flow-arrow { stroke:var(--line); stroke-width:2; fill:none; }
  .flow-arrow-active { stroke:var(--accent); }
  .flow-node-current rect { filter:drop-shadow(0 0 8px rgba(249,115,22,.55)); animation:flow-pulse 1.6s ease-in-out infinite; }
  @keyframes flow-pulse { 0%,100% { opacity:1; } 50% { opacity:.65; } }
  .flow-timeline { margin-top:16px; }
  .flow-row { display:grid; grid-template-columns:120px 1fr 78px; align-items:center; gap:10px; margin:5px 0; }
  .flow-row-name { color:var(--dim); font:11px ui-monospace,Consolas,monospace; }
  .flow-row-duration { color:var(--dim); font:11px ui-monospace,Consolas,monospace; text-align:right; }
  .flow-track { position:relative; height:14px; background:#0e1013; border:1px solid var(--line); border-radius:4px; overflow:hidden; }
  .flow-bar { position:absolute; top:0; bottom:0; border-radius:3px; background:#3b3f46; }
  .flow-bar[data-status="completed"] { background:var(--ok); }
  .flow-bar[data-status="failed"] { background:var(--err); }
  .flow-bar[data-status="running"], .flow-bar[data-status="awaiting-input"] { background:var(--accent); }
  .quality-meter { width:220px; height:10px; background:#0e1013; border:1px solid var(--line); border-radius:6px; overflow:hidden; }
  .quality-meter-fill { height:100%; background:var(--accent); }
  .quality-meter-fill[data-band="high"] { background:var(--ok); }
  .quality-meter-fill[data-band="mid"] { background:var(--warn); }
  .quality-meter-fill[data-band="low"] { background:var(--err); }
  .quality-table { margin-top:10px; }
  tr[data-state="fail"] td { color:var(--err); }
  tr[data-state="unknown"] td { color:var(--dim); }
  .quality-history { display:flex; align-items:flex-end; gap:3px; height:64px; margin-top:6px; }
  .quality-history-bar { flex:0 0 12px; height:100%; display:flex; align-items:flex-end; background:#0e1013; border-radius:3px; }
  .quality-history-fill { width:100%; background:var(--accent); border-radius:3px; }
  .quality-history-fill[data-band="high"] { background:var(--ok); }
  .quality-history-fill[data-band="mid"] { background:var(--warn); }
  .quality-history-fill[data-band="low"] { background:var(--err); }
  pre.live-log { max-height:36vh; background:#0e1013; border:1px solid var(--line); border-radius:6px; padding:10px; }
  .graph-svg { width:100%; height:auto; }
  .graph-edge { stroke:#2f333a; stroke-width:1; } display:flex; flex-direction:column; gap:3px; font:12px ui-monospace,Consolas,monospace; }
  .graph-dot { stroke:#0b0c0e; stroke-width:1.5; }
  .graph-dot-changed { fill:var(--accent); }
  .graph-dot-impacted { fill:#ef4444; }
  .graph-dot-dependency { fill:#38bdf8; }
  .graph-label { fill:#c9cdd4; font:10.5px ui-monospace,Consolas,monospace; }
  .graph-list { display:flex; flex-direction:column; gap:4px; align-items:flex-start; max-height:280px; overflow:auto; }
  .graph-list .chip[data-kind="impact"] { border-color:#7f1d1d; }
  .badge.impact { color:var(--err); border-color:#41211f; }
  .facts-list { display:flex; flex-wrap:wrap; gap:6px; font:12px ui-monospace,Consolas,monospace; color:var(--fg); }
  input.editor-mini, textarea.editor-mini { width:100%; margin-top:4px; background:#0e1013; color:var(--fg);
      border:1px solid var(--line); border-radius:6px; padding:7px 9px; font:12px ui-monospace,Consolas,monospace; }
  .md { font-size:13.5px; line-height:1.65; max-height:calc(100vh - 300px); overflow:auto; }
  .md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { margin:16px 0 8px; line-height:1.3; }
  .md h1 { font-size:20px; border-bottom:1px solid var(--line); padding-bottom:6px; }
  .md h2 { font-size:17px; border-bottom:1px solid var(--line); padding-bottom:4px; }
  .md h3 { font-size:15px; }
  .md p { margin:8px 0; }
  .md ul, .md ol { margin:8px 0; padding-left:22px; }
  .md li { margin:3px 0; }
  .md code { background:#191c21; border:1px solid var(--line); border-radius:4px; padding:1px 5px;
             font:12px ui-monospace,Consolas,monospace; color:#f5d0a9; }
  .md pre.md-code { background:#0e1013; border:1px solid var(--line); border-radius:6px; padding:10px 12px; overflow:auto; }
  .md pre.md-code code { background:none; border:0; padding:0; color:#d7dae0; }
  .md blockquote { margin:10px 0; padding:6px 12px; border-left:3px solid var(--accent); background:#14161a; color:#c9cdd4; }
  .md table.md-table { width:100%; border-collapse:collapse; font-size:12.5px; margin:10px 0; }
  .md table.md-table th, .md table.md-table td { border:1px solid var(--line); padding:6px 9px; text-align:left; }
  .md table.md-table th { background:#191c21; color:var(--dim); text-transform:none; font-size:12px; }
  .md hr { border:0; border-top:1px solid var(--line); margin:14px 0; }
  .md a { color:var(--code); }
  .md .md-img { color:var(--dim); border:1px dashed var(--line); border-radius:4px; padding:1px 5px; font-size:11.5px; }
  .hint { color:var(--dim); font-size:12px; }
  .empty { color:var(--dim); font-size:12.5px; padding:8px 0; }
  .legend { display:flex; gap:12px; align-items:center; color:var(--dim); font-size:11.5px; margin-bottom:8px; }
</style>
</head>
<body>
<header>
  <pre class="banner">${BANNER}</pre>
  <p class="flow">${FLOW_TEXT}</p>
  <div class="meta">
    <span id="meta-root"></span><code id="root"></code></span>
    <span id="meta-cfg"></span><code id="cfgroot"></code></span>
    <span id="modelsummary"></span>
  </div>
  <div class="toolbar">
    <label for="model" id="model-label"></label>
    <select id="model"></select>
    <button class="ghost" id="notes-toggle"></button>
    <span class="hint" id="notes-state"></span>
    <button class="ghost" id="refresh"></button>
    <span class="hint" id="lang-label"></span>
    <button class="ghost" id="lang-zh">中文</button>
    <button class="ghost" id="lang-en">English</button>
  </div>
  <div class="notes-box" id="notes-box" hidden>
    <textarea id="notes" rows="3"></textarea>
    <div class="row" style="justify-content:flex-end; margin-top:6px;"><button id="notes-save"></button></div>
  </div>
</header>
<main>
  <nav class="stages" id="stages"></nav>
  <div id="hitl-slot"></div>
  <section id="view"></section>
</main>
<script>
const ORDER = ${PHASE_ORDER};
const LABELS = ${PHASE_LABELS};
const CATALOGS = ${LOCALE_CATALOGS};
const MARKS = { pending:"PENDING", running:"RUNNING", completed:"COMPLETED", failed:"FAILED", "awaiting-input":"AWAITING-INPUT" };
const LONG_KEYS = { pending:"status.pendingLong", running:"status.runningLong", completed:"status.completedLong", failed:"status.failedLong", "awaiting-input":"status.awaitingInputLong" };

/** Interface language: the workspace's stored choice wins over the browser's preference. */
function browserLocale() {
  const preferred = (navigator.language || "").slice(0, 2).toLowerCase();
  return CATALOGS[preferred] ? preferred : "en";
}
let locale = browserLocale();

function t(key, params) {
  const template = (CATALOGS[locale] && CATALOGS[locale][key]) || CATALOGS.en[key] || key;
  if (!params) return template;
  // Plain splitting: a regex here would need brace escapes that a template literal eats.
  let out = template;
  for (const name of Object.keys(params)) out = out.split("{" + name + "}").join(String(params[name]));
  return out;
}
const statusText = status => t(LONG_KEYS[status]);
const phaseTitle = phase => t("phase." + phase + ".title");

let state = null, models = null, tree = null, expanded = new Set(), tab = "tree", preview = null,
    events = [], eventsPhase = null, eventsSignature = "", picked = false, callCache = {}, modelCount = 0,
    openCalls = new Set(), viewSignature = "";

const el = id => document.getElementById(id);
const bytes = n => n == null ? "" : n < 1024 ? n + " B" : n < 1048576 ? (n/1024).toFixed(1) + " KB" : (n/1048576).toFixed(2) + " MB";
const status = phase => state ? state.phases[phase].status : "pending";

async function api(path, options) {
  const res = await fetch(path, options);
  const type = res.headers.get("content-type") || "";
  const body = type.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error(typeof body === "string" ? body : (body.error || "request failed"));
  return body;
}

async function loadModels() {
  const bound = await api("/api/models");
  models = bound;
  const select = el("model");
  select.textContent = "";
  const def = document.createElement("option");
  def.value = "";
  def.textContent = t("home.defaultModel") + (bound.default ? " · " + bound.default.label : "");
  select.appendChild(def);
  for (const model of bound.available || []) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.label || model.id;
    select.appendChild(option);
  }
  el("cfgroot").textContent = bound.configRoot || "-";
  modelCount = (bound.available || []).length;
  el("modelsummary").textContent = t("home.models", { count: modelCount });
}

async function refreshState() {
  state = await api("/api/state");
  const stored = state.locale && CATALOGS[state.locale] ? state.locale : null;
  if (stored && stored !== locale) { locale = stored; viewSignature = ""; eventsSignature = ""; }
  applyChrome();
  el("root").textContent = state.projectRoot;
  el("notes").value = state.notes || "";
  el("notes-state").textContent = state.notes ? t("home.notesSet", { count: state.notes.length }) : t("home.notesUnset");
  const busy = ORDER.find(p => status(p) === "running" || status(p) === "awaiting-input");
  if (!picked) {
    picked = true;
    // Land on the flow diagram: it answers "where is this project?" before any detail.
    const latest = busy || ORDER.slice().reverse().find(p => status(p) !== "pending");
    if (latest) tab = "phase:" + latest;
    else tab = "flow";
  }
  renderTabs();
  // The viewed phase owns the trail; a busy phase is refreshed every poll, a settled one only
  // when it changes or when the tab changes — otherwise the panel shows another stage's calls.
  if (tab.startsWith("phase:")) {
    const phase = tab.slice(6);
    const signature = JSON.stringify(state.phases[phase]);
    if (eventsPhase !== phase || (busy === phase && eventsSignature !== signature)) {
      eventsPhase = phase;
      eventsSignature = signature;
      try { events = await api("/api/events?phase=" + phase); } catch (err) { events = []; }
    }
    const viewKey = tab + "|" + JSON.stringify(state.phases[phase]) + "|" + events.length + "|" + eventsSignature;
    if (viewKey !== viewSignature) {
      viewSignature = viewKey;
      renderView();
    }
  } else {
    renderTabs();
  }
  renderHitl();
}

function renderTabs() {
  const nav = el("stages");
  nav.textContent = "";
  const items = [{ tab:"flow", label:t("flow.title") }, { tab:"graph", label:t("graph.tab") }, { tab:"config", label:t("config.title") }, { tab:"tree", label:t("nav.tree") }].concat(ORDER.map((p, i) => ({ tab:"phase:" + p, label:(i+1) + ". " + LABELS[p], phase:p })));
  for (const item of items) {
    const button = document.createElement("button");
    button.textContent = item.label;
    button.dataset.active = String(tab === item.tab);
    if (item.phase) {
      button.dataset.status = status(item.phase);
      const mark = document.createElement("span");
      mark.className = "mark";
      mark.textContent = MARKS[status(item.phase)];
      mark.title = statusText(status(item.phase));
      button.appendChild(mark);
    }
    button.onclick = () => { tab = item.tab; eventsPhase = null; viewSignature = ""; renderTabs(); renderView(); };
    nav.appendChild(button);
  }
}

function renderHitl() {
  const slot = el("hitl-slot");
  slot.textContent = "";
  const waiting = ORDER.find(p => status(p) === "awaiting-input");
  if (!waiting) return;
  const question = state.phases[waiting].question;
  if (!question) return;
  const box = document.createElement("div"); box.className = "hitl";
  const title = document.createElement("h3"); title.textContent = t("hitl.title", { phase: LABELS[waiting] });
  const text = document.createElement("p"); text.textContent = question.text;
  const answer = document.createElement("textarea"); answer.placeholder = t("hitl.placeholder");
  const row = document.createElement("div"); row.className = "row"; row.style.justifyContent = "flex-end";
  const send = document.createElement("button"); send.textContent = t("hitl.submit");
  send.onclick = async () => {
    send.disabled = true;
    try {
      await api("/api/answer", { method:"POST", headers:{ "content-type":"application/json" },
        body: JSON.stringify({ questionId: question.id, text: answer.value }) });
    } catch (err) { alert(err.message); }
    await refreshState();
  };
  row.appendChild(send);
  box.append(title, text, answer, row);
  slot.appendChild(box);
}

function renderView() {
  if (tab === "flow") return renderFlow();
  if (tab === "graph") return renderGraph();
  if (tab === "config") return renderConfig();
  if (tab === "tree") return renderTree();
  return renderPhase(tab.slice(6));
}

/* ---------- 阶段明细 ---------- */

function phaseArtifacts(phase) { return (state.phases[phase].artifacts || []).map(a => a.path); }
function changedFiles() {
  if (!tree) return [];
  const out = [];
  (function walk(node) {
    for (const child of node.children || []) {
      if (child.changed && !child.directory) out.push(child.path);
      walk(child);
    }
  })(tree);
  return out;
}

function renderPhase(phase) {
  const view = el("view");
  view.textContent = "";
  const run = state.phases[phase];
  const card = document.createElement("div"); card.className = "card";

  const head = document.createElement("div"); head.className = "row";
  const title = document.createElement("h2"); title.textContent = (ORDER.indexOf(phase) + 1) + ". " + LABELS[phase];
  const pill = document.createElement("span"); pill.className = "status"; pill.textContent = MARKS[run.status];
  pill.dataset.status = run.status; pill.title = statusText(run.status);
  head.append(title, pill);
  const desc = document.createElement("div"); desc.className = "desc";
  // DESC 形如 "Deploy — deployment documentation for the build"：标题已给编号与名称，去掉重复前缀。
  desc.textContent = phaseTitle(phase).split(" — ").slice(1).join(" — ") || phaseTitle(phase);
  card.append(head, desc);

  if (run.summary) { const s = document.createElement("div"); s.className = "summary"; s.textContent = run.summary; card.appendChild(s); }
  if (run.error) { const e = document.createElement("div"); e.className = "error"; e.textContent = run.error; card.appendChild(e); }

  const artifacts = phaseArtifacts(phase);
  if (artifacts.length) {
    const box = document.createElement("div"); box.style.marginTop = "12px";
    const h = document.createElement("h3"); h.textContent = t("phase.artifact");
    const chips = document.createElement("div"); chips.className = "chips";
    for (const item of artifacts) {
      const chip = document.createElement("button"); chip.className = "chip"; chip.textContent = item.split("/").pop();
      chip.title = item;
      chip.onclick = () => openPreview(item);
      chips.appendChild(chip);
    }
    box.append(h, chips);
    card.appendChild(box);
  }

  const controls = document.createElement("div"); controls.className = "actions";
  if (phase === "requirements") {
    const input = document.createElement("textarea");
    input.id = "phase-input";
    input.placeholder = t("phase.requirementsInput");
    controls.appendChild(input);
  } else {
    const spacer = document.createElement("span"); spacer.className = "hint";
    controls.appendChild(spacer);
  }
  const start = document.createElement("button");
  start.textContent = t(run.status === "pending" ? "phase.run" : "phase.rerun");
  start.onclick = async () => {
    start.disabled = true;
    const body = { phase };
    const input = el("phase-input");
    if (input && input.value.trim()) body.prompt = input.value.trim();
    if (el("model").value) body.model = el("model").value;
    try { await api("/api/run", { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(body) }); }
    catch (err) { alert(err.message); }
    start.disabled = false;
    await refreshState();
  };
  controls.appendChild(start);
  card.appendChild(controls);
  view.appendChild(card);

  // Phase-specific panels: configuration for analysis/build, measured results for test/deploy.
  const report = reports[phase];
  card.parentElement.appendChild(liveLogCard(phase));
  if (phase === "build" && report) card.parentElement.appendChild(scaffoldCard(report.scaffold));
  if (phase === "test" && report) card.parentElement.appendChild(qualityCard(report.quality ? { ...report.quality, history: report.history } : null));
  if (phase === "deploy" && report) card.parentElement.appendChild(factsCard(report.facts));
  if (["build", "test", "deploy"].includes(phase) && !report) {
    void loadReport(phase).then(() => { if (tab === "phase:" + phase) renderPhase(phase); });
  }


  if (phase === "build") renderChanged(card);
  renderCalls(card, phase);
}

function renderChanged(card) {
  const files = changedFiles();
  if (!files.length) return;
  const box = document.createElement("div"); box.className = "card";
  const h = document.createElement("h3"); h.textContent = t("phase.changedFiles");
  const chips = document.createElement("div"); chips.className = "chips";
  for (const file of files) {
    const chip = document.createElement("button"); chip.className = "chip"; chip.textContent = file;
    chip.onclick = () => openPreview(file);
    chips.appendChild(chip);
  }
  box.append(h, chips);
  card.parentElement.appendChild(box);
}

function renderCalls(card, phase) {
  const box = document.createElement("div"); box.className = "card";
  const h = document.createElement("h3"); h.textContent = t("calls.title");
  box.appendChild(h);
  const rows = events.filter(e => e.phase === phase);
  if (!rows.length) {
    const empty = document.createElement("div"); empty.className = "empty";
    empty.textContent = t("calls.empty", { phase: phaseTitle(phase) });
    box.appendChild(empty);
    card.parentElement.appendChild(box);
    return;
  }
  const table = document.createElement("table"); table.className = "calls";
  const thead = document.createElement("thead");
  thead.innerHTML = "<tr><th>" + t("calls.time") + "</th><th>" + t("calls.step") + "</th><th>" + t("calls.model") + "</th><th>" + t("calls.duration") + "</th><th>" + t("calls.tokens") + "</th><th>" + t("calls.chars") + "</th><th></th></tr>";
  const tbody = document.createElement("tbody");
  for (const record of rows.slice().reverse()) {
    const head = document.createElement("tr"); head.className = "head";
    if (record.error) head.classList.add("err");
    const cells = [
      new Date(record.at).toLocaleTimeString(),
      record.kind,
      record.model,
      (record.durationMs/1000).toFixed(1) + "s",
      record.inputTokens != null ? record.inputTokens + " / " + record.outputTokens : "-",
      record.promptChars + " → " + record.responseChars + (record.thinkingChars ? " · " + t("calls.thinkingChars", { count: record.thinkingChars }) : ""),
    ];
    for (const value of cells) { const td = document.createElement("td"); td.textContent = value; head.appendChild(td); }
    const toggleCell = document.createElement("td"); const toggle = document.createElement("button");
    toggle.className = "ghost"; toggle.textContent = t("calls.expand");
    toggleCell.appendChild(toggle); head.appendChild(toggleCell);
    tbody.appendChild(head);

    const detail = document.createElement("tr"); detail.className = "detail";
    const cell = document.createElement("td"); cell.colSpan = 7; detail.appendChild(cell);
    const key = record.phase + "|" + record.at + "|" + record.kind;
    let loaded = false;
    const paint = async () => {
      const open = openCalls.has(key);
      detail.hidden = !open;
      toggle.textContent = t(open ? "calls.collapse" : "calls.expand");
      if (!open || loaded) return;
      loaded = true;
      cell.appendChild(await callPanels(record));
    };
    toggle.onclick = () => {
      if (openCalls.has(key)) openCalls.delete(key); else openCalls.add(key);
      void paint();
    };
    tbody.appendChild(detail);
    void paint();
  }
  table.append(thead, tbody);
  box.appendChild(table);
  card.parentElement.appendChild(box);
}

async function callPanels(record) {
  const wrap = document.createElement("div");
  const bar = document.createElement("div"); bar.className = "tabs-mini";
  const body = document.createElement("div");
  const panels = [];
  const add = (label, path, note) => panels.push({ label, path, note });
  add(t(record.error ? "calls.error" : "calls.prompt"), record.promptPath);
  if (record.thinkingPath) add(t("calls.reasoning"), record.thinkingPath);
  add(t(record.error ? "calls.context" : "calls.output"), record.error ? record.promptPath : record.responsePath, record.error ? t("calls.contextNote") : null);
  let active = 0;
  async function show(index) {
    active = index;
    for (const [i, button] of [...bar.children].entries()) button.dataset.active = String(i === index);
    const panel = panels[index];
    body.textContent = "";
    if (!panel || !panel.path) { body.textContent = t("calls.noContent"); return; }
    let text = callCache[panel.path];
    if (text == null) {
      try { text = await api("/api/artifact?path=" + encodeURIComponent(panel.path)); }
      catch (err) { text = t("calls.readFailed", { error: err.message }); }
      callCache[panel.path] = text;
    }
    const hint = document.createElement("div"); hint.className = "hint"; hint.style.marginBottom = "6px";
    hint.textContent = panel.path + (panel.note ? " · " + panel.note : "");
    const pre = document.createElement("pre"); pre.className = "viewer"; pre.textContent = text;
    body.append(hint, pre);
  }
  for (const [i, panel] of panels.entries()) {
    const button = document.createElement("button"); button.textContent = panel.label;
    button.onclick = () => { void show(i); };
    bar.appendChild(button);
  }
  wrap.append(bar, body);
  if (!record.promptPath) {
    body.textContent = t("calls.legacy");
    return wrap;
  }
  void show(active);
  return wrap;
}

/* ---------- 流程视图（实时状态流转） ---------- */

const STATUS_ORDER = { pending: 0, running: 1, "awaiting-input": 2, completed: 3, failed: 4 };
const NODE_COLORS = {
  pending: "#3b3f46", running: "#f97316", "awaiting-input": "#facc15", completed: "#22c55e", failed: "#ef4444",
};

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return ms + " ms";
  if (ms < 60_000) return (ms / 1000).toFixed(1) + " s";
  const minutes = Math.floor(ms / 60_000);
  return minutes + " m " + Math.round((ms % 60_000) / 1000) + " s";
}

function phaseSpan(phase) {
  const run = state.phases[phase];
  if (!run.startedAt) return null;
  const start = Date.parse(run.startedAt);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
  return { start, end, ms: Math.max(0, end - start) };
}

function renderFlow() {
  const view = el("view");
  view.textContent = "";
  const done = ORDER.filter(p => status(p) === "completed").length;
  const blocked = ORDER.filter(p => status(p) === "failed").length;
  const active = ORDER.find(p => status(p) === "running" || status(p) === "awaiting-input");

  const summary = document.createElement("div"); summary.className = "card";
  const head = document.createElement("h3"); head.textContent = t("flow.title");
  const strip = document.createElement("div"); strip.className = "row"; strip.style.gap = "18px";
  strip.append(
    makeSpan(t("flow.summary", { done: done, total: ORDER.length, blocked: blocked })),
  );
  if (active) {
    const chip = document.createElement("span"); chip.className = "badge chg";
    chip.textContent = t("flow.current", { phase: LABELS[active] }) + " · " + statusText(status(active));
    strip.appendChild(chip);
  }
  const traveled = ORDER.map(phaseSpan).filter(Boolean);
  if (traveled.length) {
    const span = Math.max(...traveled.map(s => s.end)) - Math.min(...traveled.map(s => s.start));
    strip.appendChild(makeSpan(t("flow.elapsed", { duration: fmtDuration(span) })));
  }
  const hint = document.createElement("div"); hint.className = "hint"; hint.textContent = t("flow.hint");
  summary.append(head, strip, hint);

  const diagram = document.createElement("div"); diagram.className = "card";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 1000 168");
  svg.setAttribute("class", "flow-svg");
  const nodeWidth = 148, nodeHeight = 84, gap = 22, top = 42;
  ORDER.forEach((phase, index) => {
    const x = 16 + index * (nodeWidth + gap);
    const run = state.phases[phase];
    const current = status(phase) === "running" || status(phase) === "awaiting-input";
    if (index > 0) {
      const arrow = document.createElementNS("http://www.w3.org/2000/svg", "path");
      const from = 16 + (index - 1) * (nodeWidth + gap) + nodeWidth;
      arrow.setAttribute("d", "M " + from + " " + (top + nodeHeight / 2) + " L " + (x - 4) + " " + (top + nodeHeight / 2));
      arrow.setAttribute("class", "flow-arrow" + (STATUS_ORDER[status(phase)] >= STATUS_ORDER.running ? " flow-arrow-active" : ""));
      svg.appendChild(arrow);
    }
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.setAttribute("class", "flow-node" + (current ? " flow-node-current" : ""));
    group.style.cursor = "pointer";
    group.addEventListener("click", () => { tab = "phase:" + phase; eventsPhase = null; viewSignature = ""; renderTabs(); renderView(); });
    const box = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    box.setAttribute("x", String(x)); box.setAttribute("y", String(top));
    box.setAttribute("width", String(nodeWidth)); box.setAttribute("height", String(nodeHeight));
    box.setAttribute("rx", "10");
    box.setAttribute("fill", "#14161a");
    box.setAttribute("stroke", NODE_COLORS[status(phase)] || "#3b3f46");
    box.setAttribute("stroke-width", current ? "2.5" : "1.5");
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", String(x + 14)); label.setAttribute("y", String(top + 28));
    label.setAttribute("class", "flow-label");
    label.textContent = (index + 1) + ". " + LABELS[phase];
    const stateText = document.createElementNS("http://www.w3.org/2000/svg", "text");
    stateText.setAttribute("x", String(x + 14)); stateText.setAttribute("y", String(top + 50));
    stateText.setAttribute("class", "flow-state");
    stateText.setAttribute("fill", NODE_COLORS[status(phase)]);
    stateText.textContent = statusText(status(phase));
    const meta = document.createElementNS("http://www.w3.org/2000/svg", "text");
    meta.setAttribute("x", String(x + 14)); meta.setAttribute("y", String(top + 70));
    meta.setAttribute("class", "flow-meta");
    const span = phaseSpan(phase);
    meta.textContent = t("flow.artifacts", { count: (run.artifacts || []).length }) + (span ? " · " + fmtDuration(span.ms) : "");
    group.append(box, label, stateText, meta);
    svg.appendChild(group);
  });
  diagram.appendChild(svg);

  const timeline = document.createElement("div"); timeline.className = "flow-timeline";
  const first = Math.min(...ORDER.map(p => phaseSpan(p)?.start ?? Number.POSITIVE_INFINITY));
  const last = Math.max(...ORDER.map(p => phaseSpan(p)?.end ?? 0));
  const total = Number.isFinite(first) && last > first ? last - first : 0;
  const heading = document.createElement("h3"); heading.textContent = t("flow.timeline");
  timeline.appendChild(heading);
  for (const phase of ORDER) {
    const span = phaseSpan(phase);
    const row = document.createElement("div"); row.className = "flow-row";
    const name = document.createElement("span"); name.className = "flow-row-name"; name.textContent = LABELS[phase];
    const track = document.createElement("div"); track.className = "flow-track";
    const bar = document.createElement("div"); bar.className = "flow-bar";
    bar.dataset.status = status(phase);
    if (span && total > 0) {
      bar.style.left = ((span.start - first) / total) * 100 + "%";
      bar.style.width = Math.max(1.2, (span.ms / total) * 100) + "%";
    } else {
      bar.style.left = "0%"; bar.style.width = "0%";
    }
    bar.title = span ? fmtDuration(span.ms) : t("flow.notStarted");
    track.appendChild(bar);
    const duration = document.createElement("span"); duration.className = "flow-row-duration";
    duration.textContent = span ? fmtDuration(span.ms) : "—";
    row.append(name, track, duration);
    timeline.appendChild(row);
  }
  diagram.appendChild(timeline);

  view.append(summary, diagram);
}

/* ---------- 阶段配置、质量报告、部署事实 ---------- */

const reports = {};
async function loadReport(phase) {
  const signature = JSON.stringify(state.phases[phase]);
  if (reports[phase] && reports[phase].signature === signature) return reports[phase];
  let payload = {};
  try { payload = await api("/api/report?phase=" + phase); } catch (err) { payload = {}; }
  reports[phase] = { signature, ...payload };
  return reports[phase];
}

function qualityCard(report) {
  const box = document.createElement("div"); box.className = "card";
  const title = document.createElement("h3"); title.textContent = t("quality.title");
  box.appendChild(title);
  if (!report) {
    box.appendChild(Object.assign(document.createElement("div"), { className: "empty", textContent: t("quality.empty") }));
    return box;
  }
  const scoreRow = document.createElement("div"); scoreRow.className = "row"; scoreRow.style.gap = "12px";
  const score = makeSpan(t("quality.score", { score: report.score }));
  score.style.fontWeight = "600";
  const meter = document.createElement("div"); meter.className = "quality-meter";
  const fill = document.createElement("div"); fill.className = "quality-meter-fill";
  fill.style.width = Math.max(2, Math.min(100, report.score)) + "%";
  fill.dataset.band = report.score >= 85 ? "high" : report.score >= 60 ? "mid" : "low";
  meter.appendChild(fill);
  scoreRow.append(score, meter);
  const weights = document.createElement("span"); weights.className = "hint";
  weights.textContent = t("quality.weights", {
    weights: Object.entries(report.weights || {}).map(([name, weight]) => name + " " + weight).join(", ") || "—",
  });
  scoreRow.appendChild(weights);
  box.appendChild(scoreRow);

  const table = document.createElement("table"); table.className = "quality-table";
  const head = document.createElement("thead");
  head.innerHTML = "<tr><th>" + t("quality.signal") + "</th><th>" + t("quality.result") + "</th><th>" +
    t("calls.duration") + "</th><th>" + t("quality.counts", { passed: "…", failed: "…" }).replace(/^[^:：]*[:：]\\s*/, "") + "</th></tr>";
  const body = document.createElement("tbody");
  for (const signal of report.signals || []) {
    const row = document.createElement("tr");
    const state = signal.exitCode === null ? "unknown" : signal.exitCode === 0 ? "pass" : "fail";
    const cells = [
      signal.name,
      state === "unknown" ? t("quality.notMeasured") : state === "pass" ? t("quality.passed") : t("quality.failed") + " (" + signal.exitCode + ")",
      signal.exitCode === null ? "—" : fmtDuration(signal.durationMs),
      [
        signal.passed !== undefined ? t("quality.counts", { passed: signal.passed, failed: signal.failed || 0 }) : null,
        signal.percent !== undefined ? t("quality.coverage", { percent: signal.percent }) : null,
        signal.note || null,
      ].filter(Boolean).join("; ") || "—",
    ];
    cells.forEach(value => { const cell = document.createElement("td"); cell.textContent = value; row.appendChild(cell); });
    row.dataset.state = state;
    body.appendChild(row);
  }
  table.append(head, body);
  box.appendChild(table);

  const history = report.history || [];
  if (history.length) {
    const heading = document.createElement("h3"); heading.textContent = t("quality.history", { count: history.length });
    heading.style.marginTop = "14px";
    const chart = document.createElement("div"); chart.className = "quality-history";
    for (const entry of history) {
      const bar = document.createElement("div"); bar.className = "quality-history-bar";
      const value = document.createElement("div"); value.className = "quality-history-fill";
      value.style.height = Math.max(4, Math.min(100, entry.score)) + "%";
      value.dataset.band = entry.score >= 85 ? "high" : entry.score >= 60 ? "mid" : "low";
      value.title = new Date(entry.at).toLocaleString() + " · " + entry.score + "/100";
      bar.appendChild(value);
      chart.appendChild(bar);
    }
    box.append(heading, chart);
  }
  return box;
}

function factsCard(facts) {
  const box = document.createElement("div"); box.className = "card";
  const title = document.createElement("h3"); title.textContent = t("facts.title");
  box.appendChild(title);
  if (!facts) {
    box.appendChild(Object.assign(document.createElement("div"), { className: "empty", textContent: t("facts.empty") }));
    return box;
  }
  const section = (heading, values) => {
    if (!values.length) return;
    const h = document.createElement("h3"); h.textContent = heading; h.style.marginTop = "12px";
    const list = document.createElement("div"); list.className = "facts-list";
    for (const value of values) {
      if (typeof value === "object" && value.path) {
        const chip = document.createElement("button"); chip.className = "chip";
        chip.textContent = value.kind ? value.path + " · " + value.kind : value.path;
        chip.title = value.bytes + " bytes";
        chip.onclick = () => openPreview(value.path);
        list.appendChild(chip);
      } else {
        list.appendChild(makeSpan(String(value)));
      }
    }
    box.append(h, list);
  };
  section(t("facts.configs"), facts.configs || []);
  section(t("facts.scripts"), Object.entries(facts.scripts || {}).map(([name, script]) => name + " — " + script));
  section(t("facts.entrypoints"), facts.entrypoints || []);
  section(t("facts.env"), facts.envVars || []);
  section(t("facts.ports"), facts.ports || []);
  section(t("facts.evidence"), (facts.evidence || []).map(path => ({ path })));
  return box;
}

function scaffoldCard(scaffold) {
  const box = document.createElement("div"); box.className = "card";
  const title = document.createElement("h3"); title.textContent = t("scaffold.title");
  box.appendChild(title);
  if (!scaffold) {
    box.appendChild(Object.assign(document.createElement("div"), { className: "empty", textContent: t("scaffold.none") }));
    return box;
  }
  const lines = [
    scaffold.template ? t("scaffold.templateLabel") + ": " + scaffold.template : null,
    scaffold.command ? t("scaffold.commandLabel") + ": " + scaffold.command : null,
    scaffold.exitCode !== null && scaffold.exitCode !== 0 ? "exit " + scaffold.exitCode : null,
    t("scaffold.created", { count: (scaffold.created || []).length }),
  ].filter(Boolean);
  const list = document.createElement("div"); list.className = "scaffold-lines";
  for (const line of lines) list.appendChild(makeSpan(line));
  box.appendChild(list);
  const chips = document.createElement("div"); chips.className = "chips"; chips.style.marginTop = "8px";
  for (const file of (scaffold.created || []).slice(0, 30)) {
    const chip = document.createElement("button"); chip.className = "chip"; chip.textContent = file;
    chip.onclick = () => openPreview(file);
    chips.appendChild(chip);
  }
  box.appendChild(chips);
  return box;
}

/* ---------- 配置页：每个步骤的文档与命令集中一处 ---------- */

/** Which fields each phase actually honours; the form only shows what has an effect. */
const PHASE_FIELDS = {
  requirements: { sources: true, prompt: true, command: false,
    sourcesLabel: "config.reqSources", sourcesHelp: "config.reqSourcesHelp", promptLabel: "config.reqPrompt" },
  analysis: { sources: true, prompt: true, command: false,
    sourcesLabel: "config.specsTitle", sourcesHelp: "config.specsHelp", promptLabel: "config.extraPrompt" },
  build: { sources: true, prompt: true, command: true,
    sourcesLabel: "config.buildSources", sourcesHelp: "config.buildSourcesHelp",
    promptLabel: "config.buildPrompt", commandLabel: "config.scaffoldCommand" },
  test: { sources: false, prompt: true, command: true,
    promptLabel: "config.extraPrompt", commandLabel: "config.testCommand" },
  deploy: { sources: false, prompt: true, command: false, promptLabel: "config.extraPrompt" },
  release: { sources: false, prompt: true, command: false, promptLabel: "config.extraPrompt" },
};

function renderConfig() {
  const view = el("view");
  view.textContent = "";

  const global = document.createElement("div"); global.className = "card";
  const globalTitle = document.createElement("h3"); globalTitle.textContent = t("config.global");
  const notesLabel = document.createElement("div"); notesLabel.className = "hint"; notesLabel.textContent = t("config.notesHelp");
  const notes = document.createElement("textarea"); notes.id = "config-notes"; notes.rows = 3; notes.className = "editor-mini";
  notes.value = state.notes || "";
  const globalRow = document.createElement("div"); globalRow.className = "row"; globalRow.style.marginTop = "8px";
  const saveGlobal = document.createElement("button"); saveGlobal.textContent = t("home.save");
  const globalNote = document.createElement("span"); globalNote.className = "hint";
  saveGlobal.onclick = async () => {
    saveGlobal.disabled = true;
    try {
      await api("/api/notes", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ notes: el("config-notes").value }) });
      globalNote.textContent = t("config.saved");
      await refreshState();
    } catch (err) { alert(err.message); }
    saveGlobal.disabled = false;
  };
  globalRow.append(saveGlobal, globalNote);
  global.append(globalTitle, notesLabel, notes, globalRow);
  view.appendChild(global);

  ORDER.forEach((phase, index) => {
    const fields = PHASE_FIELDS[phase];
    const config = (state.config || {})[phase] || { sources: [], prompt: "", command: "" };
    const card = document.createElement("div"); card.className = "card";
    const head = document.createElement("div"); head.className = "row";
    const title = document.createElement("h3"); title.textContent = (index + 1) + ". " + LABELS[phase];
    const pill = document.createElement("span"); pill.className = "status";
    pill.textContent = MARKS[status(phase)]; pill.dataset.status = status(phase);
    head.append(title, pill);
    const desc = document.createElement("div"); desc.className = "hint";
    desc.textContent = phaseTitle(phase).split(" — ").slice(1).join(" — ") || phaseTitle(phase);
    card.append(head, desc);

    const adds = [];
    if (fields.sources) {
      const label = document.createElement("div"); label.className = "field-label"; label.textContent = t(fields.sourcesLabel);
      const help = document.createElement("div"); help.className = "hint"; help.textContent = t(fields.sourcesHelp);
      const sources = document.createElement("textarea");
      sources.className = "editor-mini"; sources.rows = 3; sources.dataset.field = "sources";
      sources.dataset.phase = phase;
      sources.value = (config.sources || []).join("\\n");
      card.append(label, help, sources);
      adds.push("sources");
    } else {
      const note = document.createElement("div"); note.className = "hint"; note.textContent = t("config.noSources");
      card.appendChild(note);
    }
    if (fields.prompt) {
      const label = document.createElement("div"); label.className = "field-label"; label.textContent = t(fields.promptLabel);
      const prompt = document.createElement("textarea");
      prompt.className = "editor-mini"; prompt.rows = 2; prompt.dataset.field = "prompt"; prompt.dataset.phase = phase;
      prompt.value = config.prompt || "";
      card.append(label, prompt);
      adds.push("prompt");
    }
    if (fields.command) {
      const label = document.createElement("div"); label.className = "field-label"; label.textContent = t(fields.commandLabel);
      const command = document.createElement("input");
      command.className = "editor-mini"; command.dataset.field = "command"; command.dataset.phase = phase;
      command.value = config.command || "";
      card.append(label, command);
      adds.push("command");
    }

    const row = document.createElement("div"); row.className = "row"; row.style.marginTop = "10px";
    const save = document.createElement("button"); save.textContent = t("home.save");
    const note = document.createElement("span"); note.className = "hint";
    save.onclick = async () => {
      save.disabled = true;
      const body = { phase };
      for (const field of adds) {
        const node = card.querySelector('[data-field="' + field + '"]');
        body[field] = field === "sources"
          ? node.value.split("\\n").map(line => line.trim()).filter(Boolean)
          : node.value;
      }
      try {
        await api("/api/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        note.textContent = t("config.saved");
        reports[phase] = undefined;
        await refreshState();
      } catch (err) { alert(err.message); }
      save.disabled = false;
    };
    row.append(save, note);
    card.appendChild(row);
    view.appendChild(card);
  });
}

/* ---------- 实时运行细节 ---------- */

/** Poll the phase's run log while it runs; show the tail with an elapsed clock. */
function liveLogCard(phase) {
  const run = state.phases[phase];
  const box = document.createElement("div"); box.className = "card";
  const head = document.createElement("div"); head.className = "row";
  const title = document.createElement("h3"); title.textContent = t("live.title");
  const badge = document.createElement("span"); badge.className = "badge";
  badge.textContent = statusText(run.status);
  head.append(title, badge);
  const meta = document.createElement("div"); meta.className = "hint";
  meta.textContent = t("live.hint");
  const pre = document.createElement("pre"); pre.className = "viewer live-log"; pre.id = "live-log";
  pre.textContent = t("live.loading");
  const actions = document.createElement("div"); actions.className = "row"; actions.style.marginTop = "8px";
  const follow = document.createElement("label"); follow.className = "hint";
  const followBox = document.createElement("input"); followBox.type = "checkbox"; followBox.checked = true;
  follow.append(followBox, makeSpan(" " + t("live.follow")));
  const refresh = document.createElement("button"); refresh.className = "ghost"; refresh.textContent = t("home.refresh");
  refresh.onclick = () => void refreshLog(phase, pre, meta, badge, followBox);
  actions.append(follow, refresh);
  box.append(head, meta, pre, actions);

  liveTail.set(phase, { pre: pre, meta: meta, badge: badge, follow: followBox });
  void refreshLog(phase, pre, meta, badge, followBox);
  return box;
}

/** Phase → its live log nodes, so the poll can update the visible one without a re-render. */
const liveTail = new Map();

async function refreshLog(phase, pre, meta, badge, followBox) {
  try {
    const payload = await api("/api/log?phase=" + phase);
    badge.textContent = statusText(payload.status);
    meta.textContent = t("live.elapsed", { duration: fmtDuration(payload.elapsedMs) }) +
      (payload.truncated ? " · " + t("live.truncated") : "") +
      (payload.status === "running" || payload.status === "awaiting-input" ? " · " + t("live.streaming") : "");
    pre.textContent = payload.text || t("live.empty");
    if (followBox && followBox.checked) pre.scrollTop = pre.scrollHeight;
  } catch (err) {
    meta.textContent = String(err.message || err);
  }
}

/* ---------- 代码图与变更影响 ---------- */

function renderGraph() {
  const view = el("view");
  view.textContent = "";
  const report = reports.build;
  if (!report) {
    const card = document.createElement("div"); card.className = "card";
    card.appendChild(Object.assign(document.createElement("div"), { className: "empty", textContent: t("graph.empty") }));
    view.appendChild(card);
    if (reports.build === undefined) void loadReport("build").then(() => { if (tab === "graph") renderGraph(); });
    return;
  }
  const graph = report.graph;
  if (!graph) {
    const card = document.createElement("div"); card.className = "card";
    card.appendChild(Object.assign(document.createElement("div"), { className: "empty", textContent: t("graph.none") }));
    view.appendChild(card);
    return;
  }

  const summary = document.createElement("div"); summary.className = "card";
  const head = document.createElement("h3"); head.textContent = t("graph.title");
  const strip = document.createElement("div"); strip.className = "row"; strip.style.gap = "16px";
  strip.append(
    makeBadge(t("graph.changedCount", { count: graph.changed.length }), "chg"),
    makeBadge(t("graph.impactedCount", { count: Object.keys(graph.impacted).length }), "impact"),
    makeBadge(t("graph.dependencyCount", { count: Object.keys(graph.dependencies).length })),
    makeSpan(t("graph.scanned", { count: graph.filesScanned }) + (graph.truncated ? " · " + t("graph.capped") : "")),
  );
  const hint = document.createElement("div"); hint.className = "hint"; hint.textContent = t("graph.hint");
  summary.append(head, strip, hint);
  view.appendChild(summary);

  const layout = document.createElement("div"); layout.className = "card";
  layout.appendChild(renderGraphSvg(graph));
  view.appendChild(layout);

  const lists = document.createElement("div"); lists.className = "split";
  lists.append(
    fileListCard(t("graph.impactList"), Object.entries(graph.impacted), "impact"),
    fileListCard(t("graph.dependencyList"), Object.entries(graph.dependencies), "dep"),
  );
  view.appendChild(lists);
  if (graph.external?.length) {
    const external = document.createElement("div"); external.className = "card";
    const title = document.createElement("h3"); title.textContent = t("graph.external");
    const chips = document.createElement("div"); chips.className = "chips";
    for (const name of graph.external.slice(0, 60)) chips.appendChild(makeSpan(name));
    external.append(title, chips);
    view.appendChild(external);
  }
}

function fileListCard(title, entries, kind) {
  const card = document.createElement("div"); card.className = "card";
  const heading = document.createElement("h3"); heading.textContent = title;
  card.appendChild(heading);
  if (!entries.length) {
    card.appendChild(Object.assign(document.createElement("div"), { className: "empty", textContent: t("graph.noneInDirection") }));
    return card;
  }
  const list = document.createElement("div"); list.className = "graph-list";
  for (const [file, depth] of entries.slice(0, 80)) {
    const row = document.createElement("button"); row.className = "chip"; row.dataset.kind = kind;
    row.textContent = file + " · " + t("graph.depth", { depth: depth });
    row.onclick = () => openPreview(file);
    list.appendChild(row);
  }
  card.appendChild(list);
  return card;
}

/** Radial impact layout: changed files in the middle, dependents by depth around them. */
function renderGraphSvg(graph) {
  const width = 1000, height = 460, cx = width / 2, cy = height / 2;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 " + width + " " + height);
  svg.setAttribute("class", "graph-svg");
  const changed = graph.changed.slice(0, 10);
  const impacted = Object.entries(graph.impacted).slice(0, 40);
  const positions = new Map();

  changed.forEach((file, index) => {
    const angle = (index / Math.max(1, changed.length)) * Math.PI * 2 - Math.PI / 2;
    const radius = changed.length === 1 ? 0 : 62;
    positions.set(file, { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius, kind: "changed" });
  });
  // Dependencies get their own ring, so both directions of the change are visible at once.
  const dependencyFiles = Object.entries(graph.dependencies ?? {}).slice(0, 24);
  dependencyFiles.forEach(([file, depth], index) => {
    if (positions.has(file)) return;
    const angle = (index / Math.max(1, dependencyFiles.length)) * Math.PI * 2 + Math.PI / 2 + depth * 0.2;
    const radius = 118 + (depth - 1) * 60;
    positions.set(file, { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius, kind: "dependency" });
  });
  const byDepth = new Map();
  for (const [file, depth] of impacted) {
    const bucket = byDepth.get(depth) ?? [];
    bucket.push(file);
    byDepth.set(depth, bucket);
  }
  for (const [depth, files] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
    const radius = 130 + (depth - 1) * 92;
    files.forEach((file, index) => {
      const angle = (index / Math.max(1, files.length)) * Math.PI * 2 - Math.PI / 2 + depth * 0.35;
      positions.set(file, { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius, kind: "impacted" });
    });
  }

  // Edges first so nodes sit on top.
  const drawn = new Set();
  for (const [file, position] of positions) {
    const node = graph.nodes.find(entry => entry.path === file);
    if (!node) continue;
    for (const target of node.imports) {
      const to = positions.get(target);
      if (!to) continue;
      const key = file + "→" + target;
      if (drawn.has(key)) continue;
      drawn.add(key);
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", position.x); line.setAttribute("y1", position.y);
      line.setAttribute("x2", to.x); line.setAttribute("y2", to.y);
      line.setAttribute("class", "graph-edge");
      svg.appendChild(line);
    }
  }

  for (const [file, position] of positions) {
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.setAttribute("class", "graph-node");
    group.style.cursor = "pointer";
    group.addEventListener("click", () => openPreview(file));
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", position.x); circle.setAttribute("cy", position.y);
    circle.setAttribute("r", position.kind === "changed" ? "9" : "5.5");
    circle.setAttribute("class", "graph-dot graph-dot-" + position.kind);
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", position.x + 11); label.setAttribute("y", position.y + 4);
    label.setAttribute("class", "graph-label");
    label.textContent = file.split("/").pop();
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = file + (position.kind === "changed" ? " — " + t("graph.changedTag") : "");
    group.append(circle, label, title);
    svg.appendChild(group);
  }
  return svg;
}

/* ---------- 产物树 ---------- */

function makeSpan(text) { const span = document.createElement("span"); span.textContent = text; return span; }
function makeBadge(text, kind) { const badge = document.createElement("span"); badge.className = "badge" + (kind ? " " + kind : ""); badge.textContent = text; return badge; }

function seedExpanded() {
  expanded = new Set();
  (function walk(node, depth) {
    for (const child of node.children || []) {
      if (!child.directory) continue;
      if (child.changed || child.artifact || depth === 0) expanded.add(child.path);
      walk(child, depth + 1);
    }
  })(tree, 0);
}

/* ---------- Markdown 渲染（自带实现：无 CDN、无第三方代码；先转义再转换） ---------- */

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function mdInline(text) {
  let out = escapeHtml(text);
  out = out.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  out = out.replace(/!\\[([^\\]]*)\\]\\(([^)\\s]+)[^)]*\\)/g, '<span class=md-img>［图］$1</span>');
  out = out.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)[^)]*\\)/g, function (match, label, href) {
    const safe = /^(https?:|mailto:|#|\\/|\\.)/i.test(href) ? href : '#';
    return '<a href="' + safe + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
  });
  out = out.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\\*([^*\\n]+)\\*/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return out;
}

function mdCells(line) {
  return line.trim().replace(/^\\|/, '').replace(/\\|$/, '').split('|').map(function (cell) { return cell.trim(); });
}

function mdTable(head, rows) {
  let html = '<table class=md-table><thead><tr>';
  for (const cell of head) html += '<th>' + mdInline(cell) + '</th>';
  html += '</tr></thead><tbody>';
  for (const row of rows) {
    html += '<tr>';
    for (let i = 0; i < head.length; i++) html += '<td>' + mdInline(row[i] || '') + '</td>';
    html += '</tr>';
  }
  return html + '</tbody></table>';
}

function renderMarkdown(source) {
  const lines = source.replace(/\\r\\n?/g, '\\n').split('\\n');
  const html = [];
  const stack = [];
  const closeLists = function (depth) {
    while (stack.length > depth) {
      html.push(stack.pop() === 'ol' ? '</ol>' : '</ul>');
      if (stack.length > 0) html.push('</li>');
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\\s*\`\`\`/.test(line)) {
      closeLists(0);
      const body = [];
      i++;
      while (i < lines.length && !/^\\s*\`\`\`/.test(lines[i])) body.push(lines[i++]);
      i++;
      html.push('<pre class=md-code><code>' + escapeHtml(body.join('\\n')) + '</code></pre>');
      continue;
    }
    if (/^\\s*$/.test(line)) { closeLists(0); i++; continue; }
    const heading = /^(#{1,6})\\s+(.*)$/.exec(line);
    if (heading) {
      closeLists(0);
      const level = heading[1].length;
      html.push('<h' + level + '>' + mdInline(heading[2].trim()) + '</h' + level + '>');
      i++;
      continue;
    }
    if (/^\\s*([-*_])\\1{2,}\\s*$/.test(line)) { closeLists(0); html.push('<hr>'); i++; continue; }
    if (/^\\s*\\|/.test(line) && i + 1 < lines.length && /^\\s*\\|[\\s:|-]+\\|\\s*$/.test(lines[i + 1])) {
      closeLists(0);
      const head = mdCells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\\s*\\|/.test(lines[i])) rows.push(mdCells(lines[i++]));
      html.push(mdTable(head, rows));
      continue;
    }
    if (/^\\s*>/.test(line)) {
      closeLists(0);
      const body = [];
      while (i < lines.length && /^\\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\\s*>\\s?/, ''));
      html.push('<blockquote>' + renderMarkdown(body.join('\\n')) + '</blockquote>');
      continue;
    }
    const item = /^(\\s*)([-*+]|\\d+[.)])\\s+(.*)$/.exec(line);
    if (item) {
      const depth = Math.floor(item[1].replace(/\\t/g, '  ').length / 2) + 1;
      const kind = /\\d/.test(item[2]) ? 'ol' : 'ul';
      while (stack.length > depth) {
        html.push(stack.pop() === 'ol' ? '</ol>' : '</ul>');
        if (stack.length > 0) html.push('</li>');
      }
      if (stack.length < depth) {
        if (html.length && html[html.length - 1].endsWith('</li>')) html[html.length - 1] = html[html.length - 1].slice(0, -5);
        html.push(kind === 'ol' ? '<ol>' : '<ul>');
        stack.push(kind);
      } else if (stack[stack.length - 1] !== kind) {
        html.push(stack.pop() === 'ol' ? '</ol>' : '</ul>');
        html.push(kind === 'ol' ? '<ol>' : '<ul>');
        stack.push(kind);
      }
      html.push('<li>' + mdInline(item[3].replace(/^\\[( |x|X)\\]\\s+/, function (m, box) { return box === ' ' ? '☐ ' : '☑ '; })) + '</li>');
      i++;
      continue;
    }
    closeLists(0);
    const para = [];
    while (i < lines.length && !/^\\s*$/.test(lines[i]) &&
           !/^\\s*(\`\`\`|#{1,6}\\s|>|\\||([-*+]|\\d+[.)])\\s)/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) { i++; continue; }
    html.push('<p>' + mdInline(para.join(' ')) + '</p>');
  }
  closeLists(0);
  return html.join('\\n');
}

function isMarkdown(path) { return /\\.(md|markdown|mdx)$/i.test(path); }

function renderTree() {
  const view = el("view");
  view.textContent = "";
  const split = document.createElement("div"); split.className = "split";
  const left = document.createElement("div"); left.className = "card";
  const legend = document.createElement("div"); legend.className = "legend";
  const changed = changedFiles().length;
  legend.append(makeSpan(t("tree.title")), makeBadge(t("tree.changed", { count: changed }), "chg"), makeBadge(t("tree.artifact")));
  const tools = document.createElement("div"); tools.className = "row"; tools.style.marginBottom = "8px";
  const expandAll = document.createElement("button"); expandAll.className = "ghost"; expandAll.textContent = t("tree.expandAll");
  const collapseAll = document.createElement("button"); collapseAll.className = "ghost"; collapseAll.textContent = t("tree.collapseAll");
  expandAll.onclick = () => { expandAllDirs(tree); renderTree(); };
  collapseAll.onclick = () => { expanded = new Set(); renderTree(); };
  tools.append(expandAll, collapseAll);
  const host = document.createElement("div"); host.className = "tree";
  host.appendChild(treeRows(tree, 0));
  left.append(legend, tools, host);

  const right = document.createElement("div"); right.className = "card";
  const head = document.createElement("h3"); head.textContent = t("tree.preview"); head.style.textTransform = "none"; head.style.letterSpacing = "0";
  const meta = document.createElement("div"); meta.className = "hint"; meta.style.marginBottom = "8px";
  const viewTools = document.createElement("div"); viewTools.className = "row"; viewTools.style.marginBottom = "8px";
  const body = document.createElement("div");
  if (preview) {
    const markdown = isMarkdown(preview.path);
    const plain = markdown ? "rendered" : "source";
    const mode = preview.mode || plain;
    if (markdown && mode !== "edit") {
      for (const option of [["rendered", "home.rendered"], ["source", "home.source"]]) {
        const button = document.createElement("button");
        button.className = "ghost tabbtn"; button.textContent = t(option[1]);
        button.dataset.active = String(mode === option[0]);
        button.title = option[0] === "rendered" ? "渲染后的排版视图" : "原始 Markdown 文本";
        button.onclick = () => { preview.mode = option[0]; preview.dirty = false; renderTree(); };
        viewTools.appendChild(button);
      }
    }
    if (mode === "edit") {
      const save = document.createElement("button"); save.textContent = t("home.save");
      const cancel = document.createElement("button"); cancel.className = "ghost"; cancel.textContent = t("home.cancel");
      cancel.onclick = () => { preview.mode = plain; preview.dirty = false; renderTree(); };
      save.onclick = async () => {
        const text = el("editor").value;
        save.disabled = true;
        try {
          const written = await api("/api/file", { method: "PUT", headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: preview.path, text: text }) });
          preview.text = text; preview.bytes = written.bytes; preview.dirty = false; preview.mode = plain;
          callCache = {};
          await loadTree();
          renderTree();
          return;
        } catch (err) { alert(err.message); }
        save.disabled = false;
      };
      viewTools.append(save, cancel);
    } else {
      const edit = document.createElement("button"); edit.className = "ghost"; edit.textContent = t("home.edit");
      edit.onclick = () => { preview.mode = "edit"; preview.dirty = false; renderTree(); };
      viewTools.appendChild(edit);
    }
    meta.textContent = preview.path + " · " + bytes(preview.bytes) + (preview.dirty ? " · " + t("home.unsaved") : "") +
      (mode === "rendered" ? " · " + t("home.renderedView") : mode === "edit" ? " · " + t("home.editing") : "");
    if (mode === "edit") {
      const editor = document.createElement("textarea");
      editor.id = "editor"; editor.className = "editor"; editor.spellcheck = false;
      editor.value = preview.text;
      editor.oninput = () => { preview.dirty = true; meta.textContent = preview.path + " · " + t("home.editing") + " · " + t("home.unsaved"); };
      body.appendChild(editor);
    } else if (mode === "rendered") {
      const md = document.createElement("div"); md.className = "md";
      // renderMarkdown escapes first, so model-written HTML cannot become markup.
      md.innerHTML = renderMarkdown(preview.text);
      body.appendChild(md);
    } else {
      const pre = document.createElement("pre"); pre.className = "viewer"; pre.textContent = preview.text;
      body.appendChild(pre);
    }
  } else {
    meta.textContent = t("tree.legend");
  }
  right.append(head, viewTools, meta, body);
  split.append(left, right);
  view.appendChild(split);
}

function expandAllDirs(node) {
  for (const child of node.children || []) {
    if (!child.directory) continue;
    expanded.add(child.path);
    expandAllDirs(child);
  }
}

function treeRows(node, depth) {
  const frag = document.createDocumentFragment();
  for (const child of node.children || []) {
    const row = document.createElement("div"); row.className = "trow";
    row.style.paddingLeft = (6 + depth * 14) + "px";
    if (preview && preview.path === child.path) row.dataset.current = "true";
    const caret = document.createElement("span"); caret.className = "caret";
    caret.textContent = child.directory ? (expanded.has(child.path) ? "▾" : "▸") : "";
    const name = document.createElement("span"); name.textContent = child.name;
    if (child.directory) name.className = "dir";
    row.title = child.path || child.name;
    row.append(caret, name);
    if (child.changed) { const badge = document.createElement("span"); badge.className = "badge chg"; badge.textContent = t("tree.changedBadge"); row.appendChild(badge); }
    if (child.artifact) { const badge = document.createElement("span"); badge.className = "badge"; badge.textContent = t("tree.artifact"); row.appendChild(badge); }
    if (child.truncated) { const badge = document.createElement("span"); badge.className = "badge"; badge.textContent = t("tree.truncated"); row.appendChild(badge); }
    if (!child.directory) { const size = document.createElement("span"); size.className = "sz"; size.textContent = bytes(child.bytes); row.appendChild(size); }
    row.onclick = () => {
      if (child.directory) {
        if (expanded.has(child.path)) expanded.delete(child.path); else expanded.add(child.path);
        renderTree();
      } else {
        void openPreview(child.path);
      }
    };
    frag.appendChild(row);
    if (child.directory && expanded.has(child.path)) frag.appendChild(treeRows(child, depth + 1));
  }
  return frag;
}

async function openPreview(path) {
  if (preview && preview.dirty && !confirm(t("guard.unsavedSwitch"))) return;
  try {
    const text = await api("/api/artifact?path=" + encodeURIComponent(path));
    const stat = findNode(tree, path);
    preview = { path, text, bytes: stat ? stat.bytes : text.length, mode: isMarkdown(path) ? "rendered" : "source", dirty: false };
  } catch (err) {
    preview = { path, text: String(err.message || err), bytes: 0, mode: "source", dirty: false };
  }
  for (const segment of ancestors(path)) expanded.add(segment);
  tab = "tree";
  renderTabs();
  renderTree();
}

function ancestors(path) {
  const parts = path.split("/");
  const out = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

function findNode(node, path) {
  for (const child of node.children || []) {
    if (child.path === path) return child;
    const hit = findNode(child, path);
    if (hit) return hit;
  }
  return null;
}

el("refresh").onclick = () => { void loadTree().then(() => refreshState()); };
el("notes-toggle").onclick = () => { el("notes-box").hidden = !el("notes-box").hidden; };
el("notes-save").onclick = async () => {
  try {
    await api("/api/notes", { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify({ notes: el("notes").value }) });
  } catch (err) { alert(err.message); }
  await refreshState();
};

/** Apply the static chrome labels for the active language. */
function applyChrome() {
  el("meta-root").textContent = t("home.projectDir") + t("home.labelSeparator");
  el("meta-cfg").textContent = t("home.configRoot") + t("home.labelSeparator");
  el("model-label").textContent = t("home.model");
  el("notes-toggle").textContent = t("home.notes");
  el("notes").placeholder = t("home.notes") + " (injected into every stage prompt)";
  el("notes-save").textContent = t("home.save");
  el("refresh").textContent = t("home.refresh");
  el("lang-label").textContent = t("home.language") + t("home.labelSeparator");
  if (modelCount) el("modelsummary").textContent = t("home.models", { count: modelCount });
  for (const code of ["zh", "en"]) {
    const button = el("lang-" + code);
    button.className = locale === code ? "btn-active" : "ghost";
    button.onclick = async () => {
      try {
        await api("/api/locale", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ locale: code }) });
      } catch (err) { alert(err.message); }
      locale = code;
      viewSignature = ""; eventsSignature = "";
      await refreshState();
      renderView();
    };
  }
}

async function loadTree() { try { tree = await api("/api/tree"); if (!picked || !expanded.size) seedExpanded(); } catch (err) { tree = null; } }

applyChrome();
void refreshState().then(loadTree).then(() => { renderTabs(); renderView(); });
void loadModels();
setInterval(async () => {
  const before = ORDER.map(status).join(",");
  await refreshState();
  if (ORDER.map(status).join(",") !== before) { await loadTree(); renderView(); }
  // The visible log keeps streaming between state changes: poll it on its own cadence.
  const phase = tab.startsWith("phase:") ? tab.slice(6) : null;
  const tail = phase ? liveTail.get(phase) : null;
  if (tail && tail.pre.isConnected) {
    await refreshLog(phase, tail.pre, tail.meta, tail.badge, tail.follow);
  }
}, 1500);
</script>
</body>
</html>
`;
