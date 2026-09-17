/**
 * Engineering software development life cycle workspace.
 */

import { Args, Command, Flags } from "@zero2ai/utils/cli";
import { type EsdlcCommandArgs, runEsdlcCommand } from "../cli/esdlc-cli";
import { esdlcHelp as commandHelp } from "../cli/command-help";
import { initTheme } from "../modes/theme/theme";

const ACTIONS = ["status", "run"] as const;

export default class Esdlc extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({ description: "ESDLC action", required: false, options: [...ACTIONS] }),
		phase: Args.string({ description: "Phase to run (requirements|analysis|build|test|deploy|release)" }),
	};

	static flags = {
		input: Flags.string({ description: "Recording or transcript for the requirements phase" }),
		prompt: Flags.string({ description: "Free-form instruction or discussion notes" }),
		model: Flags.string({ description: "Model override for document phases" }),
		command: Flags.string({ description: "Test phase: command to run (default: project test script)" }),
		json: Flags.boolean({ description: "Output JSON (status)" }),
		web: Flags.boolean({ description: "Serve the workspace as a local web UI" }),
		port: Flags.integer({ description: "Web UI port (default 3848)" }),
	};

	static examples = [
		"# Open the workspace in a browser (loopback only)\n  zero2ai esdlc --web",
		"# Show the workspace status\n  zero2ai esdlc",
		"# Capture a discussion recording (ASR) or an existing transcript\n  zero2ai esdlc run requirements --input ./meeting.m4a",
		"# Capture notes without audio\n  zero2ai esdlc run requirements --prompt \"row-level reconciliation scope\"",
		"# Generate BRD + FSD from the captured requirements\n  zero2ai esdlc run analysis",
		"# Run the project test suite and summarise it\n  zero2ai esdlc run test --command \"bun run test\"",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Esdlc);
		await initTheme();
		const code = await runEsdlcCommand({
			action: args.action,
			...(args.phase ? { phase: args.phase } : {}),
			...(flags.input ? { input: flags.input } : {}),
			...(flags.prompt ? { prompt: flags.prompt } : {}),
			...(flags.model ? { model: flags.model } : {}),
			...(flags.command ? { command: flags.command } : {}),
			...(flags.json ? { json: true } : {}),
			...(flags.web ? { web: true } : {}),
			...(flags.port ? { port: flags.port } : {}),
		});
		process.exitCode = code;
	}
}
