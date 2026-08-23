import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

const STATUS_KEY = "ducky";
const STATE_ENTRY = "ducky-state";

type Decision =
	| { action: "approve"; note?: string }
	| { action: "deny"; feedback?: string }
	| { action: "cancel"; feedback?: string };

interface DuckyState {
	enabled?: boolean;
}

interface EditReplacement {
	oldText?: string;
	newText?: string;
}

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

function restoreEnabled(ctx: ExtensionContext, fallback: boolean): boolean {
	const entries = ctx.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as { type?: string; customType?: string; data?: DuckyState };
		if (entry.type === "custom" && entry.customType === STATE_ENTRY && typeof entry.data?.enabled === "boolean") {
			return entry.data.enabled;
		}
	}
	return fallback;
}

function setStatus(ctx: ExtensionContext, enabled: boolean): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, enabled ? ctx.ui.theme.fg("accent", "🦆 approval") : undefined);
}

function persist(pi: ExtensionAPI, enabled: boolean): void {
	pi.appendEntry(STATE_ENTRY, { enabled, timestamp: Date.now() });
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
	let enabled = true;

	function applyEnabled(ctx: ExtensionContext, value: boolean): void {
		enabled = value;
		persist(pi, enabled);
		setStatus(ctx, enabled);
		ctx.ui.notify(`Ducky approval ${enabled ? "enabled" : "disabled"}.`, "info");
	}

	function toggleEnabled(ctx: ExtensionContext): void {
		applyEnabled(ctx, !enabled);
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
			if (!enabled) {
				return {
					content: [{ type: "text", text: "Ducky is disabled. Continue with your best judgment." }],
					details: { enabled: false },
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
		description: "Toggle or inspect Ducky edit approval (/ducky on|off|status)",
		handler: async (args, ctx) => {
			const mode = args.trim().toLowerCase();
			if (mode === "off" || mode === "disable" || mode === "disabled") applyEnabled(ctx, false);
			else if (mode === "on" || mode === "enable" || mode === "enabled") applyEnabled(ctx, true);
			else if (mode === "status" || mode === "") {
				ctx.ui.notify(`Ducky approval is ${enabled ? "on" : "off"}.`, "info");
				setStatus(ctx, enabled);
			} else {
				ctx.ui.notify("Usage: /ducky [on|off|status]", "warning");
			}
		},
	});

	pi.registerShortcut("f6", {
		description: "Toggle Ducky approval mode",
		handler: async (ctx) => toggleEnabled(ctx),
	});

	pi.on("session_start", async (_event, ctx) => {
		enabled = restoreEnabled(ctx, enabled);
		setStatus(ctx, enabled);
	});

	pi.on("before_agent_start", async (event) => {
		if (!enabled) return;
		return {
			systemPrompt:
				event.systemPrompt +
				"\n\n[DUCKY ACTIVE] The user wants to stay actively at the wheel. Prefer small, digestible edit/write calls. Group closely related changes, but avoid large sweeping rewrites unless explicitly requested. If an edit is denied, use the user's feedback from the blocked tool result to revise the next attempt. Never use Python or other scripts as a workaround when the user rejects proposed changes. Instead, work through the changes with the user. Don't include code comments; instead use good design to make the code self-explanatory. When you are unsure about what the user wants or you are weighing a meaningful design decision, do not silently decide in your thinking. Pause and call ducky_ask_user with a concise question, short context, and concrete options when possible. Examples of when to ask: choosing CDN vs npm dependency, picking an architecture, deciding whether to preserve backward compatibility, changing user-facing behavior, or interpreting vague requirements.",
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled) return;
		if (event.toolName !== "edit" && event.toolName !== "write") return;

		const digest = buildDigest(ctx.cwd, event.toolName, event.input);
		if (!digest) return;

		const decision = await askForApproval(ctx, event.toolName, digest);
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
