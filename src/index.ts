import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

const STATUS_KEY = "ducky";
const STATE_ENTRY = "ducky-state";

type Decision =
	| { action: "approve"; note?: string }
	| { action: "deny"; feedback?: string }
	| { action: "cancel"; feedback?: string };

type ApprovalMode = "off" | "edits" | "safe";

interface DuckyState {
	enabled?: boolean;
	mode?: ApprovalMode;
}

interface EditReplacement {
	oldText?: string;
	newText?: string;
}

interface DuckySettings {
	ducky?: {
		mode?: unknown;
		safeCommands?: unknown;
	};
	duckySafeCommands?: unknown;
}

const defaultSafeCommands = [
	"pwd",
	"cd",
	"ls",
	"tree",
	"find",
	"fd",
	"rg",
	"grep",
	"sort",
	"sed",
	"cut",
	"uniq",
	"git status",
	"git diff",
	"git log",
	"git show",
	"git branch",
	"git rev-parse",
	"git ls-files",
	"git grep",
	"cat",
	"head",
	"tail",
	"wc",
	"stat",
	"file",
	"du",
	"df",
] as const;

const forbiddenSafeCommandTokens = /(^|\s)(-delete|-exec|-execdir|-i|-i\.\S+|--in-place)(\s|$)/;

const askUserSchema = Type.Object({
	question: Type.String({
		description: "The specific decision, requirement, or ambiguity to ask the user about.",
	}),
	context: Type.Optional(
		Type.String({
			description: "Brief context explaining why this matters and what tradeoff you are considering.",
		}),
	),
	options: Type.Optional(
		Type.Array(Type.String(), {
			description: "Optional concrete choices the user can pick from. Keep choices short and distinct.",
		}),
	),
});

type AskUserInput = {
	question: string;
	context?: string;
	options?: string[];
};

function isApprovalMode(value: unknown): value is ApprovalMode {
	return value === "off" || value === "edits" || value === "safe";
}

function settingsPath(): string {
	return path.join(getAgentDir(), "settings.json");
}

function readDuckySettings(): DuckySettings {
	try {
		return JSON.parse(fs.readFileSync(settingsPath(), "utf8")) as DuckySettings;
	} catch {
		return {};
	}
}

function restoreMode(ctx: ExtensionContext, fallback: ApprovalMode): ApprovalMode {
	const settingsMode = readDuckySettings().ducky?.mode;
	if (isApprovalMode(settingsMode)) return settingsMode;

	const entries = ctx.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as { type?: string; customType?: string; data?: DuckyState };
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
		if (isApprovalMode(entry.data?.mode)) return entry.data.mode;
		if (typeof entry.data?.enabled === "boolean") return entry.data.enabled ? "edits" : "off";
	}
	return fallback;
}

function modeLabel(mode: ApprovalMode): string {
	if (mode === "edits") return "approve edits";
	if (mode === "safe") return "approve edits & commands";
	return "approval off";
}

function statusLabel(mode: ApprovalMode): string {
	if (mode === "edits") return "edits";
	if (mode === "safe") return "safe";
	return "off";
}

function setStatus(ctx: ExtensionContext, mode: ApprovalMode): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, mode === "off" ? undefined : ctx.ui.theme.fg("accent", `🦆 ${statusLabel(mode)}`));
}

function persist(pi: ExtensionAPI, mode: ApprovalMode): void {
	pi.appendEntry(STATE_ENTRY, { mode, enabled: mode !== "off", timestamp: Date.now() });
	const settings = readDuckySettings();
	settings.ducky = { ...settings.ducky, mode };
	fs.mkdirSync(getAgentDir(), { recursive: true });
	fs.writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`);
}

function lineCount(text: string): number {
	if (text.length === 0) return 0;
	return text.split(/\r?\n/).length;
}

function formatBlock(label: string, text: string, sign: "-" | "+"): string[] {
	const lines = text.split(/\r?\n/);
	const output = [`${sign} ${label} (${lineCount(text)} lines, ${text.length} chars)`];
	for (const line of lines) output.push(`${sign} ${line}`);
	return output;
}

function summarizeReplacement(edit: EditReplacement, index: number): string {
	const oldText = String(edit.oldText ?? "");
	const newText = String(edit.newText ?? "");
	return [
		`Change ${index + 1}: replace ${lineCount(oldText)} line(s) with ${lineCount(newText)} line(s)`,
		...formatBlock("old", oldText, "-"),
		...formatBlock("new", newText, "+"),
	].join("\n");
}

function summarizeWrite(cwd: string, filePath: string, content: string): string {
	const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
	const exists = fs.existsSync(absolute);
	const action = exists ? "Overwrite file" : "Create file";
	let previous = "";
	if (exists) {
		try {
			previous = fs.readFileSync(absolute, "utf8");
		} catch {
			previous = "";
		}
	}

	const parts = [
		`${action}: ${filePath}`,
		`New content: ${lineCount(content)} lines, ${content.length} chars`,
	];
	if (exists) parts.push(`Existing content: ${lineCount(previous)} lines, ${previous.length} chars`);
	parts.push(...formatBlock("new", content, "+"));
	return parts.join("\n");
}

function summarizeCommand(input: any): string {
	const command = String(input?.command ?? "");
	const timeout = input?.timeout === undefined ? undefined : String(input.timeout);
	return [
		"Command",
		timeout ? `Timeout: ${timeout}s` : undefined,
		...formatBlock("command", command, "+"),
	].filter((line): line is string => line !== undefined).join("\n");
}

function normalizeCommand(command: string): string {
	return command.trim().replace(/\s+/g, " ");
}

function extractSafeCommands(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((command): command is string => typeof command === "string")
		.map(normalizeCommand)
		.filter(Boolean);
}

function loadConfiguredSafeCommands(): string[] {
	try {
		const settings = readDuckySettings();
		return [
			...extractSafeCommands(settings.ducky?.safeCommands),
			...extractSafeCommands(settings.duckySafeCommands),
		];
	} catch {
		return [];
	}
}

function commandMatchesPattern(command: string, pattern: string): boolean {
	return command === pattern || command.startsWith(`${pattern} `);
}

function isSafeCommandPart(command: string, safeCommands: readonly string[]): boolean {
	const normalized = normalizeCommand(command);
	if (!normalized) return true;
	if (forbiddenSafeCommandTokens.test(normalized)) return false;
	return safeCommands.some((safeCommand) => commandMatchesPattern(normalized, safeCommand));
}

function splitCommandParts(command: string): string[] | undefined {
	const parts: string[] = [];
	let start = 0;
	let quote: "'" | '"' | undefined;
	let escaped = false;

	for (let index = 0; index < command.length; index++) {
		const char = command[index];
		const next = command[index + 1];

		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			else if (quote !== "'" && (char === "`" || (char === "$" && next === "("))) return undefined;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (char === "`" || (char === "$" && next === "(") || char === ";" || char === "<" || char === ">") return undefined;
		if (char === "|") {
			parts.push(command.slice(start, index));
			start = index + 1;
			continue;
		}
		if (char === "&") {
			if (next !== "&") return undefined;
			parts.push(command.slice(start, index));
			index++;
			start = index + 1;
		}
	}

	if (quote) return undefined;
	parts.push(command.slice(start));
	return parts;
}

function isSafeCommand(input: any): boolean {
	const command = String(input?.command ?? "");
	const safeCommands = [...defaultSafeCommands, ...loadConfiguredSafeCommands()];

	return command.split(/\n+/).every((line) => {
		const parts = splitCommandParts(line);
		return parts !== undefined && parts.every((part) => isSafeCommandPart(part, safeCommands));
	});
}

function buildDigest(cwd: string, toolName: string, input: any): string | undefined {
	if (toolName === "edit") {
		const filePath = String(input?.path ?? input?.file_path ?? "unknown");
		const edits = Array.isArray(input?.edits) ? (input.edits as EditReplacement[]) : [];
		if (edits.length === 0) return `Edit file: ${filePath}\n(no edits array found)`;
		const shown = edits.map(summarizeReplacement).join("\n\n");
		return `Edit file: ${filePath}\nReplacement count: ${edits.length}\n\n${shown}`;
	}

	if (toolName === "write") {
		const filePath = String(input?.path ?? input?.file_path ?? "unknown");
		const content = String(input?.content ?? "");
		return summarizeWrite(cwd, filePath, content);
	}

	if (toolName === "bash") return summarizeCommand(input);

	return undefined;
}

function parseDecision(raw: string | undefined): Decision {
	const text = raw?.trim() ?? "";
	if (!text) return { action: "cancel" };

	const match = text.match(/^(yes|y|yay|approve|approved|ok|okay|no|n|nay|deny|denied|reject|rejected)\b[\s:,.!-]*/i);
	if (!match) {
		return {
			action: "deny",
			feedback: `User did not approve. Treat this as feedback instead: ${text}`,
		};
	}

	const verb = match[1]!.toLowerCase();
	const rest = text.slice(match[0].length).trim();
	if (["yes", "y", "yay", "approve", "approved", "ok", "okay"].includes(verb)) {
		return { action: "approve", note: rest || undefined };
	}
	return { action: "deny", feedback: rest || undefined };
}

function parseApprovalDocument(raw: string | undefined): Decision {
	const text = raw ?? "";
	const feedbackLines = [...text.matchAll(/^Your feedback:\s*(.*)$/gim)];
	const feedback = feedbackLines.at(-1)?.[1]?.trim();
	if (feedback !== undefined) return feedback.length === 0 ? { action: "approve" } : parseDecision(feedback);

	// Backward-compatible fallback for old review buffers.
	const answerLines = [...text.matchAll(/^ANSWER:\s*(.*)$/gim)];
	const answer = answerLines.at(-1)?.[1]?.trim();
	if (answer !== undefined) return parseDecision(answer);
	return parseDecision(text);
}

function approvalSummary(digest: string): string {
	const lines = digest.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const headline = lines[0] ?? "Review proposed change";
	const detail = lines[1]?.match(/^(Replacement count:|New content:|Existing content:)/) ? lines[1] : undefined;
	return detail ? `${headline} (${detail})` : headline;
}

function truncateForModel(text: string, maxChars = 12000): string {
	if (text.length <= maxChars) return text;
	const head = Math.floor(maxChars * 0.65);
	const tail = maxChars - head - 80;
	return `${text.slice(0, head)}\n… ${text.length - head - tail} chars omitted from explanation prompt only …\n${text.slice(-tail)}`;
}

function assistantText(message: { content?: Array<{ type?: string; text?: string }> }): string {
	return (message.content ?? [])
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

function cleanExplanation(text: string, fallback: string): string {
	const cleaned = text
		.replace(/^Ducky wants to make the following change:\s*/i, "")
		.replace(/^This change\s+/i, "")
		.replace(/["`]/g, "")
		.trim();
	if (!cleaned) return fallback;
	return cleaned.length > 180 ? `${cleaned.slice(0, 177).trimEnd()}…` : cleaned;
}

async function explainChange(ctx: ExtensionContext, toolName: string, digest: string): Promise<string> {
	const fallback = approvalSummary(digest);
	if (!ctx.model) return fallback;

	try {
		const message = await ctx.modelRegistry.complete(
			ctx.model as any,
			{
				systemPrompt:
					"You explain proposed code edits for user approval. Return one short, plain-English sentence under 25 words. Do not say approve, deny, yes, or no.",
				messages: [
					{
						role: "user",
						content: `Tool: ${toolName}\n\nProposed change digest:\n${truncateForModel(digest)}`,
						timestamp: Date.now(),
					},
				],
			},
			{ signal: ctx.signal } as any,
		);
		return cleanExplanation(assistantText(message), fallback);
	} catch {
		return fallback;
	}
}

async function askForApproval(ctx: ExtensionContext, toolName: string, digest: string): Promise<Decision> {
	if (!ctx.hasUI) {
		return { action: "deny", feedback: "Ducky requires interactive approval, but this Pi mode has no UI." };
	}

	const explanation = await explainChange(ctx, toolName, digest);
	const reviewDocument = [
		"Ducky wants to make the following change:",
		`🦆 ${explanation}`,
		"",
		"──────────────── proposed change ────────────────",
		digest,
		"──────────────── Yay or nay? Press enter or ask for changes ────────────────────",
		"Your feedback: ",
	].join("\n");

	const reply = await ctx.ui.editor(`🦆 ${explanation}`, reviewDocument);
	return parseApprovalDocument(reply);
}

function commandSummary(digest: string): string {
	const lines = digest.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	return lines[0] ?? "Review command";
}

async function explainCommand(ctx: ExtensionContext, digest: string): Promise<string> {
	const fallback = commandSummary(digest);
	if (!ctx.model) return fallback;

	try {
		const message = await ctx.modelRegistry.complete(
			ctx.model as any,
			{
				systemPrompt:
					"You explain proposed commands for user approval. Return one short, plain-English sentence under 25 words. Do not say approve, deny, yes, or no.",
				messages: [
					{
						role: "user",
						content: `Proposed command digest:\n${truncateForModel(digest)}`,
						timestamp: Date.now(),
					},
				],
			},
			{ signal: ctx.signal } as any,
		);
		return cleanExplanation(assistantText(message), fallback);
	} catch {
		return fallback;
	}
}

async function askForCommandApproval(ctx: ExtensionContext, digest: string): Promise<Decision> {
	if (!ctx.hasUI) {
		return { action: "deny", feedback: "Ducky requires interactive approval, but this Pi mode has no UI." };
	}

	const explanation = await explainCommand(ctx, digest);
	const reviewDocument = [
		"Ducky wants to run the following command:",
		`🦆 ${explanation}`,
		"",
		"──────────────── proposed command ────────────────",
		digest,
		"──────────────── Yay or nay? Press enter or ask for changes ────────────────────",
		"Your feedback: ",
	].join("\n");

	const reply = await ctx.ui.editor(`🦆 ${explanation}`, reviewDocument);
	return parseApprovalDocument(reply);
}

async function askRubberDucky(ctx: ExtensionContext, params: AskUserInput): Promise<string> {
	if (!ctx.hasUI) {
		return "No interactive UI is available. Make the smallest reversible choice, state the assumption clearly, and continue.";
	}

	const options = params.options?.filter((option) => option.trim().length > 0) ?? [];
	const optionLines = options.length > 0 ? options.map((option, index) => `${index + 1}. ${option}`) : [];
	const prompt = [
		"🦆 Rubber Ducky question",
		"",
		params.question.trim(),
		"",
		params.context?.trim() ? "Context:" : undefined,
		params.context?.trim() || undefined,
		optionLines.length > 0 ? "" : undefined,
		optionLines.length > 0 ? "Options:" : undefined,
		...optionLines,
		"",
		"Please answer below. You can pick an option number/name or give more detailed guidance.",
		"ANSWER: ",
	].filter((line): line is string => line !== undefined).join("\n");

	const reply = await ctx.ui.editor("🦆 Ducky design chat", prompt);
	const answerLines = [...(reply ?? "").matchAll(/^ANSWER:\s*(.*)$/gim)];
	const answer = answerLines.at(-1)?.[1]?.trim();
	return answer || reply?.trim() || "No answer provided.";
}

export default function ducky(pi: ExtensionAPI): void {
	let approvalMode: ApprovalMode = "edits";

	function applyMode(ctx: ExtensionContext, nextMode: ApprovalMode): void {
		approvalMode = nextMode;
		persist(pi, approvalMode);
		setStatus(ctx, approvalMode);
		ctx.ui.notify(`Ducky mode: ${modeLabel(approvalMode)}.`, "info");
	}

	function cycleMode(ctx: ExtensionContext): void {
		const nextMode = approvalMode === "off" ? "edits" : approvalMode === "edits" ? "safe" : "off";
		applyMode(ctx, nextMode);
	}

	pi.registerTool({
		name: "ducky_ask_user",
		label: "Ask User",
		description:
			"Ask the user to resolve an ambiguous requirement or design decision before continuing. Use this instead of guessing when the user's preference would materially affect the implementation.",
		promptSnippet: "Ask the user a targeted rubber-ducky question when requirements or design choices are unclear",
		promptGuidelines: [
			"Use ducky_ask_user before choosing between meaningful design alternatives, adding dependencies, changing architecture, inventing missing requirements, or proceeding when you find yourself wondering what the user would prefer.",
			"Keep ducky_ask_user questions specific and easy to answer. Provide 2-4 concrete options when possible, plus a short explanation of the tradeoff.",
			"Do not use ducky_ask_user for trivial implementation details that do not affect user-facing behavior, architecture, dependencies, data loss risk, or maintainability.",
		],
		parameters: askUserSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (approvalMode === "off") {
				return {
					content: [{ type: "text", text: "Ducky is disabled. Continue with your best judgment." }],
					details: { enabled: false, mode: approvalMode },
				};
			}

			const answer = await askRubberDucky(ctx, params as AskUserInput);
			return {
				content: [{ type: "text", text: `User guidance: ${answer}` }],
				details: { answer },
			};
		},
	});

	pi.registerCommand("ducky", {
		description: "Set or inspect Ducky approval mode (/ducky on|off|safe|status)",
		handler: async (args, ctx) => {
			const requestedMode = args.trim().toLowerCase();
			if (requestedMode === "off" || requestedMode === "disable" || requestedMode === "disabled") applyMode(ctx, "off");
			else if (requestedMode === "on" || requestedMode === "enable" || requestedMode === "enabled" || requestedMode === "edits") applyMode(ctx, "edits");
			else if (requestedMode === "safe" || requestedMode === "commands") applyMode(ctx, "safe");
			else if (requestedMode === "status" || requestedMode === "") {
				ctx.ui.notify(`Ducky mode: ${modeLabel(approvalMode)}.`, "info");
				setStatus(ctx, approvalMode);
			} else {
				ctx.ui.notify("Usage: /ducky [on|off|safe|status]", "warning");
			}
		},
	});

	pi.registerShortcut("f6", {
		description: "Cycle Ducky approval mode",
		handler: async (ctx) => cycleMode(ctx),
	});

	pi.on("session_start", async (_event, ctx) => {
		approvalMode = restoreMode(ctx, approvalMode);
		setStatus(ctx, approvalMode);
	});

	pi.on("before_agent_start", async (event) => {
		if (approvalMode === "off") return;
		return {
			systemPrompt:
				event.systemPrompt +
				"\n\n[DUCKY ACTIVE] The user wants to stay actively at the wheel. Prefer small, digestible edit/write calls. Group closely related changes, but avoid large sweeping rewrites unless explicitly requested. If an edit is denied, use the user's feedback from the blocked tool result to revise the next attempt. Never use Python or other scripts as a workaround when the user rejects proposed changes. Instead, work through the changes with the user. Don't include code comments; instead use good design to make the code self-explanatory. When you are unsure about what the user wants or you are weighing a meaningful design decision, do not silently decide in your thinking. Pause and call ducky_ask_user with a concise question, short context, and concrete options when possible. Examples of when to ask: choosing CDN vs npm dependency, picking an architecture, deciding whether to preserve backward compatibility, changing user-facing behavior, or interpreting vague requirements.",
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		if (approvalMode === "off") return;
		if (event.toolName === "bash" && approvalMode !== "safe") return;
		if (event.toolName !== "edit" && event.toolName !== "write" && event.toolName !== "bash") return;
		if (event.toolName === "bash" && isSafeCommand(event.input)) return;

		const digest = buildDigest(ctx.cwd, event.toolName, event.input);
		if (!digest) return;

		const decision = event.toolName === "bash"
			? await askForCommandApproval(ctx, digest)
			: await askForApproval(ctx, event.toolName, digest);
		if (decision.action === "approve") {
			if (decision.note) {
				pi.sendUserMessage(`Ducky approval note for the next step: ${decision.note}`, { deliverAs: "steer" });
			}
			return;
		}

		const feedback = decision.feedback ? ` Feedback: ${decision.feedback}` : "";
		return {
			block: true,
			reason: `Ducky: user did not approve this ${event.toolName} call.${feedback}`,
			terminate: false,
		};
	});
}
