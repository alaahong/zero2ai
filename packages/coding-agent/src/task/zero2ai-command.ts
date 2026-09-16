import process from "node:process";

import { $env } from "@zero2ai/utils";

interface Zero2AiCommand {
	cmd: string;
	args: string[];
	shell: boolean;
}

const DEFAULT_CMD = process.platform === "win32" ? "zero2ai.cmd" : "zero2ai";
const DEFAULT_SHELL = process.platform === "win32";

export function resolveOmpCommand(): Zero2AiCommand {
	const envCmd = $env.ZERO2AI_SUBPROCESS_CMD;
	if (envCmd?.trim()) {
		return { cmd: envCmd, args: [], shell: DEFAULT_SHELL };
	}

	const entry = process.argv[1];
	if (entry && (entry.endsWith(".ts") || entry.endsWith(".js"))) {
		return { cmd: process.execPath, args: [entry], shell: false };
	}

	return { cmd: DEFAULT_CMD, args: [], shell: DEFAULT_SHELL };
}
