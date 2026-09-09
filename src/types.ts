/**
 * Generic message-like shapes used by the compression passes.
 *
 * These intentionally mirror (but do not import) Prime Agent's AgentMessage
 * union documented in docs/session-format.md, so the compression core stays
 * dependency-free and unit-testable without pulling in the coding-agent
 * package at all. The extension wrapper (src/index.ts) adapts real
 * ExtensionAPI messages into this shape before calling compress().
 */

export interface TextContent {
	type: "text";
	text: string;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
}

export interface ToolCallContent {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export type AssistantContentBlock = TextContent | ThinkingContent | ToolCallContent;
export type UserContentBlock = TextContent | ImageContent;

export interface UserMessage {
	role: "user";
	content: string | UserContentBlock[];
	timestamp?: number;
	[key: string]: unknown;
}

export interface AssistantMessage {
	role: "assistant";
	content: AssistantContentBlock[];
	timestamp?: number;
	[key: string]: unknown;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
	timestamp?: number;
	[key: string]: unknown;
}

export interface OtherMessage {
	role: string;
	content?: string | (TextContent | ImageContent)[];
	timestamp?: number;
	[key: string]: unknown;
}

export type CompressMessage = UserMessage | AssistantMessage | ToolResultMessage | OtherMessage;

/** Narrow helper: is this a toolResult message? */
export function isToolResultMessage(m: CompressMessage): m is ToolResultMessage {
	return m.role === "toolResult";
}

/** Narrow helper: is this an assistant message? */
export function isAssistantMessage(m: CompressMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray((m as AssistantMessage).content);
}

/** Extract toolCall content blocks from an assistant message. */
export function getToolCalls(m: CompressMessage): ToolCallContent[] {
	if (!isAssistantMessage(m)) return [];
	return m.content.filter((c): c is ToolCallContent => c.type === "toolCall");
}

/**
 * Human-readable serialization of a toolResult's content, used for display
 * markers and size-estimate text. NOT safe for equality/hash comparisons —
 * images are summarized by length only, so two different images of equal
 * length would look identical here. Use `fingerprintToolResultContent` for
 * dedupe decisions.
 */
export function serializeToolResultContent(m: ToolResultMessage): string {
	return m.content
		.map((c) => {
			if (c.type === "text") return c.text;
			if (c.type === "image") return `[image:${c.mimeType}:${c.data.length}]`;
			return "";
		})
		.join("\n");
}

/**
 * Exact-equality fingerprint of a toolResult's content, including full
 * image data. Two toolResults hash equal here only if their content is
 * byte-for-byte identical. Used by passADedupe so we never collapse two
 * different images that happen to share a base64 length.
 */
export function fingerprintToolResultContent(m: ToolResultMessage): string {
	return m.content
		.map((c) => {
			if (c.type === "text") return `text:${c.text}`;
			if (c.type === "image") return `image:${c.mimeType}:${c.data}`;
			return "";
		})
		.join("\n\x00\n");
}

/** Byte length of a toolResult's content, used for "N bytes elided" markers. */
export function toolResultContentByteLength(m: ToolResultMessage): number {
	let total = 0;
	for (const c of m.content) {
		if (c.type === "text") total += Buffer.byteLength(c.text, "utf8");
		else if (c.type === "image") total += Buffer.byteLength(c.data, "utf8");
	}
	return total;
}

export interface PassStats {
	name: string;
	bytesBefore: number;
	bytesAfter: number;
	hits: number;
}

export interface CompressResult {
	messages: CompressMessage[];
	stats: PassStats[];
}
