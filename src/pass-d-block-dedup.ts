import { hashContent } from "./hash.js";
import type { CompressMessage, ImageContent, TextContent, ToolResultMessage } from "./types.js";
import { isToolResultMessage } from "./types.js";

const DEFAULT_MIN_BLOCK_LENGTH = 200;

export interface PassDOptions {
	/** Minimum block byte length before it's eligible for collapse (avoid eliding tiny repeated blocks). */
	minBlockLength?: number;
}

function blockFingerprint(block: TextContent | ImageContent): string | undefined {
	if (block.type === "text") return `text:${block.text}`;
	if (block.type === "image") return `image:${block.mimeType}:${block.data}`;
	return undefined;
}

function blockByteLength(block: TextContent | ImageContent): number {
	if (block.type === "text") return Buffer.byteLength(block.text, "utf8");
	if (block.type === "image") return Buffer.byteLength(block.data, "utf8");
	return 0;
}

/**
 * EXPERIMENTAL Pass D — Block-level exact-duplicate collapse.
 *
 * Real-session finding: passADedupe compares a toolResult's *entire*
 * content array as one unit. In practice, a toolResult often pairs an
 * identical image (e.g. an unchanged screenshot) with slightly different
 * accompanying text (e.g. stdout with a different byte count or command
 * echo), so the whole-message fingerprint never matches even though the
 * image itself is byte-identical to an earlier one. This pass hashes each
 * content block independently and collapses only the block that repeats,
 * leaving sibling blocks (and the message envelope) untouched.
 *
 * Same invariant as pass A: never removes a message, never breaks
 * tool_call/tool_result pairing — only shrinks block content in place.
 */
export function passDBlockDedup(messages: CompressMessage[], options: PassDOptions = {}): CompressMessage[] {
	const minBlockLength = options.minBlockLength ?? DEFAULT_MIN_BLOCK_LENGTH;
	const seen = new Map<string, { toolCallId: string; length: number }>();

	return messages.map((message) => {
		if (!isToolResultMessage(message)) return message;

		let changed = false;
		const content = message.content.map((block) => {
			const byteLen = blockByteLength(block as TextContent | ImageContent);
			if (byteLen < minBlockLength) return block;

			const fingerprint = blockFingerprint(block as TextContent | ImageContent);
			if (!fingerprint) return block;

			const hash = hashContent(fingerprint);
			const prior = seen.get(hash);
			if (prior) {
				changed = true;
				return {
					type: "text" as const,
					text: `[identical ${block.type} block to output of toolCallId ${prior.toolCallId}, ${prior.length} bytes elided]`,
				};
			}

			seen.set(hash, { toolCallId: message.toolCallId, length: byteLen });
			return block;
		});

		if (!changed) return message;
		const updated: ToolResultMessage = { ...message, content };
		return updated;
	});
}
