/**
 * `zero2ai sync` — carry model configuration over from another agent root.
 *
 * The interesting half is what happens *before* anything is written: the plan is
 * printed (dry runs stop there), and credential rows are the only group that
 * needs a confirmation, because they move secrets between stores. A non-terminal
 * stdin never blocks: the credentials are dropped from the plan and the reason is
 * printed with the flag that would accept them, so a pipeline can decide.
 */
import { createInterface } from "node:readline/promises";
import chalk from "@zero2ai/utils/chalk";
import { getAgentDbPath, getAgentDir } from "@zero2ai/utils";
import { Settings } from "../config/settings";
import {
	applySyncPlan,
	planRootSync,
	resolveSyncSource,
	SYNC_GROUPS,
	type SyncGroupId,
	type SyncNote,
	type SyncPlan,
} from "../config/root-sync";

export interface SyncCommandArgs {
	/** Source root: `omp` | `oh-my-pi` | `pi` | `zero2ai` | a path. */
	readonly from?: string;
	readonly dryRun?: boolean;
	readonly force?: boolean;
	readonly yes?: boolean;
	readonly json?: boolean;
	/** Restrict the run to the named groups; omitted means all of them. */
	readonly groups?: readonly SyncGroupId[];
}

export async function runSyncCommand(args: SyncCommandArgs): Promise<number> {
	const source = await resolveSyncSource(args.from);
	const settings = await Settings.init();
	const targetAgentDir = getAgentDir();
	const targetDbPath = getAgentDbPath();
	const groups = args.groups?.length ? args.groups : [...SYNC_GROUPS];

	const plan = await planRootSync({
		source,
		targetAgentDir,
		targetDbPath,
		settings,
		groups,
		force: args.force === true,
	});

	if (args.dryRun === true) {
		report(plan, { applied: false, backupPath: null, json: args.json === true });
		return 0;
	}

	const effective = await admitCredentialWrites(plan, args.yes === true);
	const result = await applySyncPlan(effective, settings);
	report(effective, { applied: true, backupPath: result.backupPath, json: args.json === true });
	return 0;
}

/**
 * Drop credential writes unless the operator accepted them. On a terminal that
 * is a y/N question; anywhere else the rows are left behind with the reason, so
 * an unattended run cannot move secrets by accident.
 */
async function admitCredentialWrites(plan: SyncPlan, yes: boolean): Promise<SyncPlan> {
	const count = plan.writes.filter(write => write.group === "credentials").length;
	if (count === 0 || yes) return plan;
	const reason =
		process.stdin.isTTY === true
			? undefined
			: `stdin is not a terminal, so ${count} credential row(s) were not copied — re-run with --yes to accept them`;
	if (reason !== undefined) {
		process.stderr.write(`${reason}\n`);
		return withoutCredentialWrites(plan, reason);
	}
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	let accepted: boolean;
	try {
		const answer = await rl.question(
			`Copy ${count} credential row(s) from ${plan.source.label} into this machine's store? [y/N] `,
		);
		accepted = answer.trim().toLowerCase().startsWith("y");
	} finally {
		rl.close();
	}
	if (accepted) return plan;
	return withoutCredentialWrites(plan, "declined at the confirmation prompt");
}

function withoutCredentialWrites(plan: SyncPlan, reason: string): SyncPlan {
	const notes: SyncNote[] = plan.notes.filter(note => !(note.group === "credentials" && note.pending));
	notes.push({
		group: "credentials",
		name: "agent.db",
		action: "skip",
		detail: reason,
		pending: false,
	});
	return {
		...plan,
		notes,
		writes: plan.writes.filter(write => write.group !== "credentials"),
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// reporting
// ─────────────────────────────────────────────────────────────────────────────

const ACTION_MARK: Readonly<Record<SyncNote["action"], string>> = {
	create: "+",
	update: "~",
	same: "=",
	skip: "-",
};

interface ReportOptions {
	readonly applied: boolean;
	readonly backupPath: string | null;
	readonly json: boolean;
}

function report(plan: SyncPlan, options: ReportOptions): void {
	if (options.json) {
		process.stdout.write(
			`${JSON.stringify(
				{
					dryRun: !options.applied,
					source: plan.source,
					targetAgentDir: plan.targetAgentDir,
					groups: plan.groups,
					force: plan.force,
					pending: plan.notes.filter(note => note.pending).length,
					backupPath: options.backupPath,
					notes: plan.notes,
				},
				null,
				2,
			)}\n`,
		);
		return;
	}

	const lines: string[] = [
		`${options.applied ? "syncing" : "plan"} ${plan.source.label} → ${plan.targetAgentDir}`,
		"",
	];
	let group: SyncGroupId | undefined;
	for (const note of plan.notes) {
		if (note.group !== group) {
			group = note.group;
			lines.push(chalk.bold(note.group));
		}
		const mark = ACTION_MARK[note.action];
		const body = `${mark} ${note.name.padEnd(18)} ${note.detail}`;
		lines.push(`  ${note.action === "create" || note.action === "update" ? chalk.green(body) : chalk.dim(body)}`);
	}
	if (plan.notes.length === 0) lines.push(chalk.dim("  nothing to compare"));
	lines.push("");

	const pending = plan.notes.filter(note => note.pending).length;
	if (options.applied) {
		lines.push(
			`${pending} change(s) applied${options.backupPath ? `; credential store backed up to ${options.backupPath}` : ""}.`,
		);
	} else if (pending === 0) {
		lines.push("Already in sync.");
	} else {
		lines.push(`${pending} change(s) planned — re-run without --dry-run to write them.`);
	}
	process.stdout.write(`${lines.join("\n")}\n`);
}
