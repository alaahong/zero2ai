/**
 * Repository facts for the deploy and release phases.
 *
 * The document phases used to receive a loose prose blurb, which let a model write a confident
 * deployment guide for infrastructure that does not exist. This module derives the facts the
 * repository actually carries — deployment configs, scripts, entrypoints, environment variables,
 * ports — and keeps the file each fact came from, so the document can cite evidence and a reader
 * can check it.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@zero2ai/utils";
import type { EsdlcDeployConfig, EsdlcDeployFacts } from "./types";

/** Root-level files that shape how a project ships, most specific first. */
const CONFIG_CANDIDATES: ReadonlyArray<{ readonly pattern: RegExp; readonly kind: string }> = [
	{ pattern: /^Dockerfile(\..+)?$/i, kind: "container image" },
	{ pattern: /^(docker-)?compose(\..+)?\.ya?ml$/i, kind: "compose stack" },
	{ pattern: /^\.gitlab-ci\.ya?ml$/i, kind: "CI pipeline" },
	{ pattern: /^Jenkinsfile$/i, kind: "CI pipeline" },
	{ pattern: /^Chart\.ya?ml$/i, kind: "helm chart" },
	{ pattern: /^skaffold\.ya?ml$/i, kind: "skaffold pipeline" },
	{ pattern: /^Procfile$/i, kind: "process definition" },
	{ pattern: /^vercel\.json$/i, kind: "platform config" },
	{ pattern: /^netlify\.toml$/i, kind: "platform config" },
	{ pattern: /^fly\.toml$/i, kind: "platform config" },
	{ pattern: /^railway\.json$/i, kind: "platform config" },
	{ pattern: /^systemd.*\.service$/i, kind: "systemd unit" },
	{ pattern: /\.(tf|tfvars)$/i, kind: "terraform" },
];

/** Directories worth listing; their contents are deployment material regardless of name. */
const CONFIG_DIRS = [
	".github/workflows",
	"deploy",
	"deployment",
	"k8s",
	"kubernetes",
	"helm",
	"charts",
	"infra",
	"ops",
];

const SOURCE_DIRS = ["src", "app", "lib", "server", "packages"];
const MAX_SCANNED_FILES = 400;
const MAX_SCANNED_BYTES = 512 * 1024;
const MAX_LISTED = 60;

const ENV_PATTERN = /\b(?:process|Bun)\.env\.([A-Z][A-Z0-9_]{2,})|\bimport\.meta\.env\.([A-Z][A-Z0-9_]{2,})/g;
const PORT_PATTERNS = [
	/createServer\s*\(\s*\{[^}]*?port:\s*(\d{2,5})/i,
	/\.listen\s*\(\s*(\d{2,5})/i,
	/PORT\s*[:=]\s*(\d{2,5})/,
	/EXPOSE\s+(\d{2,5})/i,
	/--port[= ](\d{2,5})/,
];

async function readConfigFile(cwd: string, relative: string, kind: string): Promise<EsdlcDeployConfig | null> {
	try {
		const stat = await fs.stat(path.join(cwd, relative));
		if (!stat.isFile()) return null;
		return { path: relative.replaceAll("\\", "/"), kind, bytes: stat.size };
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

async function findConfigs(cwd: string): Promise<EsdlcDeployConfig[]> {
	const found: EsdlcDeployConfig[] = [];
	let rootEntries: string[] = [];
	try {
		rootEntries = await fs.readdir(cwd);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	for (const name of rootEntries) {
		const match = CONFIG_CANDIDATES.find(candidate => candidate.pattern.test(name));
		if (!match) continue;
		const entry = await readConfigFile(cwd, name, match.kind);
		if (entry) found.push(entry);
	}
	for (const dir of CONFIG_DIRS) {
		let entries: string[] = [];
		try {
			entries = await fs.readdir(path.join(cwd, dir));
		} catch (error) {
			if (!isEnoent(error)) throw error;
			continue;
		}
		for (const name of entries.slice(0, MAX_LISTED)) {
			if (!/\.(ya?ml|json|toml|sh|ps1|service|conf|tf)$/i.test(name)) continue;
			const entry = await readConfigFile(cwd, `${dir}/${name}`, `${dir} material`);
			if (entry) found.push(entry);
		}
	}
	return found.slice(0, MAX_LISTED);
}

async function readPackageJson(
	cwd: string,
): Promise<{ scripts: Record<string, string>; entrypoints: string[]; evidence: string[] }> {
	const evidence: string[] = [];
	const scripts: Record<string, string> = {};
	const entrypoints: string[] = [];
	try {
		const parsed = (await Bun.file(path.join(cwd, "package.json")).json()) as Record<string, unknown>;
		evidence.push("package.json");
		const rawScripts = parsed.scripts;
		if (rawScripts && typeof rawScripts === "object") {
			for (const [name, value] of Object.entries(rawScripts as Record<string, unknown>)) {
				if (typeof value === "string") scripts[name] = value;
			}
		}
		for (const key of ["main", "module", "bin"] as const) {
			const value = parsed[key];
			if (typeof value === "string") entrypoints.push(`${key}: ${value}`);
			else if (value && typeof value === "object") {
				for (const [name, target] of Object.entries(value as Record<string, unknown>)) {
					if (typeof target === "string") entrypoints.push(`bin.${name}: ${target}`);
				}
			}
		}
		const engines = parsed.engines;
		if (engines && typeof engines === "object") entrypoints.push(`engines: ${JSON.stringify(engines)}`);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	return { scripts, entrypoints, evidence };
}

/** Walk the source tree cheaply: bounded depth, bounded file count, text files only. */
async function collectSourceFiles(cwd: string): Promise<string[]> {
	const out: string[] = [];
	const walk = async (dir: string, depth: number): Promise<void> => {
		if (out.length >= MAX_SCANNED_FILES || depth > 6) return;
		let entries: Array<{ name: string; isDirectory: () => boolean }>;
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch (error) {
			if (isEnoent(error)) return;
			throw error;
		}
		for (const entry of entries) {
			if (out.length >= MAX_SCANNED_FILES) return;
			if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(full, depth + 1);
				continue;
			}
			if (/\.(ts|tsx|js|mjs|cjs|rs|py|go|java|kt|sh|ya?ml|toml)$/i.test(entry.name)) out.push(full);
		}
	};
	for (const dir of SOURCE_DIRS) await walk(path.join(cwd, dir), 0);
	return out;
}

function scanSource(text: string): { env: string[]; ports: string[] } {
	const env: string[] = [];
	for (const match of text.matchAll(ENV_PATTERN)) {
		const name = match[1] ?? match[2];
		if (name) env.push(name);
	}
	const ports: string[] = [];
	for (const pattern of PORT_PATTERNS) {
		const match = pattern.exec(text);
		if (match?.[1]) ports.push(match[1]);
	}
	return { env, ports };
}

/** Derive the deployment facts for a project. */
export async function collectDeployFacts(cwd: string): Promise<EsdlcDeployFacts> {
	const configs = await findConfigs(cwd);
	const { scripts, entrypoints, evidence } = await readPackageJson(cwd);
	const envVars = new Set<string>();
	const ports = new Set<string>();
	const scanned: string[] = [];

	for (const file of await collectSourceFiles(cwd)) {
		const handle = Bun.file(file);
		if (handle.size > MAX_SCANNED_BYTES) continue;
		let text: string;
		try {
			text = await handle.text();
		} catch {
			continue;
		}
		const found = scanSource(text);
		if (found.env.length || found.ports.length) scanned.push(path.relative(cwd, file).replaceAll("\\", "/"));
		for (const name of found.env) envVars.add(name);
		for (const port of found.ports) ports.add(port);
	}

	// Ports also live in container/platform files; those are evidence-free prose otherwise.
	for (const config of configs) {
		if (!/dockerfile|compose|procfile/i.test(config.path)) continue;
		try {
			const text = await Bun.file(path.join(cwd, config.path)).text();
			for (const port of scanSource(text).ports) ports.add(port);
		} catch {
			continue;
		}
	}

	return {
		at: new Date().toISOString(),
		configs,
		scripts,
		entrypoints,
		envVars: [...envVars].sort(),
		ports: [...ports].sort(),
		evidence: [...new Set([...evidence, ...configs.map(config => config.path), ...scanned.slice(0, 40)])].slice(
			0,
			80,
		),
	};
}

/** Compact form for the model prompt: facts as a list, with the evidence trail called out. */
export function renderDeployFactsForPrompt(facts: EsdlcDeployFacts): string {
	const parts: string[] = [];
	parts.push(
		facts.configs.length
			? `Deployment configs in the repository:\n${facts.configs.map(config => `- ${config.path} (${config.kind}, ${config.bytes} bytes)`).join("\n")}`
			: "Deployment configs in the repository: none found",
	);
	parts.push(
		`package.json scripts:\n${
			Object.entries(facts.scripts)
				.map(([name, value]) => `- ${name}: ${value}`)
				.join("\n") || "- (none)"
		}`,
	);
	if (facts.entrypoints.length) parts.push(`Entrypoints:\n${facts.entrypoints.map(entry => `- ${entry}`).join("\n")}`);
	parts.push(
		facts.envVars.length
			? `Environment variables the source reads:\n${facts.envVars.map(name => `- ${name}`).join("\n")}`
			: "Environment variables the source reads: none detected",
	);
	if (facts.ports.length) parts.push(`Ports referenced:\n${facts.ports.map(port => `- ${port}`).join("\n")}`);
	parts.push(
		`Evidence files (cite these paths when stating a fact):\n${facts.evidence.map(file => `- ${file}`).join("\n")}`,
	);
	return parts.join("\n\n");
}

/** The artifact a reader opens to check the document's claims. */
export function renderDeployFactsArtifact(facts: EsdlcDeployFacts): string {
	const lines = [
		"# Deployment facts (evidence)",
		"",
		`Derived ${facts.at} from the repository. The deployment document cites these paths; check`,
		"any claim by opening the file it names.",
		"",
		"## Deployment configuration",
		"",
	];
	lines.push(
		facts.configs.length
			? facts.configs.map(config => `- \`${config.path}\` — ${config.kind}, ${config.bytes} bytes`).join("\n")
			: "_None found._",
	);
	lines.push("", "## Scripts", "");
	lines.push(
		Object.entries(facts.scripts)
			.map(([name, value]) => `- \`${name}\` — \`${value}\``)
			.join("\n") || "_None._",
	);
	if (facts.entrypoints.length) lines.push("", "## Entrypoints", "", ...facts.entrypoints.map(entry => `- ${entry}`));
	lines.push("", "## Environment variables read by the source", "");
	lines.push(facts.envVars.length ? facts.envVars.map(name => `- \`${name}\``).join("\n") : "_None detected._");
	if (facts.ports.length) {
		lines.push("", "## Ports referenced", "", facts.ports.map(port => `- \`${port}\``).join("\n"));
	}
	lines.push("", "## Evidence index", "", ...facts.evidence.map(file => `- \`${file}\``));
	return lines.join("\n");
}
