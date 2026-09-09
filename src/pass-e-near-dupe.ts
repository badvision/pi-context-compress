import { bagOfLinesSimilarity, diffLines, MAX_DIFF_LINES, renderDiff } from "./line-diff.js";
import { isAssistantMessage, isToolResultMessage, type CompressMessage, type ToolResultMessage } from "./types.js";

const DEFAULT_MIN_LENGTH = 200;
const DEFAULT_SIMILARITY_THRESHOLD = 0.85;

export interface PassEOptions {
	/** Minimum text block byte length before it's considered for near-dupe collapse. */
	minLength?: number;
	/** Bag-of-lines similarity (0..1) required to treat two blocks as near-duplicates. */
	similarityThreshold?: number;
	/** Minimum string-argument byte length before a toolCall argument is considered for near-dupe collapse. Defaults to minLength. */
	minArgLength?: number;
}

interface SeenBlock {
	refId: string;
	lines: string[];
	byteLength: number;
}

/**
 * Look for an earlier block that's a near-duplicate (by bag-of-lines
 * similarity) of `lines`, excluding exact matches (that's passA/passD's job,
 * not ours). Does not mutate `seen` -- callers push after calling this so a
 * block never matches itself.
 */
function findNearDupe(
	seen: SeenBlock[],
	lines: string[],
	threshold: number,
): { candidate: SeenBlock; similarity: number } | undefined {
	let best: { candidate: SeenBlock; similarity: number } | undefined;
	for (const candidate of seen) {
		if (candidate.lines.length === lines.length && candidate.lines.every((l, i) => l === lines[i])) {
			continue;
		}
		const similarity = bagOfLinesSimilarity(candidate.lines, lines);
		if (similarity >= threshold && (!best || similarity > best.similarity)) {
			best = { candidate, similarity };
		}
	}
	return best;
}

/**
 * Try to collapse `text` (tracked under `refId`) against everything seen so
 * far in `seen`. Always records `text` into `seen` regardless of outcome, so
 * later blocks can match against it. Returns undefined if there's no
 * near-dupe, the diff would be too expensive (MAX_DIFF_LINES), or the diff
 * representation wouldn't actually be smaller than the original.
 */
function tryCollapse(
	seen: SeenBlock[],
	refId: string,
	text: string,
	threshold: number,
): { diffText: string; similarity: number; matchRefId: string } | undefined {
	const lines = text.split("\n");
	const byteLength = Buffer.byteLength(text, "utf8");
	const best = findNearDupe(seen, lines, threshold);
	seen.push({ refId, lines, byteLength });

	if (!best) return undefined;
	if (best.candidate.lines.length > MAX_DIFF_LINES || lines.length > MAX_DIFF_LINES) return undefined;

	const ops = diffLines(best.candidate.lines, lines);
	const diffText = renderDiff(ops);
	if (Buffer.byteLength(diffText, "utf8") >= byteLength) return undefined;

	return { diffText, similarity: best.similarity, matchRefId: best.candidate.refId };
}

/**
 * EXPERIMENTAL Pass E — Near-duplicate text collapse via lossless line diff.
 *
 * Covers two sources of near-duplicate text seen in real sessions:
 *
 * 1. toolResult text blocks that are almost-but-not-exactly identical to an
 *    earlier block (e.g. the same file re-read after a one-line edit, or a
 *    directory listing that gained one entry).
 * 2. Assistant toolCall string arguments (e.g. `code` for an ipython call,
 *    `command` for a bash call) that are near-identical to an earlier
 *    toolCall's argument of the same name -- the retyped-code pattern from
 *    iterative fix-attempt loops, where each attempt resends almost the same
 *    script with a one- or two-line change. This is a distinct source from
 *    (1): it lives in assistant messages, not toolResult messages, so it was
 *    invisible to the original toolResult-only scan.
 *
 * Both are replaced with a compact line diff against the earlier occurrence.
 * This is lossless: the diff plus the referenced earlier block fully
 * reconstructs the original text.
 *
 * Gated by a cheap bag-of-lines similarity check before running the O(n*m)
 * LCS diff, and skips diffing (leaves content untouched) when either side
 * exceeds MAX_DIFF_LINES, to keep this pass itself cheap and bounded.
 */
export function passENearDupe(messages: CompressMessage[], options: PassEOptions = {}): CompressMessage[] {
	const minLength = options.minLength ?? DEFAULT_MIN_LENGTH;
	const minArgLength = options.minArgLength ?? minLength;
	const threshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
	const seenResults: SeenBlock[] = [];
	const seenArgs: SeenBlock[] = [];

	return messages.map((message) => {
		if (isToolResultMessage(message)) {
			let changed = false;
			const content = message.content.map((block) => {
				if (block.type !== "text") return block;
				if (Buffer.byteLength(block.text, "utf8") < minLength) return block;

				const collapsed = tryCollapse(seenResults, message.toolCallId, block.text, threshold);
				if (!collapsed) return block;

				changed = true;
				return {
					type: "text" as const,
					text: `[near-duplicate of toolCallId ${collapsed.matchRefId} (${Math.round(collapsed.similarity * 100)}% similar), lossless line diff follows]\n${collapsed.diffText}`,
				};
			});

			if (!changed) return message;
			const updated: ToolResultMessage = { ...message, content };
			return updated;
		}

		if (isAssistantMessage(message)) {
			let changed = false;
			const content = message.content.map((block) => {
				if (block.type !== "toolCall") return block;

				let argsChanged = false;
				const newArguments: Record<string, unknown> = { ...block.arguments };
				for (const [key, value] of Object.entries(block.arguments)) {
					if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < minArgLength) continue;

					const refId = `${block.id}:${key}`;
					const collapsed = tryCollapse(seenArgs, refId, value, threshold);
					if (!collapsed) continue;

					argsChanged = true;
					newArguments[key] =
						`[near-duplicate of toolCall argument ${collapsed.matchRefId} (${Math.round(collapsed.similarity * 100)}% similar), lossless line diff follows]\n${collapsed.diffText}`;
				}

				if (!argsChanged) return block;
				changed = true;
				return { ...block, arguments: newArguments };
			});

			if (!changed) return message;
			return { ...message, content };
		}

		return message;
	});
}
