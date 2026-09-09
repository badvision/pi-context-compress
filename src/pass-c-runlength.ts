import { isToolResultMessage, type CompressMessage, type ToolResultMessage } from "./types.js";

const MIN_RUN = 3;

/**
 * Collapse runs of 3+ consecutive identical lines within a single string
 * into one instance plus a `(xN)` suffix marker. 2 repeats are left as-is
 * (not worth the marker overhead / risk of hiding meaningful repetition).
 */
export function collapseRepeatedLines(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];
		let j = i + 1;
		while (j < lines.length && lines[j] === line) j++;
		const runLength = j - i;

		if (runLength >= MIN_RUN) {
			out.push(`${line} (×${runLength})`);
		} else {
			for (let k = i; k < j; k++) out.push(line);
		}
		i = j;
	}

	return out.join("\n");
}

/**
 * Pass C — Run-length collapse of repeated lines.
 *
 * Within each tool-result text content block, collapses runs of 3+
 * consecutive identical lines to a single line with a `(xN)` marker.
 * Useful for repetitive log/test output. Does not touch non-toolResult
 * messages.
 */
export function passCRunLength(messages: CompressMessage[]): CompressMessage[] {
	return messages.map((message) => {
		if (!isToolResultMessage(message)) return message;

		let changed = false;
		const content = message.content.map((block) => {
			if (block.type !== "text") return block;
			const collapsed = collapseRepeatedLines(block.text);
			if (collapsed !== block.text) changed = true;
			return { ...block, text: collapsed };
		});

		if (!changed) return message;
		const updated: ToolResultMessage = { ...message, content };
		return updated;
	});
}
