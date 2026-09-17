/**
 * `zero2ai sync` — pull model configuration from another agent root.
 */

import { Command, Flags } from "@zero2ai/utils/cli";
import { syncHelp as commandHelp } from "../cli/command-help";
import { runSyncCommand } from "../cli/sync-cli";
import { SYNC_GROUPS } from "../config/root-sync";
import { initTheme } from "../modes/theme/theme";

export default class Sync extends Command {
	static description = commandHelp.description;

	static flags = {
		from: Flags.string({
			description: "Source root: omp | oh-my-pi | pi | zero2ai, or a path to a root/agent dir (default: omp)",
		}),
		"dry-run": Flags.boolean({ description: "Print what would change without writing anything" }),
		force: Flags.boolean({ description: "Overwrite conflicting files and scalars (previous values are backed up)" }),
		yes: Flags.boolean({ description: "Accept the credential copy without asking" }),
		json: Flags.boolean({ description: "Print the plan as JSON" }),
		models: Flags.boolean({ description: "Only sync models.yml" }),
		settings: Flags.boolean({ description: "Only sync model settings (modelRoles, thinking level, …)" }),
		credentials: Flags.boolean({ description: "Only sync provider credentials" }),
	};

	static examples = [
		"# See what would come over from the pre-rename ~/.omp root\n  zero2ai sync --dry-run",
		"# Apply it (asks before copying credentials)\n  zero2ai sync",
		"# Unattended, credentials included\n  zero2ai sync --yes",
		"# Only the model settings\n  zero2ai sync --settings",
		"# Pull from another root or a copy of one\n  zero2ai sync --from pi --dry-run\n  zero2ai sync --from D:/backups/agent --dry-run",
		"# Overwrite a locally edited models.yml\n  zero2ai sync --force --models",
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(Sync);
		await initTheme();
		const selected = SYNC_GROUPS.filter(group => flags[group] === true);
		const code = await runSyncCommand({
			...(flags.from ? { from: flags.from } : {}),
			...(flags["dry-run"] ? { dryRun: true } : {}),
			...(flags.force ? { force: true } : {}),
			...(flags.yes ? { yes: true } : {}),
			...(flags.json ? { json: true } : {}),
			...(selected.length > 0 ? { groups: selected } : {}),
		});
		process.exitCode = code;
	}
}
