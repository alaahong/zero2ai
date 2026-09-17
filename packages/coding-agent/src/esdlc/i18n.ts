/**
 * ESDLC interface strings.
 *
 * The workspace runs inside banks and other regulated shops where the operator language is a
 * deployment decision, not a constant, so every user-facing string lives here twice. Engine
 * *document* content (BRD/FSD bodies, artifact file names) is deliberately not localized: those
 * are the deliverables the phase prompts define.
 *
 * Phase *labels* (`REQUIREMENTS`, `BUILD`, …) stay canonical in every locale — they are the
 * fixed ESDLC stage names people cite in tickets and audits.
 */
export const ESDLC_LOCALES = ["zh", "en"] as const;

export type EsdlcLocale = (typeof ESDLC_LOCALES)[number];

const EN = {
	"status.pending": "PENDING",
	"status.running": "RUNNING",
	"status.completed": "COMPLETED",
	"status.failed": "FAILED",
	"status.awaitingInput": "AWAITING-INPUT",
	"status.pendingLong": "pending",
	"status.runningLong": "running",
	"status.completedLong": "completed",
	"status.failedLong": "failed",
	"status.awaitingInputLong": "waiting for a human answer",

	"phase.requirements.title": "Requirements — capture discussion, transcribe with ASR",
	"phase.analysis.title": "Analysis & Design — BRD / FSD from the requirements",
	"phase.build.title": "Build — prompt-driven implementation with a change preview",
	"phase.test.title": "Test — run the suite and summarise quality",
	"phase.deploy.title": "Deploy — deployment documentation for the build",
	"phase.release.title": "Release — project-level release documentation",

	"cli.project": "project",
	"cli.hint": 'run a phase:  zero2ai esdlc run <phase> [--input <file>] [--prompt "<text>"] [--model <id>]',
	"cli.askHuman": "Human confirmation needed",
	"screen.keys": "up/down select · Enter run · r refresh · q quit",
	"screen.enterToRun": "Enter to run · Esc to cancel",
	"cli.runningPhase": "running phase: {phase}",
	"cli.phaseResult": "phase {phase}: {status}",
	"cli.artifact": "artifact",
	"cli.unknownAction": 'unknown action "{action}"; expected one of: status, run',
	"cli.phaseRequired": "phase is required and must be one of: {phases}",
	"home.projectDir": "Project",
	"home.labelSeparator": ": ",
	"calls.thinkingChars": "{count} thinking",
	"home.configRoot": "Config root",
	"home.models": "{count} bound model(s)",
	"home.model": "Model",
	"home.defaultModel": "Default (commit → smol → any bound)",
	"home.notes": "Notes",
	"home.notesUnset": "not set",
	"home.notesSet": "{count} char(s)",
	"home.refresh": "Refresh",
	"home.save": "Save",
	"home.cancel": "Cancel",
	"home.edit": "Edit",
	"home.rendered": "Rendered",
	"home.source": "Source",
	"home.renderedView": "rendered view",
	"home.editing": "editing",
	"home.unsaved": "unsaved",
	"home.language": "Language",

	"nav.tree": "Artifacts",
	"tabs.active": "active",
	"phases.select": "Select a stage",

	"phase.artifact": "Artifacts",
	"phase.run": "Run",
	"phase.rerun": "Re-run",
	"phase.requirementsInput": "Discussion notes (or pass a recording/transcript with --input)",
	"phase.changedFiles": "Files this build changed",
	"phase.noArtifacts": "This stage has produced no artifacts yet.",

	"calls.title": "Execution detail (model calls)",
	"calls.empty":
		"{phase} made no model calls. Running an analysis, deploy or release stage lists every call with its model, duration, tokens, prompt, reasoning and output.",
	"calls.time": "Time",
	"calls.step": "Step",
	"calls.model": "Model",
	"calls.duration": "Duration",
	"calls.tokens": "Tokens",
	"calls.chars": "Chars (prompt → output)",
	"calls.expand": "Expand",
	"calls.collapse": "Collapse",
	"calls.prompt": "Prompt",
	"calls.reasoning": "Reasoning",
	"calls.output": "Output",
	"calls.error": "Error",
	"calls.context": "Context",
	"calls.contextNote": "the call failed; this is the input it read",
	"calls.noThinking": "No reasoning captured (the model or gateway did not return any).",
	"calls.noContent": "This call left no displayable content.",
	"calls.legacy": "Recorded by an older build without prompts or outputs; re-run the stage for the full trail.",
	"calls.readFailed": "read failed: {error}",

	"tree.title": "Project tree",
	"tree.changed": "changed {count}",
	"tree.artifact": "artifact",
	"tree.changedBadge": "changed",
	"tree.truncated": "truncated",
	"tree.expandAll": "Expand all",
	"tree.collapseAll": "Collapse all",
	"tree.preview": "Preview",
	"tree.legend":
		"Click a file to view it; Markdown can switch to the rendered view, and any text file can be edited and saved in place. Changed files carry an orange badge, ESDLC artifacts a grey one.",

	"hitl.title": "Human confirmation needed · {phase}",
	"hitl.submit": "Submit and continue",
	"hitl.placeholder": "Answer here, or submit empty to skip",

	"guard.unsavedSwitch": "The current file has unsaved edits; switching discards them. Continue?",
	"guard.unavailable": "workspace unavailable",
} as const;

export type EsdlcMessageKey = keyof typeof EN;

const ZH: Record<EsdlcMessageKey, string> = {
	"status.pending": "PENDING",
	"status.running": "RUNNING",
	"status.completed": "COMPLETED",
	"status.failed": "FAILED",
	"status.awaitingInput": "AWAITING-INPUT",
	"status.pendingLong": "待运行",
	"status.runningLong": "运行中",
	"status.completedLong": "已完成",
	"status.failedLong": "失败",
	"status.awaitingInputLong": "等待人工确认",

	"phase.requirements.title": "需求 — 采集讨论，可用 ASR 转写",
	"phase.analysis.title": "分析与设计 — 由需求产出 BRD / FSD",
	"phase.build.title": "构建 — 提示词驱动实现，并记录变更预览",
	"phase.test.title": "测试 — 运行测试套件并总结质量",
	"phase.deploy.title": "部署 — 针对本次构建的部署文档",
	"phase.release.title": "发布 — 项目级发布文档",

	"cli.project": "项目目录",
	"cli.hint": '运行阶段：  zero2ai esdlc run <phase> [--input <文件>] [--prompt "<文本>"] [--model <id>]',
	"cli.askHuman": "需要人工确认",
	"screen.keys": "↑↓ 选择 · Enter 运行 · r 刷新 · q 退出",
	"screen.enterToRun": "Enter 运行 · Esc 取消",
	"cli.runningPhase": "正在运行阶段：{phase}",
	"cli.phaseResult": "阶段 {phase}：{status}",
	"cli.artifact": "产物",
	"cli.unknownAction": '未知动作 "{action}"；应为：status、run 之一',
	"cli.phaseRequired": "必须指定阶段，且为以下之一：{phases}",
	"home.projectDir": "项目目录",
	"home.labelSeparator": "：",
	"calls.thinkingChars": "思考 {count} 字",
	"home.configRoot": "配置根",
	"home.models": "{count} 个已绑定模型",
	"home.model": "模型",
	"home.defaultModel": "默认（commit → smol → 任一已绑定）",
	"home.notes": "补充说明",
	"home.notesUnset": "未设置",
	"home.notesSet": "已设置（{count} 字）",
	"home.refresh": "刷新",
	"home.save": "保存",
	"home.cancel": "取消",
	"home.edit": "编辑",
	"home.rendered": "渲染",
	"home.source": "源码",
	"home.renderedView": "渲染视图",
	"home.editing": "编辑中",
	"home.unsaved": "未保存",
	"home.language": "语言",

	"nav.tree": "产物树",
	"tabs.active": "当前",
	"phases.select": "选择一个阶段",

	"phase.artifact": "产物",
	"phase.run": "运行",
	"phase.rerun": "重新运行",
	"phase.requirementsInput": "讨论要点（或用 --input 传入录音/转写文本）",
	"phase.changedFiles": "本次构建改动的文件",
	"phase.noArtifacts": "该阶段尚未产出任何产物。",

	"calls.title": "执行细节（模型调用）",
	"calls.empty":
		"{phase} 阶段没有模型调用记录。运行分析、部署、发布类阶段后，这里会列出每次调用的模型、耗时、token，以及提示词、模型思考与实际输出。",
	"calls.time": "时间",
	"calls.step": "环节",
	"calls.model": "模型",
	"calls.duration": "耗时",
	"calls.tokens": "tokens",
	"calls.chars": "字数（提示 → 输出）",
	"calls.expand": "展开",
	"calls.collapse": "收起",
	"calls.prompt": "提示词",
	"calls.reasoning": "思考过程",
	"calls.output": "输出",
	"calls.error": "错误",
	"calls.context": "上下文",
	"calls.contextNote": "调用失败，以下是它读到的输入",
	"calls.noThinking": "未捕获到思考过程（该模型或网关未返回 reasoning）。",
	"calls.noContent": "本次调用没有留下可展示的内容。",
	"calls.legacy": "该记录来自旧版本，未保存提示词/输出全文；重新运行该阶段即可获得完整过程。",
	"calls.readFailed": "读取失败：{error}",

	"tree.title": "项目文件树",
	"tree.changed": "改动 {count}",
	"tree.artifact": "产物",
	"tree.changedBadge": "改动",
	"tree.truncated": "已截断",
	"tree.expandAll": "展开全部",
	"tree.collapseAll": "折叠全部",
	"tree.preview": "预览",
	"tree.legend":
		"点击文件查看内容；Markdown 可切渲染视图，任何文本文件都可直接编辑保存。改动文件带橙色标记，ESDLC 产物带灰色标记。",

	"hitl.title": "需要人工确认 · {phase}",
	"hitl.submit": "提交并继续",
	"hitl.placeholder": "在此补充说明后提交；留空提交表示跳过",

	"guard.unsavedSwitch": "当前文件有未保存的修改，切换将丢弃它们。继续？",
	"guard.unavailable": "工作区不可用",
};

const CATALOGS: Readonly<Record<EsdlcLocale, Record<EsdlcMessageKey, string>>> = { en: EN, zh: ZH };

/** Default when neither the caller nor the environment expresses a preference. */
const DEFAULT_LOCALE: EsdlcLocale = "en";

export function isEsdlcLocale(value: unknown): value is EsdlcLocale {
	return typeof value === "string" && (ESDLC_LOCALES as readonly string[]).includes(value);
}

/**
 * Pick the interface language.
 *
 * Precedence: an explicit `--lang` beats the workspace's stored choice, which beats the
 * environment; anything unrecognized (including `zh_CN.UTF-8`, `en-GB`) matches by prefix.
 */
export function resolveEsdlcLocale(input: {
	readonly explicit?: string | null;
	readonly stored?: string | null;
	readonly env?: Readonly<Record<string, string | undefined>>;
}): EsdlcLocale {
	for (const candidate of [input.explicit, input.stored]) {
		if (isEsdlcLocale(candidate)) return candidate;
	}
	const env = input.env ?? {};
	for (const name of ["ZERO2AI_LANG", "LC_ALL", "LC_MESSAGES", "LANG"]) {
		const value = env[name]?.trim().toLowerCase();
		if (!value) continue;
		const prefix = value.split(/[_.\-@]/)[0];
		if (isEsdlcLocale(prefix)) return prefix;
	}
	return DEFAULT_LOCALE;
}

/** The whole catalog, for injecting into a UI that switches language without a reload. */
export function esdlcCatalogs(): Readonly<Record<EsdlcLocale, Record<EsdlcMessageKey, string>>> {
	return CATALOGS;
}

export function esdlcMessages(locale: EsdlcLocale): Record<EsdlcMessageKey, string> {
	return CATALOGS[locale];
}

/** Translate, substituting `{name}` placeholders. */
export function tEsdlc(
	locale: EsdlcLocale,
	key: EsdlcMessageKey,
	params: Readonly<Record<string, string | number>> = {},
): string {
	const template = CATALOGS[locale][key] ?? EN[key] ?? key;
	return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}
