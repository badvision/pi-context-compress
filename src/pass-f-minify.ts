import { isToolResultMessage, type CompressMessage, type ToolResultMessage } from "./types.js";

const MAX_BLANK_RUN = 1;
const COLLAPSE_THRESHOLD = 3;

/**
 * Strip trailing whitespace from every line. Does NOT touch leading or
 * mid-line whitespace — indentation in tool-result content (code, logs,
 * aligned tables) is structural, not padding.
 */
function stripTrailingWhitespace(text: string): string {
	return text
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/, ""))
		.join("\n");
}

/**
 * Collapse runs of 3+ consecutive blank lines down to a single blank line.
 * 1 or 2 blank lines are left as-is (legitimate paragraph/section spacing).
 */
function collapseBlankRuns(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];
		if (line !== "") {
			out.push(line);
			i++;
			continue;
		}

		let j = i;
		while (j < lines.length && lines[j] === "") j++;
		const runLength = j - i;
		const keep = runLength >= COLLAPSE_THRESHOLD ? MAX_BLANK_RUN : runLength;
		for (let k = 0; k < keep; k++) out.push("");
		i = j;
	}

	return out.join("\n");
}

/**
 * Attempt to detect that the entire (trimmed) text is a single, complete,
 * valid JSON document, and if so re-serialize it compactly (no pretty-print
 * whitespace). Deliberately conservative: only whole-block parsing is
 * attempted (no fuzzy/partial extraction of JSON substrings from mixed
 * text), and the result is only used if it round-trips to an equivalent
 * value and is strictly smaller than the original.
 */
function compactEmbeddedJson(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length === 0) return text;

	const first = trimmed[0];
	if (first !== "{" && first !== "[") return text;

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return text; // not valid JSON (or only partially JSON) - leave untouched
	}

	let compact: string;
	try {
		compact = JSON.stringify(parsed);
	} catch {
		return text;
	}
	if (compact === undefined) return text;

	// Round-trip safety check: the compact form must parse back to an
	// equivalent value before we trust it.
	let reparsed: unknown;
	try {
		reparsed = JSON.parse(compact);
	} catch {
		return text;
	}
	if (JSON.stringify(reparsed) !== compact) return text;

	if (compact.length >= trimmed.length) return text; // not worth it
	return compact;
}

function minifyText(text: string): string {
	const trimmedLines = stripTrailingWhitespace(text);
	const blankCollapsed = collapseBlankRuns(trimmedLines);
	return compactEmbeddedJson(blankCollapsed);
}

/**
 * Pass F — Formatting-level minification of tool-result text.
 *
 * Three transforms, all deterministic and lossless at the semantic level:
 *   1. Strip trailing whitespace from each line.
 *   2. Collapse runs of 3+ consecutive blank lines to a single blank line.
 *   3. If a whole text block is a complete, valid JSON document, re-serialize
 *      it compactly (dropping pretty-print indentation).
 *
 * Deliberately scoped: does NOT collapse mid-line/multi-space whitespace,
 * since a prior investigation of the real session corpus found that
 * indentation there is legitimate code/log structure rather than padding.
 *
 * Same invariants as passes A-E: never removes a message, never breaks
 * tool_call/tool_result pairing - only shrinks text content in place.
 */
export function passFMinify(messages: CompressMessage[]): CompressMessage[] {
	return messages.map((message) => {
		if (!isToolResultMessage(message)) return message;

		let changed = false;
		const content = message.content.map((block) => {
			if (block.type !== "text") return block;
			const minified = minifyText(block.text);
			if (minified !== block.text) changed = true;
			return { ...block, text: minified };
		});

		if (!changed) return message;
		const updated: ToolResultMessage = { ...message, content };
		return updated;
	});
}
