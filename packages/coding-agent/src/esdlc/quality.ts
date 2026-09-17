/**
 * Quality signals for the test phase.
 *
 * The goal is a report the operator can act on rather than a wall of raw output: which signals
 * ran, what each one said, and a score whose formula is stated next to it. Every number here is
 * either measured or absent — a missing signal is reported as missing, never as a pass.
 */
import type { EsdlcQualityReport, EsdlcQualitySignal } from "./types";

/** Component weights; renormalized over the components a run actually measured. */
export const QUALITY_WEIGHTS: Readonly<Record<string, number>> = {
	tests: 0.5,
	signals: 0.3,
	coverage: 0.2,
};

interface Counts {
	readonly passed?: number;
	readonly failed?: number;
	readonly skipped?: number;
	readonly total?: number;
}

/**
 * Read test counts out of a runner's summary line.
 *
 * Deliberately tolerant and explicitly limited: bun/jest (`N pass`, `N fail`, `Ran N tests`),
 * vitest (`Tests  N passed`), pytest (`N passed, M failed`). An unrecognized format yields no
 * counts, and the UI then shows pass/fail from the exit code alone.
 */
export function parseTestCounts(output: string): Counts {
	const counts: { passed?: number; failed?: number; skipped?: number; total?: number } = {};
	const first = (...patterns: RegExp[]): number | undefined => {
		for (const pattern of patterns) {
			const match = pattern.exec(output);
			if (match?.[1] !== undefined) return Number(match[1]);
		}
		return undefined;
	};
	counts.passed = first(/\b(\d+) pass(?:ed)?\b/i, /\b(\d+)\s+passed\b/i, /Tests\s+(\d+)\s+passed/i);
	counts.failed = first(/\b(\d+) fail(?:ed)?\b/i, /\b(\d+)\s+failed\b/i, /Tests\s+\d+\s+failed\s*:\s*(\d+)/i);
	counts.skipped = first(/\b(\d+) skip(?:ped)?\b/i, /\b(\d+)\s+skipped\b/i);
	counts.total = first(/\bRan\s+(\d+)\s+tests?\b/i, /\b(\d+)\s+tests?\s+(?:run|total)\b/i);
	if (counts.total === undefined && counts.passed !== undefined) {
		counts.total = (counts.passed ?? 0) + (counts.failed ?? 0) + (counts.skipped ?? 0);
	}
	return counts;
}

/** Coverage percentage from the common reporters; undefined when the run reported none. */
export function parseCoveragePercent(output: string): number | undefined {
	for (const pattern of [
		/All files\s*\|[^\n]*?(\d+(?:\.\d+)?)\s*\|/,
		/Lines\s*:\s*(\d+(?:\.\d+)?)\s*%/i,
		/Statements?\s*:\s*(\d+(?:\.\d+)?)\s*%/i,
		/coverage[^\n]*?(\d+(?:\.\d+)?)\s*%/i,
		/(\d+(?:\.\d+)?)\s*%[^\n]*?coverage/i,
	]) {
		const match = pattern.exec(output);
		if (match?.[1] !== undefined) {
			const value = Number(match[1]);
			if (Number.isFinite(value) && value >= 0 && value <= 100) return value;
		}
	}
	return undefined;
}

/** Fold the measured signals into a 0–100 score, reporting the weights it actually used. */
export function scoreQuality(signals: readonly EsdlcQualitySignal[]): {
	score: number;
	weights: Record<string, number>;
} {
	const components: Array<{ name: string; value: number }> = [];

	const test = signals.find(signal => signal.name === "test");
	if (test) {
		const measured = (test.passed ?? 0) + (test.failed ?? 0);
		components.push({
			name: "tests",
			value: measured > 0 ? (test.passed ?? 0) / measured : test.exitCode === 0 ? 1 : 0,
		});
	}

	const measuredSignals = signals.filter(signal => signal.exitCode !== null);
	if (measuredSignals.length > 0) {
		components.push({
			name: "signals",
			value: measuredSignals.filter(signal => signal.exitCode === 0).length / measuredSignals.length,
		});
	}

	const coverage = signals.find(signal => signal.name === "coverage" && signal.percent !== undefined);
	if (coverage?.percent !== undefined) components.push({ name: "coverage", value: coverage.percent / 100 });

	const present = components.filter(component => QUALITY_WEIGHTS[component.name] !== undefined);
	const totalWeight = present.reduce((sum, component) => sum + (QUALITY_WEIGHTS[component.name] ?? 0), 0);
	const weights: Record<string, number> = {};
	if (totalWeight <= 0) return { score: 0, weights };
	let score = 0;
	for (const component of present) {
		const weight = (QUALITY_WEIGHTS[component.name] ?? 0) / totalWeight;
		weights[component.name] = Number(weight.toFixed(3));
		score += weight * component.value;
	}
	return { score: Math.round(score * 100), weights };
}

/** The human-readable report; the JSON next to it is what the UI charts. */
export function renderQualityArtifact(report: EsdlcQualityReport, rawOutput: string): string {
	const lines = [
		"# Code quality report",
		"",
		`**Score:** ${report.score}/100 — weights: ${Object.entries(report.weights)
			.map(([name, weight]) => `${name} ${weight}`)
			.join(", ")}`,
		"",
		"| Signal | Command | Result | Duration | Details |",
		"| --- | --- | --- | --- | --- |",
	];
	for (const signal of report.signals) {
		const result =
			signal.exitCode === null ? "not measured" : signal.exitCode === 0 ? "passed" : `failed (${signal.exitCode})`;
		const details: string[] = [];
		if (signal.passed !== undefined || signal.failed !== undefined) {
			details.push(
				`${signal.passed ?? 0} passed, ${signal.failed ?? 0} failed${signal.skipped ? `, ${signal.skipped} skipped` : ""}`,
			);
		}
		if (signal.percent !== undefined) details.push(`coverage ${signal.percent}%`);
		if (signal.note) details.push(signal.note);
		lines.push(
			`| ${signal.name} | \`${signal.command}\` | ${result} | ${signal.durationMs} ms | ${details.join("; ") || "—"} |`,
		);
	}
	lines.push(
		"",
		"> Counts are parsed from the runner's own summary; a signal that was not configured is",
		"> reported as *not measured* rather than assumed to pass. The score renormalizes over the",
		"> measured components, so a project without coverage tooling is not penalized for it.",
		"",
		"## Raw output",
		"",
		"```",
		rawOutput || "(no output)",
		"```",
	);
	return lines.join("\n");
}
