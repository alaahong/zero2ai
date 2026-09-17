/**
 * `zero2ai sdlc-web` — the engineering lifecycle workspace, browser-first.
 *
 * Same engine, same flag set and the same per-project workspace as
 * `zero2ai esdlc` (and its `sdlc` shortcut); this entrypoint only flips which
 * surface the workspace opens on, so nobody has to remember `--web`.
 */
import { sdlcWebHelp as commandHelp } from "../cli/command-help";
import Esdlc from "./esdlc";

export default class SdlcWeb extends Esdlc {
	static override description = commandHelp.description;

	static override examples = [
		"# Open the workspace in a browser (loopback only)\n  zero2ai sdlc-web",
		"# Point the workspace at another project\n  zero2ai sdlc-web --dir D:/work/corp-service",
		"# Serve the workspace in Chinese or English\n  zero2ai sdlc-web --lang zh",
		"# Pick the port (default 3848)\n  zero2ai sdlc-web --port 4000",
	];

	override webByDefault = true;
}
