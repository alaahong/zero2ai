/**
 * Show what the read tool will return for a path, URL, or internal URI.
 */

import { Args, Command } from "@zero2ai/utils/cli";
import { readHelp as commandHelp } from "../cli/command-help";
import { type ReadCommandArgs, runReadCommand } from "../cli/read-cli";
import { initTheme } from "../modes/theme/theme";

export default class Read extends Command {
	static description = commandHelp.description;
	static args = {
		path: Args.string({
			description:
				"Path, URL, or internal URI to read (append :sel for line ranges or raw mode, e.g. src/foo.ts:50-100)",
			required: true,
		}),
	};

	static examples = [
		"zero2ai read src/foo.ts",
		"zero2ai read src/foo.ts:50-100",
		"zero2ai read src/foo.ts:raw",
		"zero2ai read https://example.com",
		"zero2ai read zero2ai://",
		"zero2ai read issue://123",
		"zero2ai read path/to/archive.zip:dir/file.ts",
		"zero2ai read path/to/db.sqlite:users:42",
	];

	async run(): Promise<void> {
		const { args } = await this.parse(Read);
		const cmd: ReadCommandArgs = {
			path: args.path ?? "",
		};
		await initTheme();
		await runReadCommand(cmd);
	}
}
