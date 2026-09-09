import { extractFileOps } from "./file-ops.js";
import {
	type CompressMessage,
	getToolCalls,
	isToolResultMessage,
	serializeToolResultContent,
	type ToolResultMessage,
} from "./types.js";

interface PathEvent {
	index: number;
	kind: "read" | "write";
}

/**
 * Pass B — Superseded-read pruning.
 *
 * Tracks file paths referenced by read-type and write-type tool calls
 * (see file-ops.ts for the deterministic, regex-based classification).
 * If a file was read, later written, and then read again afterward, the
 * earlier (now-stale) read is elided — its content is known to be out of
 * date because a write happened in between and a fresher read exists.
 * The most recent read of any given path is always kept intact.
 *
 * Pure ordering logic: for a given path, a read at position `p` is stale
 * iff there exists a later read at position `last` (the final read of that
 * path in the message array) and a write at some position strictly between
 * `p` and `last`.
 */
export function passBSupersededReads(messages: CompressMessage[]): CompressMessage[] {
	// toolCallId -> path (only tracks single-path calls; multi-path calls are
	// rare in practice and we conservatively use the first detected op).
	const toolCallPathKind = new Map<string, { path: string; kind: "read" | "write" }[]>();

	for (const message of messages) {
		for (const call of getToolCalls(message)) {
			const ops = extractFileOps(call.name, call.arguments);
			if (ops.length > 0) toolCallPathKind.set(call.id, ops);
		}
	}

	// path -> ordered events (index = position in messages array)
	const eventsByPath = new Map<string, PathEvent[]>();
	// toolResult message index -> the read op's path (if this toolResult is a pure read of exactly one path)
	const readIndexToPath = new Map<number, string>();

	messages.forEach((message, index) => {
		if (!isToolResultMessage(message)) return;
		const ops = toolCallPathKind.get(message.toolCallId);
		if (!ops || ops.length === 0) return;

		for (const op of ops) {
			const list = eventsByPath.get(op.path) ?? [];
			list.push({ index, kind: op.kind });
			eventsByPath.set(op.path, list);
		}

		// Only treat as a "read to possibly elide" if the tool call was purely a read
		// (a call that both reads and writes, e.g. a script doing both, is left alone).
		if (ops.length === 1 && ops[0].kind === "read") {
			readIndexToPath.set(index, ops[0].path);
		}
	});

	const staleIndexes = new Set<number>();
	for (const [, events] of eventsByPath) {
		const reads = events.filter((e) => e.kind === "read").map((e) => e.index);
		if (reads.length === 0) continue;
		const lastReadPos = Math.max(...reads);
		const writes = events.filter((e) => e.kind === "write").map((e) => e.index);

		for (const readPos of reads) {
			if (readPos === lastReadPos) continue;
			const supersededByWrite = writes.some((w) => w > readPos && w < lastReadPos);
			if (supersededByWrite) staleIndexes.add(readPos);
		}
	}

	return messages.map((message, index) => {
		if (!staleIndexes.has(index) || !isToolResultMessage(message)) return message;
		const path = readIndexToPath.get(index);
		const serialized = serializeToolResultContent(message);
		const collapsed: ToolResultMessage = {
			...message,
			content: [
				{
					type: "text",
					text: `[stale: file${path ? ` (${path})` : ""} was modified after this read, see later read for current content — ${serialized.length} chars elided]`,
				},
			],
		};
		return collapsed;
	});
}
