import { hashContent } from "./hash.js";
import {
	type CompressMessage,
	fingerprintToolResultContent,
	isToolResultMessage,
	toolResultContentByteLength,
	type ToolResultMessage,
} from "./types.js";

export interface PassAOptions {
	/** Minimum content byte length before a tool result is eligible for collapse. Avoids eliding trivially short results like "ok". */
	minLength?: number;
}

const DEFAULT_MIN_LENGTH = 40;

/**
 * Pass A — Exact-duplicate tool-result collapse.
 *
 * Fingerprints each tool-result's content (including full image data, not
 * just length — two different images must never be treated as identical
 * just because their base64 length matches). If a later tool-result's
 * content exactly matches an earlier one already seen in the message
 * array, the later occurrence's content is replaced with a short marker.
 * The message entry itself is never removed, so tool_call/tool_result
 * pairing stays intact.
 */
export function passADedupe(messages: CompressMessage[], options: PassAOptions = {}): CompressMessage[] {
	const minLength = options.minLength ?? DEFAULT_MIN_LENGTH;
	const seen = new Map<string, { toolCallId: string; length: number }>();
	const result: CompressMessage[] = [];

	for (const message of messages) {
		if (!isToolResultMessage(message)) {
			result.push(message);
			continue;
		}

		const byteLen = toolResultContentByteLength(message);
		if (byteLen < minLength) {
			result.push(message);
			continue;
		}

		const fingerprint = fingerprintToolResultContent(message);
		const hash = hashContent(fingerprint);
		const prior = seen.get(hash);
		if (prior) {
			const collapsed: ToolResultMessage = {
				...message,
				content: [
					{
						type: "text",
						text: `[identical to output of toolCallId ${prior.toolCallId}, ${prior.length} bytes elided]`,
					},
				],
			};
			result.push(collapsed);
			continue;
		}

		seen.set(hash, { toolCallId: message.toolCallId, length: byteLen });
		result.push(message);
	}

	return result;
}
