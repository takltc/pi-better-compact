/**
 * DP-based Compaction Extension for pi
 *
 * Replaces the default compaction trigger logic with a cache-aware DP economic model
 * inspired by bash-agent's compact_dp.awk.
 *
 * Core idea: enumerate candidate keep-counts k, compute 5-term net benefit for each,
 * and only compact if the best benefit is positive. The cut point is aligned to user
 * message boundaries.
 *
 * Usage:
 *   1. Copy this file to your pi extensions directory:
 *      mkdir -p ~/.pi/agent/extensions && cp src/dp-compact.ts ~/.pi/agent/extensions/
 *   2. Disable built-in auto-compact in settings.json:
 *      { "compaction": { "enabled": false } }
 *   3. The extension will auto-trigger compaction via agent_end when worth it.
 *   4. You can still manually trigger with /compact.
 */

import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	convertToLlm,
	serializeConversation,
	estimateTokens,
} from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

// ============================================================================
// DP Parameters (tunable via environment variables)
// ============================================================================

const DP = {
	P_INPUT: Number(process.env.DP_P_INPUT ?? 3.0),
	P_CACHE: Number(process.env.DP_P_CACHE ?? 0.3),
	P_OUT: Number(process.env.DP_P_OUT ?? 15.0),
	V: Number(process.env.DP_V ?? 5000),
	S: Number(process.env.DP_S ?? 500),
	L: Number(process.env.DP_L ?? 0),
	BASELINE_E: Number(process.env.DP_BASELINE_E ?? 8),
	E_FIXED: Number(process.env.DP_E_FIXED ?? 0),
	R: Number(process.env.DP_R ?? 0.8),
	BETA: Number(process.env.DP_BETA ?? 0.03),
	QUALITY_PENALTY: Number(process.env.DP_QUALITY_PENALTY ?? 0.2),
	MIN_KEEP_RATIO: Number(process.env.DP_MIN_KEEP_RATIO ?? 0.12),
	FORCE_THRESHOLD: Number(process.env.DP_FORCE_THRESHOLD ?? 0.9),
	CHECK_THRESHOLD: Number(process.env.DP_CHECK_THRESHOLD ?? 0.6),
};

// ============================================================================
// File operations helpers (inlined from pi's internal utils)
// ============================================================================

interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

function createFileOps(): FileOperations {
	return { read: new Set(), written: new Set(), edited: new Set() };
}

function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations) {
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;
	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;
		const args = (block as any).arguments;
		if (!args) continue;
		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) continue;
		switch ((block as any).name) {
			case "read":
				fileOps.read.add(path);
				break;
			case "write":
				fileOps.written.add(path);
				break;
			case "edit":
				fileOps.edited.add(path);
				break;
		}
	}
}

function computeFileLists(fileOps: FileOperations) {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

// ============================================================================
// Token estimation helpers
// ============================================================================

function estimateEntryTokens(entry: SessionEntry): number {
	if (entry.type === "message") {
		return estimateTokens(entry.message);
	}
	if (entry.type === "custom_message") {
		const content =
			typeof entry.content === "string"
				? entry.content
				: JSON.stringify(entry.content);
		return Math.ceil(content.length / 4) + 1;
	}
	if (entry.type === "branch_summary") {
		return Math.ceil(entry.summary.length / 4) + 1;
	}
	return 0;
}

function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message;
	}
	if (entry.type === "custom_message") {
		return {
			role: "custom",
			customType: entry.customType,
			content: typeof entry.content === "string" ? [{ type: "text", text: entry.content }] : entry.content,
			display: entry.display,
			details: entry.details,
			timestamp: new Date(entry.timestamp).getTime(),
		} as AgentMessage;
	}
	if (entry.type === "branch_summary") {
		return {
			role: "branchSummary",
			summary: entry.summary,
			fromId: entry.fromId,
			timestamp: new Date(entry.timestamp).getTime(),
		} as AgentMessage;
	}
	if (entry.type === "compaction") {
		return {
			role: "compactionSummary",
			summary: entry.summary,
			tokensBefore: entry.tokensBefore,
			timestamp: new Date(entry.timestamp).getTime(),
		} as AgentMessage;
	}
	return undefined;
}

function getMessageFromEntryForCompaction(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "compaction") {
		return undefined;
	}
	return getMessageFromEntry(entry);
}

// ============================================================================
// Cut-point and turn-boundary helpers
// ============================================================================

function isUserLikeEntry(entry: SessionEntry): boolean {
	if (entry.type === "message") {
		const role = entry.message.role;
		return role === "user" || role === "bashExecution" || role === "custom";
	}
	if (entry.type === "custom_message" || entry.type === "branch_summary") {
		return true;
	}
	return false;
}

function isValidCutPoint(entry: SessionEntry): boolean {
	if (entry.type === "message") {
		const role = entry.message.role;
		return (
			role === "user" ||
			role === "assistant" ||
			role === "bashExecution" ||
			role === "custom" ||
			role === "branchSummary" ||
			role === "compactionSummary"
		);
	}
	if (entry.type === "custom_message" || entry.type === "branch_summary") {
		return true;
	}
	return false;
}

function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		if (isUserLikeEntry(entries[i])) {
			return i;
		}
	}
	return -1;
}

interface CutPointCandidate {
	firstKeptEntryIndex: number;
	turnStartIndex: number;
	isSplitTurn: boolean;
}

function buildCutPointCandidates(
	entries: SessionEntry[],
	boundaryStart: number,
	boundaryEnd: number,
): CutPointCandidate[] {
	const candidates: CutPointCandidate[] = [];
	for (let i = boundaryStart; i < boundaryEnd; i++) {
		if (!isValidCutPoint(entries[i])) continue;

		const isUser = isUserLikeEntry(entries[i]);
		const turnStart = isUser ? -1 : findTurnStartIndex(entries, i, boundaryStart);
		candidates.push({
			firstKeptEntryIndex: i,
			turnStartIndex: turnStart,
			isSplitTurn: !isUser && turnStart !== -1,
		});
	}
	return candidates;
}

// ============================================================================
// Session stats extraction
// ============================================================================

interface SessionStats {
	turnCount: number;
	agentRequestCount: number;
	avgInputTokens: number;
	compactionCount: number;
	currentTurnIndex: number;
}

function extractSessionStats(entries: SessionEntry[]): SessionStats {
	let turnCount = 0;
	let agentRequestCount = 0;
	let totalInputTokens = 0;
	let inputCount = 0;
	let compactionCount = 0;

	for (const entry of entries) {
		if (entry.type === "compaction") {
			compactionCount++;
		}
		if (entry.type === "message" && entry.message.role === "assistant") {
			agentRequestCount++;
			const usage = (entry.message as any).usage;
			if (usage) {
				const ctxTokens =
					usage.totalTokens ??
					usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
				totalInputTokens += ctxTokens;
				inputCount++;
			}
		}
		if (entry.type === "message" && isUserLikeEntry(entry)) {
			turnCount++;
		}
	}

	const avgInputTokens = inputCount > 0 ? Math.floor(totalInputTokens / inputCount) : 4000;
	return {
		turnCount,
		agentRequestCount,
		avgInputTokens: avgInputTokens > 0 ? avgInputTokens : 4000,
		compactionCount,
		currentTurnIndex: turnCount,
	};
}

// ============================================================================
// DP Net Benefit Computation
// ============================================================================

function computeNetBenefit(
	K: number,
	H: number,
	T: number,
	V: number,
	S: number,
	R_est: number,
	avg: number,
	compactionCount: number,
	contextWindow: number,
): number {
	const r_t = Math.max(Math.pow(DP.R, compactionCount + 1), 0.37);
	const M = contextWindow;

	// ① Future savings
	const term1 = ((R_est - 1) * DP.P_CACHE * H) / 1e6;

	// ② Cache invalidation
	const term2 = ((S + K) * (DP.P_INPUT - DP.P_CACHE)) / 1e6;

	// ③ Compression request cost
	const L_instr = 70;
	const term3 = (DP.P_CACHE * (V + H) + DP.P_INPUT * L_instr + DP.P_OUT * S) / 1e6;

	// ④ Information distortion penalty
	const term4 = (DP.BETA * (1 - r_t) * R_est * avg * DP.P_INPUT) / 1e6;

	// ⑤ Quality improvement benefit
	const term5 =
		(DP.QUALITY_PENALTY * DP.P_INPUT * ((V + T) ** 2 - (V + K) ** 2)) / (M * 1e6);

	return term1 - term2 - term3 - term4 + term5;
}

interface DpResult {
	firstKeptEntryIndex: number;
	firstKeptEntryId: string;
	turnStartIndex: number;
	isSplitTurn: boolean;
	netBenefit: number;
	K: number;
	H: number;
	T: number;
	force: boolean;
}

function evaluateDpCompaction(
	entries: SessionEntry[],
	prevCompactionIndex: number,
	contextTokens: number,
	contextWindow: number,
): DpResult | undefined {
	const boundaryStart =
		prevCompactionIndex >= 0
			? (entries.findIndex((e) => e.id === (entries[prevCompactionIndex] as { firstKeptEntryId: string }).firstKeptEntryId) >= 0
				? entries.findIndex((e) => e.id === (entries[prevCompactionIndex] as { firstKeptEntryId: string }).firstKeptEntryId)
				: prevCompactionIndex + 1)
			: 0;
	const boundaryEnd = entries.length;

	if (boundaryStart >= boundaryEnd) return undefined;

	const entryTokens: number[] = entries.map((e) => estimateEntryTokens(e));
	const T = entryTokens.slice(boundaryStart, boundaryEnd).reduce((a, b) => a + b, 0);
	const V = DP.V;

	const stats = extractSessionStats(entries);

	const E =
		DP.E_FIXED > 0
			? DP.E_FIXED
			: Math.max(1, Math.floor(DP.BASELINE_E - stats.currentTurnIndex));

	const L =
		DP.L > 0
			? DP.L
			: stats.turnCount > 0
				? stats.agentRequestCount / stats.turnCount
				: 1;

	const R_est = Math.max(1, E * L);
	const avg = stats.avgInputTokens;

	const candidates = buildCutPointCandidates(entries, boundaryStart, boundaryEnd);
	if (candidates.length === 0) return undefined;

	const minKeep = Math.max(3, Math.floor(candidates.length * DP.MIN_KEEP_RATIO));

	let best: DpResult | undefined;

	for (let idx = minKeep; idx < candidates.length; idx++) {
		const cand = candidates[candidates.length - 1 - idx];
		if (!cand) continue;

		let K = 0;
		for (let i = cand.firstKeptEntryIndex; i < boundaryEnd; i++) {
			K += entryTokens[i];
		}

		const historyEnd = cand.isSplitTurn ? cand.turnStartIndex : cand.firstKeptEntryIndex;
		let H = 0;
		for (let i = boundaryStart; i < historyEnd; i++) {
			H += entryTokens[i];
		}

		const netBenefit = computeNetBenefit(K, H, T, V, DP.S, R_est, avg, stats.compactionCount, contextWindow);

		if (!best || netBenefit > best.netBenefit) {
			const firstKeptEntry = entries[cand.firstKeptEntryIndex];
			if (!firstKeptEntry?.id) continue;
			best = {
				firstKeptEntryIndex: cand.firstKeptEntryIndex,
				firstKeptEntryId: firstKeptEntry.id,
				turnStartIndex: cand.turnStartIndex,
				isSplitTurn: cand.isSplitTurn,
				netBenefit,
				K,
				H,
				T,
				force: false,
			};
		}
	}

	if (!best) return undefined;

	const usagePercent = contextWindow > 0 ? contextTokens / contextWindow : 0;
	if (usagePercent >= DP.FORCE_THRESHOLD) {
		best.force = true;
	}

	return best;
}

// ============================================================================
// Summarization
// ============================================================================

const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

async function generateSummary(
	messages: AgentMessage[],
	model: any,
	reserveTokens: number,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	signal: AbortSignal,
	customInstructions: string | undefined,
	previousSummary: string | undefined,
): Promise<string> {
	const maxTokens = Math.min(
		Math.floor(0.8 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);

	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}

	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);

	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary) {
		promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	}
	promptText += basePrompt;

	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const options: any = { maxTokens, signal };
	if (apiKey) options.apiKey = apiKey;
	if (headers) options.headers = headers;
	if (model.reasoning) options.reasoning = "medium";

	const response = await complete(
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		options,
	);

	if (response.stopReason === "error") {
		throw new Error(`Summarization failed: ${response.errorMessage || "Unknown error"}`);
	}

	return response.content
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join("\n");
}

async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	model: any,
	reserveTokens: number,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	signal: AbortSignal,
): Promise<string> {
	const maxTokens = Math.min(
		Math.floor(0.5 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);

	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;

	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const options: any = { maxTokens, signal };
	if (apiKey) options.apiKey = apiKey;
	if (headers) options.headers = headers;
	if (model.reasoning) options.reasoning = "medium";

	const response = await complete(
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		options,
	);

	if (response.stopReason === "error") {
		throw new Error(`Turn prefix summarization failed: ${response.errorMessage || "Unknown error"}`);
	}

	return response.content
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join("\n");
}

// ============================================================================
// File operations extraction
// ============================================================================

function extractFileOperationsFromMessages(messages: AgentMessage[]) {
	const fileOps = createFileOps();
	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}
	return fileOps;
}

// ============================================================================
// Main extension
// ============================================================================

export default function (pi: ExtensionAPI) {
	const sessionState = new Map<
		string,
		{
			dpCancelled: number;
			lastTokens: number | null;
		}
	>();

	function getState(sessionFile: string | undefined) {
		const key = sessionFile ?? "ephemeral";
		if (!sessionState.has(key)) {
			sessionState.set(key, { dpCancelled: 0, lastTokens: null });
		}
		return sessionState.get(key)!;
	}

	pi.on("session_start", async (_event, ctx) => {
		const state = getState(ctx.sessionManager.getSessionFile());
		state.dpCancelled = 0;
		state.lastTokens = null;
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, branchEntries, customInstructions, signal } = event;
		const { tokensBefore, firstKeptEntryId, previousSummary, settings } = preparation;

		const usage = ctx.getContextUsage();
		const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 200000;

		let prevCompactionIndex = -1;
		for (let i = branchEntries.length - 1; i >= 0; i--) {
			if (branchEntries[i].type === "compaction") {
				prevCompactionIndex = i;
				break;
			}
		}

		const dpResult = evaluateDpCompaction(branchEntries, prevCompactionIndex, tokensBefore, contextWindow);

		if (!dpResult) {
			ctx.ui.notify("DP: no valid cut point found, falling back to default", "warning");
			return;
		}

		const benefitStr = dpResult.netBenefit.toFixed(4);
		const status = `DP: benefit=${benefitStr}, keep=${dpResult.K}tok, hist=${dpResult.H}tok`;

		if (dpResult.netBenefit <= 0 && !dpResult.force) {
			const state = getState(ctx.sessionManager.getSessionFile());
			state.dpCancelled++;
			ctx.ui.notify(`${status} → skip compaction (#${state.dpCancelled})`, "info");
			return { cancel: true };
		}

		if (dpResult.firstKeptEntryId === firstKeptEntryId) {
			ctx.ui.notify(`${status} → using default cut point`, "info");
			return;
		}

		ctx.ui.notify(`${status} → custom cut point (entry ${dpResult.firstKeptEntryIndex})`, "info");

		const historyEnd = dpResult.isSplitTurn ? dpResult.turnStartIndex : dpResult.firstKeptEntryIndex;
		const messagesToSummarize: AgentMessage[] = [];
		for (let i = (prevCompactionIndex >= 0 ? prevCompactionIndex + 1 : 0); i < historyEnd; i++) {
			const msg = getMessageFromEntryForCompaction(branchEntries[i]);
			if (msg) messagesToSummarize.push(msg);
		}

		const turnPrefixMessages: AgentMessage[] = [];
		if (dpResult.isSplitTurn) {
			for (let i = dpResult.turnStartIndex; i < dpResult.firstKeptEntryIndex; i++) {
				const msg = getMessageFromEntryForCompaction(branchEntries[i]);
				if (msg) turnPrefixMessages.push(msg);
			}
		}

		const fileOps = extractFileOperationsFromMessages(messagesToSummarize);
		if (dpResult.isSplitTurn) {
			const prefixOps = extractFileOperationsFromMessages(turnPrefixMessages);
			for (const f of prefixOps.read) fileOps.read.add(f);
			for (const f of prefixOps.edited) fileOps.edited.add(f);
			for (const f of prefixOps.written) fileOps.written.add(f);
		}

		if (prevCompactionIndex >= 0) {
			const prev = branchEntries[prevCompactionIndex];
			if (prev.type === "compaction" && prev.details) {
				const details = prev.details as any;
				if (Array.isArray(details.readFiles)) {
					for (const f of details.readFiles) fileOps.read.add(f);
				}
				if (Array.isArray(details.modifiedFiles)) {
					for (const f of details.modifiedFiles) fileOps.edited.add(f);
				}
			}
		}

		const model = ctx.model;
		if (!model) {
			ctx.ui.notify("DP: no model available for summarization, falling back to default", "warning");
			return;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			ctx.ui.notify("DP: no API key for summarization, falling back to default", "warning");
			return;
		}

		try {
			let summary: string;
			if (dpResult.isSplitTurn && turnPrefixMessages.length > 0) {
				const [historyResult, turnPrefixResult] = await Promise.all([
					messagesToSummarize.length > 0
						? generateSummary(
								messagesToSummarize,
								model,
								settings.reserveTokens,
								auth.apiKey,
								auth.headers,
								signal,
								customInstructions,
								previousSummary,
							)
						: Promise.resolve("No prior history."),
					generateTurnPrefixSummary(
						turnPrefixMessages,
						model,
						settings.reserveTokens,
						auth.apiKey,
						auth.headers,
						signal,
					),
				]);
				summary = `${historyResult}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult}`;
			} else {
				summary = await generateSummary(
					messagesToSummarize,
					model,
					settings.reserveTokens,
					auth.apiKey,
					auth.headers,
					signal,
					customInstructions,
					previousSummary,
				);
			}

			const { readFiles, modifiedFiles } = computeFileLists(fileOps);
			summary += formatFileOperations(readFiles, modifiedFiles);

			return {
				compaction: {
					summary,
					firstKeptEntryId: dpResult.firstKeptEntryId,
					tokensBefore,
					details: { readFiles, modifiedFiles },
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`DP compaction failed: ${message}`, "error");
			return;
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null || usage.contextWindow <= 0) return;

		const percent = usage.tokens / usage.contextWindow;
		const state = getState(ctx.sessionManager.getSessionFile());

		const crossedThreshold =
			state.lastTokens !== null &&
			state.lastTokens <= usage.contextWindow * DP.CHECK_THRESHOLD &&
			percent > DP.CHECK_THRESHOLD;

		state.lastTokens = usage.tokens;

		if (!crossedThreshold) return;

		ctx.compact({
			onComplete: () => {
				state.lastTokens = null;
			},
			onError: (error) => {
				if (ctx.hasUI) {
					ctx.ui.notify(`Auto-compaction failed: ${error.message}`, "error");
				}
			},
		});
	});

	pi.registerCommand("dp-status", {
		description: "Show DP compaction status and parameters",
		handler: async (_args, ctx) => {
			const usage = ctx.getContextUsage();
			const state = getState(ctx.sessionManager.getSessionFile());
			const entries = ctx.sessionManager.getEntries();
			const stats = extractSessionStats(entries);

			const lines = [
				`DP Compaction Status`,
				`-------------------`,
				`Context: ${usage?.tokens ?? "?"} / ${usage?.contextWindow ?? "?"} tokens`,
				`Usage: ${usage?.percent?.toFixed(1) ?? "?"}%`,
				`Turns: ${stats.turnCount}, Agent requests: ${stats.agentRequestCount}`,
				`Avg input tokens: ${stats.avgInputTokens}`,
				`Compactions so far: ${stats.compactionCount}`,
				`DP cancellations: ${state.dpCancelled}`,
				``, `Parameters:`,
				`  P_INPUT=${DP.P_INPUT}, P_CACHE=${DP.P_CACHE}, P_OUT=${DP.P_OUT}`,
				`  V=${DP.V}, S=${DP.S}, E=${DP.E_FIXED > 0 ? DP.E_FIXED : "auto"}`,
				`  R=${DP.R}, BETA=${DP.BETA}, Q=${DP.QUALITY_PENALTY}`,
				`  FORCE_THRESHOLD=${DP.FORCE_THRESHOLD}, CHECK_THRESHOLD=${DP.CHECK_THRESHOLD}`,
				`  Model contextWindow=${ctx.model?.contextWindow ?? "unknown"}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("dp-eval", {
		description: "Evaluate DP compaction decision now",
		handler: async (_args, ctx) => {
			const entries = ctx.sessionManager.getEntries();
			const usage = ctx.getContextUsage();
			const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 200000;
			const tokensBefore = usage?.tokens ?? 0;

			let prevCompactionIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				if (entries[i].type === "compaction") {
					prevCompactionIndex = i;
					break;
				}
			}

			const dpResult = evaluateDpCompaction(entries, prevCompactionIndex, tokensBefore, contextWindow);
			if (!dpResult) {
				ctx.ui.notify("DP: no valid cut point found", "warning");
				return;
			}

			const lines = [
				`DP Evaluation`,
				`-------------`,
				`Net benefit: ${dpResult.netBenefit.toFixed(6)}`,
				`Force: ${dpResult.force}`,
				`Keep: ${dpResult.K} tokens (entry ${dpResult.firstKeptEntryIndex})`,
				`History: ${dpResult.H} tokens`,
				`Total: ${dpResult.T} tokens`,
				`Decision: ${dpResult.netBenefit > 0 || dpResult.force ? "COMPACT" : "SKIP"}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
