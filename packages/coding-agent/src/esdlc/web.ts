/**
 * ESDLC web workspace.
 *
 * Loopback-only HTTP server + JSON API + one embedded page. Deliberately free of
 * build steps and third-party assets: the whole UI is the string below, so it
 * runs on an air-gapped host and can be reviewed by reading this file.
 *
 * Threat model: the server is a local tool. It binds 127.0.0.1, rejects
 * non-loopback `Host` headers (DNS-rebinding guard), serves same-origin only
 * (no CORS headers), and confines artifact reads to the workspace directory.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	ESDLC_PHASES,
	ESDLC_PHASE_LABELS,
	ESDLC_PHASE_TITLES,
	readEsdlcState,
	renderEsdlcBannerArt,
	runEsdlcPhase,
} from "./index";
import { esdlcDir } from "./state";
import { listBoundModels } from "./models";
import { isEsdlcPhaseId, type EsdlcPhaseId } from "./types";

export const ESDLC_WEB_HOST = "127.0.0.1";
export const DEFAULT_ESDLC_WEB_PORT = 3848;

const LOOPBACK_HOSTS: Readonly<Record<string, true>> = { "127.0.0.1": true, localhost: true, "[::1]": true, "::1": true };
const MAX_BODY_BYTES = 256 * 1024;
const MAX_ARTIFACT_BYTES = 512 * 1024;

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

interface RunRequestBody {
	phase?: unknown;
	input?: unknown;
	prompt?: unknown;
	model?: unknown;
	command?: unknown;
}

function hostIsLoopback(request: Request): boolean {
	const header = request.headers.get("host");
	if (!header) return false;
	const hostname = header.startsWith("[") ? header.slice(0, header.indexOf("]") + 1) : header.split(":")[0] ?? "";
	return LOOPBACK_HOSTS[hostname.toLowerCase()] === true;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});
}

/** Resolve an artifact path, refusing anything outside the workspace directory. */
function resolveArtifact(projectRoot: string, requested: string): string {
	const root = path.resolve(esdlcDir(projectRoot));
	const resolved = path.resolve(projectRoot, requested);
	if (resolved !== root && !resolved.startsWith(root + path.sep)) {
		throw new Error("artifact path escapes the ESDLC workspace");
	}
	return resolved;
}

async function handleRun(projectRoot: string, request: Request): Promise<Response> {
	const raw = await request.text();
	if (raw.length > MAX_BODY_BYTES) return json({ error: "request body too large" }, 413);
	let body: RunRequestBody;
	try {
		body = JSON.parse(raw) as RunRequestBody;
	} catch {
		return json({ error: "body must be JSON" }, 400);
	}
	const phase = typeof body.phase === "string" ? body.phase.trim() : "";
	if (!isEsdlcPhaseId(phase)) {
		return json({ error: `phase must be one of: ${ESDLC_PHASES.join(", ")}` }, 400);
	}
	const state = await runEsdlcPhase(projectRoot, phase as EsdlcPhaseId, {
		...(typeof body.input === "string" && body.input.trim() ? { input: body.input.trim() } : {}),
		...(typeof body.prompt === "string" && body.prompt.trim() ? { prompt: body.prompt.trim() } : {}),
		...(typeof body.model === "string" && body.model.trim() ? { model: body.model.trim() } : {}),
		...(typeof body.command === "string" && body.command.trim() ? { command: body.command.trim() } : {}),
	});
	// 200 even for a failed phase: the run completed, the phase did not.
	return json({ state: state.phases[phase as EsdlcPhaseId], phases: state.phases });
}

async function handleArtifact(projectRoot: string, url: URL): Promise<Response> {
	const requested = url.searchParams.get("path") ?? "";
	if (!requested) return json({ error: "path is required" }, 400);
	let resolved: string;
	try {
		resolved = resolveArtifact(projectRoot, requested);
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

/** Serve the workspace on loopback until {@link EsdlcWebHandle.stop}. */
export function startEsdlcWeb(options: EsdlcWebOptions): EsdlcWebHandle {
	const host = options.host ?? ESDLC_WEB_HOST;
	const server = Bun.serve({
		hostname: host,
		port: options.port ?? DEFAULT_ESDLC_WEB_PORT,
		fetch: async request => {
			if (!hostIsLoopback(request)) return json({ error: "forbidden host" }, 403);
			const url = new URL(request.url);
			if (url.pathname === "/" || url.pathname === "/index.html") {
				return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
			}
			if (url.pathname === "/api/state") return json(await readEsdlcState(options.projectRoot));
			if (url.pathname === "/api/models") return json(await listBoundModels(options.projectRoot));
			if (url.pathname === "/api/run" && request.method === "POST") return await handleRun(options.projectRoot, request);
			if (url.pathname === "/api/artifact") return await handleArtifact(options.projectRoot, url);
			return json({ error: "not found" }, 404);
		},
	});
	const port = server.port ?? options.port ?? DEFAULT_ESDLC_WEB_PORT;
	return { url: `http://${host}:${port}`, port, stop: () => void server.stop(true) };
}

const FLOW_TEXT = ESDLC_PHASES.map(phase => ESDLC_PHASE_LABELS[phase]).join("  →  ");
const PHASE_ORDER = JSON.stringify(ESDLC_PHASES);
const PHASE_TITLES = JSON.stringify(ESDLC_PHASE_TITLES);

const PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ZERO2AI · ESDLC</title>
<style>
  :root { --bg:#0d0d0d; --panel:#161616; --line:#2a2a2a; --fg:#fafafa; --dim:#9a9a9a; --accent:#f97316; --ok:#22c55e; --err:#ef4444; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif; }
  header { padding:20px 24px 8px; border-bottom:1px solid var(--line); }
  pre.banner { margin:0; color:var(--fg); font:12px/1.2 ui-monospace,Consolas,monospace; white-space:pre; }
  .flow { color:var(--accent); font:12px ui-monospace,Consolas,monospace; letter-spacing:.5px; margin:8px 0 0; }
  .root { color:var(--dim); font-size:12px; margin:4px 0 0; }
  .toolbar { display:flex; align-items:center; gap:8px; margin-top:10px; font-size:12px; color:var(--dim); }
  .toolbar select { background:#0b0b0b; color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:4px 8px; font:12px ui-monospace,monospace; min-width:260px; }
  main { display:grid; grid-template-columns:minmax(420px,1fr) minmax(360px,1.1fr); gap:20px; padding:20px 24px 40px; }
  .phases { display:flex; flex-direction:column; gap:10px; }
  .phase { background:var(--panel); border:1px solid var(--line); border-left:3px solid var(--line); border-radius:8px; padding:12px 14px; }
  .phase[data-status="completed"] { border-left-color:var(--ok); }
  .phase[data-status="failed"] { border-left-color:var(--err); }
  .phase[data-status="running"] { border-left-color:var(--accent); }
  .row { display:flex; align-items:center; gap:10px; }
  .idx { color:var(--dim); font:12px ui-monospace,monospace; }
  .name { font-weight:600; }
  .status { margin-left:auto; font:11px ui-monospace,monospace; text-transform:uppercase; letter-spacing:.6px; color:var(--dim); }
  .desc { color:var(--dim); font-size:12px; margin-top:2px; }
  .summary { font-size:12px; color:var(--fg); margin-top:6px; }
  .error { font:12px ui-monospace,monospace; color:var(--err); margin-top:6px; white-space:pre-wrap; }
  .artifacts { margin-top:6px; display:flex; flex-wrap:wrap; gap:6px; }
  .artifacts button { background:#101010; color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:3px 8px; font:11px ui-monospace,monospace; cursor:pointer; }
  .artifacts button:hover { border-color:var(--accent); }
  .actions { display:flex; gap:8px; margin-top:10px; align-items:flex-start; }
  button.run { background:var(--accent); color:#0d0d0d; border:0; border-radius:6px; padding:6px 14px; font-weight:600; cursor:pointer; }
  button.run:disabled { opacity:.45; cursor:default; }
  textarea { flex:1; min-height:38px; background:#0b0b0b; color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:6px 8px; font:12px ui-monospace,monospace; resize:vertical; }
  aside { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px; min-height:320px; }
  aside h2 { margin:0 0 10px; font-size:13px; color:var(--dim); font-weight:600; letter-spacing:.4px; text-transform:uppercase; }
  pre.viewer { margin:0; white-space:pre-wrap; word-break:break-word; font:12px/1.5 ui-monospace,Consolas,monospace; color:var(--fg); }
  .hint { color:var(--dim); font-size:12px; }
</style>
</head>
<body>
<header>
  <pre class="banner">${renderEsdlcBannerArt().join("\n")}</pre>
  <p class="flow">${FLOW_TEXT}</p>
  <p class="root" id="root"></p>
  <div class="toolbar">
    <label for="model">模型（已绑定的 provider）</label>
    <select id="model"></select>
    <span class="hint" id="model-hint"></span>
  </div>
</header>
<main>
  <section class="phases" id="phases"></section>
  <aside>
    <h2 id="viewer-title">产物预览</h2>
    <pre class="viewer" id="viewer">选择一个阶段产物以查看内容。</pre>
  </aside>
</main>
<script>
const ORDER = ${PHASE_ORDER};
const TITLES = ${PHASE_TITLES};

let state = null;
let models = null;

async function loadModels() {
  try {
    models = await (await fetch("/api/models")).json();
  } catch {
    models = { default: null, defaultLabel: "默认", available: [] };
  }
  const select = document.getElementById("model");
  const saved = localStorage.getItem("esdlc.model") ?? "";
  select.textContent = "";
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = models.default ? models.defaultLabel + " — " + models.default.label : models.defaultLabel;
  select.appendChild(auto);
  for (const model of models.available) {
    const option = document.createElement("option");
    option.value = model.label;
    option.textContent = model.label;
    select.appendChild(option);
  }
  if (saved) select.value = saved;
  const parts = [];
  parts.push(models.available.length === 0
    ? "未检测到可用凭据：先在命令行配置 provider（zero2ai models）"
    : models.available.length + " 个已绑定模型");
  parts.push("配置根 " + models.configRoot);
  if (models.legacyRoot && models.legacyRoot.hasConfig) {
    parts.push("检测到旧配置根 ~/" + models.legacyRoot.dirName + "：若 provider 绑在那里，请用 ZERO2AI_CONFIG_DIR=" + models.legacyRoot.dirName + " 启动或迁移");
  }
  document.getElementById("model-hint").textContent = parts.join(" · ");
  select.onchange = () => localStorage.setItem("esdlc.model", select.value);
}

async function refresh() {
  const res = await fetch("/api/state");
  state = await res.json();
  document.getElementById("root").textContent = "project: " + state.projectRoot;
  render();
}

function render() {
  const host = document.getElementById("phases");
  host.textContent = "";
  ORDER.forEach((phase, index) => {
    const run = state.phases[phase];
    const card = document.createElement("div");
    card.className = "phase";
    card.dataset.status = run.status;

    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = '<span class="idx">' + (index + 1) + '</span><span class="name"></span><span class="status"></span>';
    row.querySelector(".name").textContent = phase;
    row.querySelector(".status").textContent = run.status;
    card.appendChild(row);

    const desc = document.createElement("div");
    desc.className = "desc";
    desc.textContent = TITLES[phase];
    card.appendChild(desc);

    if (run.summary) {
      const s = document.createElement("div");
      s.className = "summary";
      s.textContent = run.summary;
      card.appendChild(s);
    }
    if (run.error) {
      const e = document.createElement("div");
      e.className = "error";
      e.textContent = run.error;
      card.appendChild(e);
    }

    const actions = document.createElement("div");
    actions.className = "actions";
    let notes = null;
    if (phase === "requirements") {
      notes = document.createElement("textarea");
      notes.placeholder = "讨论要点（或先在命令行用 --input 传入录音/转写文本）";
      actions.appendChild(notes);
    }
    const button = document.createElement("button");
    button.className = "run";
    button.textContent = run.status === "pending" ? "运行" : "重新运行";
    button.disabled = run.status === "running";
    button.onclick = async () => {
      button.disabled = true;
      button.textContent = "运行中…";
      const body = { phase };
      if (notes && notes.value.trim()) body.prompt = notes.value.trim();
      const chosen = document.getElementById("model").value;
      if (chosen) body.model = chosen;
      try {
        const res = await fetch("/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        const payload = await res.json();
        if (!res.ok) alert(payload.error || "运行失败");
        else state.phases = payload.phases;
      } catch (err) {
        alert(String(err));
      }
      render();
    };
    actions.appendChild(button);
    card.appendChild(actions);

    if (run.artifacts.length) {
      const list = document.createElement("div");
      list.className = "artifacts";
      for (const artifact of run.artifacts) {
        const b = document.createElement("button");
        b.textContent = artifact.label;
        b.onclick = () => openArtifact(artifact);
        list.appendChild(b);
      }
      card.appendChild(list);
    }
    host.appendChild(card);
  });
}

async function openArtifact(artifact) {
  document.getElementById("viewer-title").textContent = artifact.label;
  const res = await fetch("/api/artifact?path=" + encodeURIComponent(artifact.path));
  const text = res.ok ? await res.text() : (await res.json()).error;
  document.getElementById("viewer").textContent = text;
}

refresh();
loadModels();
setInterval(refresh, 2500);
</script>
</body>
</html>
`;
