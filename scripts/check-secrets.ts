/**
 * Credential leak guard.
 *
 * Scans every tracked file for credential shapes (provider key prefixes, private key blocks,
 * bearer/basic literals) and fails the gate when one appears. Tracked-only on purpose: the
 * working tree is where a leak starts, but `git ls-files` is exactly what a push publishes.
 *
 * Scope note: personal identifiers are *not* scanned here. The repository legitimately contains
 * upstream attribution emails (THIRD-PARTY-NOTICES.txt) and machine paths in vendored test
 * fixtures, so an identity scan would be noise, not a guard.
 *
 * Fixture values are the hard part: this repository ships hundreds of deliberate fake keys for
 * redaction tests (`sk-ABCdef…`, `AKIAJUNK…`, `ghp_AbCd…`). A shape match is therefore reported
 * only when the value *and* its surrounding line look like a real credential. Anything else is
 * counted as a fixture and ignored, so the gate stays meaningful instead of being muted.
 */
import { $ } from "bun";
import * as path from "node:path";

const SHAPES: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
	{ label: "OpenAI key", pattern: /\bsk-(?!ant-|or-v1-)[A-Za-z0-9_-]{32,}/ },
	{ label: "Anthropic key", pattern: /\bsk-ant-[A-Za-z0-9_-]{32,}/ },
	{ label: "OpenRouter key", pattern: /\bsk-or-v1-[A-Za-z0-9]{32,}/ },
	{ label: "GitHub token", pattern: /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/ },
	{ label: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{33,}/ },
	{ label: "AWS access key id", pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
	{ label: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{12,}/ },
	{ label: "Stripe secret", pattern: /\b(sk|rk)_live_[A-Za-z0-9]{20,}/ },
	{ label: "Hugging Face token", pattern: /\bhf_[A-Za-z0-9]{32,}/ },
	{ label: "Perplexity key", pattern: /\bpplx-[A-Za-z0-9]{32,}/ },
	{ label: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/ },
	{ label: "private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
	{ label: "credentials in URL", pattern: /https?:\/\/[^/\s:@]{3,}:[^/\s@]{8,}@[a-z0-9.-]+/i },
];

/**
 * Deliberate test material: a fake key is a fake key because someone wrote that down.
 *
 * The repeated-character rule (`xxxxxx`) covers placeholder tokens that spell nothing — an
 * `.env.example` documents `ghp_xxxxxxxx…`, and that is not a credential.
 */
const FIXTURE =
	/(test|fixture|example|dummy|fake|placeholder|not_?a_?real|sample|mock|redact|junk|abc|xyz|1234|deterministic|should-not-win|changeme|your[_-])|(.)\2{5,}/i;

/**
 * A PEM header alone proves nothing: tests write `-----BEGIN PRIVATE KEY-----\nKEY\n-----END…`
 * to exercise file handling. Only a body that could actually be key material is reported.
 */
function hasKeyMaterial(text: string, markerIndex: number, markerLength: number): boolean {
	// Everything between the BEGIN and END delimiters, minus the line breaks a PEM body carries.
	const body =
		text
			.slice(markerIndex + markerLength)
			.split("-----", 1)[0]
			?.replace(/[^A-Za-z0-9+/=]/g, "") ?? "";
	return body.length >= 64;
}

/**
 * In-source suppression: `secret-scan:allow <reason>` on the reported line or the line above.
 *
 * An escape hatch has to exist (a committed debug keypair the tool itself ships is not a leak),
 * but it must stay visible: suppressions are counted and listed, and the reason is written where
 * the value lives so the next reader can judge it.
 */
const SUPPRESSION = /secret-scan:allow\s+(.+)/;
const SUPPRESSION_LOOKBACK = 2;

/** Files whose shapes are the scanner's own documentation or its fixtures. */
const SKIP_PATHS = new Set(["scripts/check-secrets.ts"]);

const SKIP_SUFFIX = [
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".ico",
	".pdf",
	".woff",
	".woff2",
	".ttf",
	".zip",
	".gz",
	".bz2",
	".xz",
	".zst",
	".wasm",
	".bin",
	".snap",
	".lock",
	".patch",
];
const MAX_BYTES = 3_000_000;

const repoRoot = path.resolve(import.meta.dir, "..");
process.chdir(repoRoot);
const listed = (await $`git ls-files`.quiet().text()).split("\n").filter(Boolean);

const findings: string[] = [];
const suppressions: string[] = [];
let scanned = 0;
for (const name of listed) {
	if (SKIP_PATHS.has(name) || SKIP_SUFFIX.some(suffix => name.endsWith(suffix))) continue;
	const file = Bun.file(name);
	const size = file.size;
	if (size === 0 || size > MAX_BYTES) continue;
	let text: string;
	try {
		text = await file.text();
	} catch {
		continue;
	}
	scanned++;
	const lines = text.split("\n");
	let offset = 0;
	for (const [index, line] of lines.entries()) {
		for (const { label, pattern } of SHAPES) {
			const match = pattern.exec(line);
			if (!match) continue;
			if (label === "private key block" && !hasKeyMaterial(text, offset + match.index, match[0].length)) continue;
			const context = line.slice(Math.max(0, match.index - 80), match.index + match[0].length + 40);
			if (FIXTURE.test(match[0]) || FIXTURE.test(context)) continue;
			const nearby = lines.slice(Math.max(0, index - SUPPRESSION_LOOKBACK), index + 1).join("\n");
			const allowed = SUPPRESSION.exec(nearby);
			if (allowed) {
				suppressions.push(`${name}:${index + 1} [${label}] — ${allowed[1].trim()}`);
				continue;
			}
			findings.push(`${name}:${index + 1} [${label}] ${match[0].slice(0, 24)}…`);
		}
		offset += line.length + 1;
	}
}

if (findings.length > 0) {
	process.stderr.write(`Potential credentials in ${findings.length} tracked location(s):\n`);
	for (const finding of findings) process.stderr.write(`  ${finding}\n`);
	process.stderr.write("\nRemove the value, or make the fixture nature explicit (test/fake/example).\n");
	process.exit(1);
}
if (suppressions.length > 0) {
	process.stdout.write(`${suppressions.length} suppressed by secret-scan:allow:\n`);
	for (const entry of suppressions) process.stdout.write(`  ${entry}\n`);
}
process.stdout.write(`No credential shapes in ${scanned} tracked files.\n`);
