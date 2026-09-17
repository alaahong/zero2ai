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

	"flow.title": "Flow",
	"flow.summary": "{done}/{total} stages completed · {blocked} blocked",
	"flow.current": "current: {phase}",
	"flow.elapsed": "elapsed {duration}",
	"flow.timeline": "Timeline",
	"flow.artifacts": "{count} artifact(s)",
	"flow.hint": "Click a stage to open its detail; the diagram follows the live state.",
	"flow.notStarted": "not started",

	"config.specsTitle": "Spec & skill sources",
	"config.specsHelp":
		"One per line: an http(s) URL or a path inside the project (a file, or a directory of .md/.yml files). Loaded into the analysis prompts; each run records what it loaded in specs-loaded.md.",
	"config.scaffoldTitle": "Build scaffold",
	"config.scaffoldCommand": "Command that creates the skeleton (runs before the agent)",
	"config.scaffoldTemplate": "Template directory copied into the project (never overwrites existing files)",
	"config.saved": "saved",
	"config.empty": "(none configured)",

	"quality.title": "Code quality",
	"quality.score": "Score {score}/100",
	"quality.weights": "weights: {weights}",
	"quality.signal": "Signal",
	"quality.result": "Result",
	"quality.counts": "{passed} passed, {failed} failed",
	"quality.details": "Details",
	"quality.coverage": "coverage {percent}%",
	"quality.notMeasured": "not measured",
	"quality.passed": "passed",
	"quality.failed": "failed",
	"quality.history": "Score history ({count} run(s))",
	"quality.empty": "No quality report yet — run the test stage.",

	"facts.title": "Deployment facts (evidence)",
	"facts.configs": "Deployment configuration",
	"facts.scripts": "Scripts",
	"facts.env": "Environment variables read by the source",
	"facts.ports": "Ports referenced",
	"facts.entrypoints": "Entrypoints",
	"facts.evidence": "Evidence index",
	"facts.empty": "No facts report yet — run the deploy stage.",

	"scaffold.title": "Scaffold pre-step",
	"scaffold.templateLabel": "Template",
	"scaffold.commandLabel": "Command",
	"scaffold.created": "{count} file(s) created",
	"scaffold.none": "No scaffold has run for this build.",
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

	"flow.title": "流程",
	"flow.summary": "已完成 {done}/{total} 个阶段 · 异常 {blocked}",
	"flow.current": "当前：{phase}",
	"flow.elapsed": "已用 {duration}",
	"flow.timeline": "时间线",
	"flow.artifacts": "{count} 个产物",
	"flow.hint": "点击阶段节点可直接进入该阶段明细；图示随状态实时更新。",
	"flow.notStarted": "未开始",

	"config.specsTitle": "规范 / 技能来源",
	"config.specsHelp":
		"每行一条：http(s) 地址，或项目内路径（文件，或含 .md/.yml 的目录）。会注入到分析与设计提示词；每次运行都会把实际加载内容记录在 specs-loaded.md。",
	"config.scaffoldTitle": "构建脚手架",
	"config.scaffoldCommand": "生成骨架的命令（在 agent 之前执行）",
	"config.scaffoldTemplate": "复制进项目的模板目录（不覆盖已有文件）",
	"config.saved": "已保存",
	"config.empty": "（未配置）",

	"quality.title": "代码质量",
	"quality.score": "得分 {score}/100",
	"quality.weights": "权重：{weights}",
	"quality.signal": "信号",
	"quality.result": "结果",
	"quality.counts": "{passed} 通过，{failed} 失败",
	"quality.details": "明细",
	"quality.coverage": "覆盖率 {percent}%",
	"quality.notMeasured": "未测量",
	"quality.passed": "通过",
	"quality.failed": "失败",
	"quality.history": "得分历史（{count} 次运行）",
	"quality.empty": "尚无质量报告——先运行测试阶段。",

	"facts.title": "部署事实（证据）",
	"facts.configs": "部署配置",
	"facts.scripts": "脚本",
	"facts.env": "源码读取的环境变量",
	"facts.ports": "涉及的端口",
	"facts.entrypoints": "入口",
	"facts.evidence": "证据索引",
	"facts.empty": "尚无事实报告——先运行部署阶段。",

	"scaffold.title": "脚手架前置步骤",
	"scaffold.templateLabel": "模板",
	"scaffold.commandLabel": "命令",
	"scaffold.created": "新建 {count} 个文件",
	"scaffold.none": "本次构建未使用脚手架。",
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
