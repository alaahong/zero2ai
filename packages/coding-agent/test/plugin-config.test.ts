import { afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runPluginCommand } from "@zero2ai/coding-agent/cli/plugin-cli";
import { PluginManager } from "@zero2ai/coding-agent/extensibility/plugins/manager";
import { initTheme } from "@zero2ai/coding-agent/modes/theme/theme";
import * as piUtils from "@zero2ai/utils";
import { removeWithRetries } from "@zero2ai/utils";

beforeAll(async () => {
	await initTheme(false);
});

describe("plugin config", () => {
	let tmpRoot: string;
	let pluginsDir: string;
	let lockfile: string;

	beforeEach(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "zero2ai-plugin-config-"));
		pluginsDir = path.join(tmpRoot, "plugins");
		lockfile = path.join(pluginsDir, "zero2ai-plugins.lock.json");

		spyOn(piUtils, "getPluginsDir").mockReturnValue(pluginsDir);
		spyOn(piUtils, "getPluginsLockfile").mockReturnValue(lockfile);
		spyOn(piUtils, "getProjectDir").mockReturnValue(tmpRoot);
		spyOn(piUtils, "getProjectPluginOverridesPath").mockReturnValue(path.join(tmpRoot, "plugin-overrides.json"));
	});

	afterEach(async () => {
		mock.restore();
		await removeWithRetries(tmpRoot);
	});

	async function writeLegacyLockfile(pluginName: string): Promise<void> {
		await Bun.write(
			lockfile,
			JSON.stringify({
				plugins: {
					[pluginName]: { version: "0.2.2", enabledFeatures: null, enabled: true },
				},
			}),
		);
	}

	test("set initializes missing settings in legacy runtime config", async () => {
		const pluginName = "@gaodes/pi-graphify";
		await writeLegacyLockfile(pluginName);

		await new PluginManager(tmpRoot).setPluginSetting(pluginName, "autoContext.enabled", true);

		const lock = await Bun.file(lockfile).json();
		expect(lock.settings[pluginName]).toEqual({ "autoContext.enabled": true });
		expect(lock.plugins[pluginName]).toEqual({ version: "0.2.2", enabledFeatures: null, enabled: true });
	});

	test("list treats missing settings in legacy runtime config as empty", async () => {
		const pluginName = "@gaodes/pi-graphify";
		await writeLegacyLockfile(pluginName);

		await expect(new PluginManager(tmpRoot).getPluginSettings(pluginName)).resolves.toEqual({});
	});

	test("resolves marketplace settings without restoring duplicate list entries", async () => {
		const pluginName = "zero2ai-commit";
		const installPath = path.join(pluginsDir, "cache", pluginName);
		const pluginPath = path.join(pluginsDir, "node_modules", pluginName);
		await Bun.write(
			path.join(installPath, "package.json"),
			JSON.stringify({
				name: pluginName,
				version: "1.0.0",
				zero2ai: {
					version: "1.0.0",
					settings: {
						mainBranchProtection: {
							type: "boolean",
							default: true,
						},
					},
				},
			}),
		);
		await fs.mkdir(path.dirname(pluginPath), { recursive: true });
		await fs.symlink(installPath, pluginPath, "dir");
		await Bun.write(
			path.join(pluginsDir, "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"zero2ai-commit@market": [
						{
							scope: "user",
							installPath,
							version: "1.0.0",
							installedAt: "2026-08-20T00:00:00.000Z",
							lastUpdated: "2026-08-20T00:00:00.000Z",
						},
					],
				},
			}),
		);
		await Bun.write(
			lockfile,
			JSON.stringify({
				plugins: {
					[pluginName]: { version: "1.0.0", enabledFeatures: null, enabled: true },
				},
				settings: {},
			}),
		);

		const manager = new PluginManager(tmpRoot);
		expect(await manager.list()).toEqual([]);
		expect((await manager.getPlugin(pluginName))?.manifest.settings?.mainBranchProtection?.default).toBe(true);

		await manager.setPluginSetting(pluginName, "mainBranchProtection", false);
		expect(await manager.getPluginSettings(pluginName)).toEqual({ mainBranchProtection: false });
	});

	test("updates user marketplace runtime features despite a project shadow while list stays duplicate-free", async () => {
		const pluginName = "zero2ai-featureful";
		const installPath = path.join(pluginsDir, "cache", pluginName);
		const pluginPath = path.join(pluginsDir, "node_modules", pluginName);
		await Bun.write(
			path.join(installPath, "package.json"),
			JSON.stringify({
				name: pluginName,
				version: "1.0.0",
				zero2ai: { version: "1.0.0", features: { review: { description: "Review changes" } } },
			}),
		);
		await fs.mkdir(path.dirname(pluginPath), { recursive: true });
		await fs.symlink(installPath, pluginPath, "dir");
		await Bun.write(
			path.join(pluginsDir, "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"zero2ai-featureful@market": [
						{
							scope: "user",
							installPath,
							version: "1.0.0",
							installedAt: "2026-08-20T00:00:00.000Z",
							lastUpdated: "2026-08-20T00:00:00.000Z",
						},
					],
				},
			}),
		);
		await Bun.write(
			lockfile,
			JSON.stringify({
				plugins: { [pluginName]: { version: "1.0.0", enabledFeatures: null, enabled: true } },
				settings: {},
			}),
		);
		const projectPluginsDir = path.join(tmpRoot, ".zero2ai", "plugins");
		const projectInstallPath = path.join(tmpRoot, "project-cache", pluginName);
		const projectPluginPath = path.join(projectPluginsDir, "node_modules", pluginName);
		await Bun.write(
			path.join(projectInstallPath, "package.json"),
			JSON.stringify({
				name: pluginName,
				version: "2.0.0",
				zero2ai: { version: "2.0.0", features: { projectOnly: { description: "Project-only feature" } } },
			}),
		);
		await fs.mkdir(path.dirname(projectPluginPath), { recursive: true });
		await fs.symlink(projectInstallPath, projectPluginPath, "dir");
		await Bun.write(
			path.join(projectPluginsDir, "zero2ai-plugins.lock.json"),
			JSON.stringify({
				plugins: { [pluginName]: { version: "2.0.0", enabledFeatures: null, enabled: true } },
				settings: {},
			}),
		);

		const manager = new PluginManager(tmpRoot);
		expect(await manager.list()).toEqual([]);
		expect((await manager.getPlugin(pluginName))?.manifest.features).toHaveProperty("projectOnly");

		spyOn(console, "log").mockImplementation(() => {});
		await runPluginCommand({ action: "features", args: [pluginName], flags: { enable: "review", json: true } });
		let lock = await Bun.file(lockfile).json();
		expect(lock.plugins[pluginName].enabledFeatures).toEqual(["review"]);

		await expect(
			runPluginCommand({ action: "features", args: [pluginName], flags: { enable: "projectOnly", json: true } }),
		).rejects.toThrow(/Unknown feature "projectOnly" in zero2ai-featureful/);
		lock = await Bun.file(lockfile).json();
		expect(lock.plugins[pluginName].enabledFeatures).toEqual(["review"]);
	});

	async function writeManifest(dir: string, manifest: Record<string, unknown>): Promise<void> {
		await Bun.write(
			path.join(dir, "package.json"),
			JSON.stringify({ name: "zero2ai-commit", version: "2.0.0", ...manifest }),
		);
	}

	async function installProjectMarketplacePlugin(schemaDefault: string, enabled = true): Promise<string> {
		const installPath = path.join(tmpRoot, "cache", `zero2ai-commit-project-${schemaDefault}`);
		await writeManifest(installPath, {
			zero2ai: {
				version: "2.0.0",
				settings: { splitMode: { type: "enum", values: ["auto", "manual"], default: schemaDefault } },
			},
		});
		const projectRoot = path.join(tmpRoot, ".zero2ai", "plugins");
		await fs.mkdir(path.join(projectRoot, "node_modules"), { recursive: true });
		await fs.symlink(installPath, path.join(projectRoot, "node_modules", "zero2ai-commit"), "dir");
		await Bun.write(
			path.join(projectRoot, "zero2ai-plugins.lock.json"),
			JSON.stringify({
				plugins: { "zero2ai-commit": { version: "2.0.0", enabledFeatures: null, enabled } },
				settings: {},
			}),
		);
		return installPath;
	}

	test("resolves a project-scoped marketplace plugin absent from the user root", async () => {
		await installProjectMarketplacePlugin("auto");

		const manager = new PluginManager(tmpRoot);
		expect(await manager.list()).toEqual([]);
		expect((await manager.getPlugin("zero2ai-commit"))?.manifest.settings?.splitMode?.default).toBe("auto");
	});

	test("prefers the active project plugin over a same-named user install", async () => {
		// User install: same package name, different schema default.
		const userPkg = path.join(pluginsDir, "node_modules", "zero2ai-commit");
		await writeManifest(userPkg, {
			zero2ai: {
				version: "1.0.0",
				settings: { splitMode: { type: "enum", values: ["auto", "manual"], default: "manual" } },
			},
		});
		await Bun.write(
			lockfile,
			JSON.stringify({
				plugins: { "zero2ai-commit": { version: "1.0.0", enabledFeatures: null, enabled: true } },
				settings: {},
			}),
		);
		// Project install shadows it with default "auto".
		await installProjectMarketplacePlugin("auto");

		const manager = new PluginManager(tmpRoot);
		expect((await manager.getPlugin("zero2ai-commit"))?.manifest.settings?.splitMode?.default).toBe("auto");
	});

	test("falls back to an enabled user plugin when the project copy is disabled", async () => {
		const userPkg = path.join(pluginsDir, "node_modules", "zero2ai-commit");
		await writeManifest(userPkg, {
			zero2ai: {
				version: "1.0.0",
				settings: { splitMode: { type: "enum", values: ["auto", "manual"], default: "manual" } },
			},
		});
		await Bun.write(
			lockfile,
			JSON.stringify({
				plugins: { "zero2ai-commit": { version: "1.0.0", enabledFeatures: null, enabled: true } },
				settings: {},
			}),
		);
		await installProjectMarketplacePlugin("auto", false);

		const manager = new PluginManager(tmpRoot);
		expect((await manager.getPlugin("zero2ai-commit"))?.manifest.settings?.splitMode?.default).toBe("manual");
	});
});
