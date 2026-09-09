import { describe, expect, it } from "vitest";
import { passADedupe } from "../src/pass-a-dedupe.js";
import type { AssistantMessage, CompressMessage, ToolResultMessage } from "../src/types.js";

function toolResult(toolCallId: string, toolName: string, text: string): ToolResultMessage {
	return { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false };
}

function assistantWithCall(id: string, name: string): AssistantMessage {
	return { role: "assistant", content: [{ type: "toolCall", id, name, arguments: {} }] };
}

const LONG_TEXT = "x".repeat(80);

describe("passADedupe", () => {
	it("collapses an exact duplicate tool result content", () => {
		const messages: CompressMessage[] = [
			assistantWithCall("call_1", "bash"),
			toolResult("call_1", "bash", LONG_TEXT),
			assistantWithCall("call_2", "bash"),
			toolResult("call_2", "bash", LONG_TEXT),
		];

		const out = passADedupe(messages);

		expect(out).toHaveLength(4);
		const second = out[3] as ToolResultMessage;
		expect(second.content[0]).toMatchObject({ type: "text" });
		expect((second.content[0] as { text: string }).text).toContain("identical to output of toolCallId call_1");
		expect((second.content[0] as { text: string }).text).toContain(`${LONG_TEXT.length} bytes elided`);
	});

	it("does not collapse near-duplicate content (single character diff)", () => {
		const messages: CompressMessage[] = [
			toolResult("call_1", "bash", LONG_TEXT),
			toolResult("call_2", "bash", `${LONG_TEXT}!`),
		];

		const out = passADedupe(messages);

		expect((out[1] as ToolResultMessage).content[0]).toEqual({ type: "text", text: `${LONG_TEXT}!` });
	});

	it("preserves tool_call/tool_result pairing — message count and roles unchanged", () => {
		const messages: CompressMessage[] = [
			assistantWithCall("call_1", "bash"),
			toolResult("call_1", "bash", LONG_TEXT),
			assistantWithCall("call_2", "bash"),
			toolResult("call_2", "bash", LONG_TEXT),
		];

		const out = passADedupe(messages);

		expect(out.map((m) => m.role)).toEqual(messages.map((m) => m.role));
		expect((out[1] as ToolResultMessage).toolCallId).toBe("call_1");
		expect((out[3] as ToolResultMessage).toolCallId).toBe("call_2");
	});

	it("leaves short content untouched even if duplicated (below minLength threshold)", () => {
		const messages: CompressMessage[] = [toolResult("call_1", "bash", "ok"), toolResult("call_2", "bash", "ok")];

		const out = passADedupe(messages);

		expect((out[1] as ToolResultMessage).content[0]).toEqual({ type: "text", text: "ok" });
	});

	it("chains a third duplicate back to the first occurrence, not the second", () => {
		const messages: CompressMessage[] = [
			toolResult("call_1", "bash", LONG_TEXT),
			toolResult("call_2", "bash", LONG_TEXT),
			toolResult("call_3", "bash", LONG_TEXT),
		];

		const out = passADedupe(messages);

		expect((out[2] as ToolResultMessage).content[0]).toMatchObject({
			text: expect.stringContaining("toolCallId call_1"),
		});
	});

	it("ignores non-toolResult messages", () => {
		const messages: CompressMessage[] = [
			{ role: "user", content: LONG_TEXT },
			{ role: "user", content: LONG_TEXT },
		];

		const out = passADedupe(messages);
		expect(out).toEqual(messages);
	});

	it("does not collapse two different images that happen to share the same base64 length (regression)", () => {
		const sameLength = 200;
		const imageA = "A".repeat(sameLength);
		const imageB = "B".repeat(sameLength);
		const messages: CompressMessage[] = [
			{ role: "toolResult", toolCallId: "c1", toolName: "ipython", content: [{ type: "image", data: imageA, mimeType: "image/png" }], isError: false },
			{ role: "toolResult", toolCallId: "c2", toolName: "ipython", content: [{ type: "image", data: imageB, mimeType: "image/png" }], isError: false },
		];

		const out = passADedupe(messages);

		expect(out[1]).toEqual(messages[1]);
	});

	it("collapses two byte-identical images", () => {
		const image = "Z".repeat(200);
		const messages: CompressMessage[] = [
			{ role: "toolResult", toolCallId: "c1", toolName: "ipython", content: [{ type: "image", data: image, mimeType: "image/png" }], isError: false },
			{ role: "toolResult", toolCallId: "c2", toolName: "ipython", content: [{ type: "image", data: image, mimeType: "image/png" }], isError: false },
		];

		const out = passADedupe(messages);

		const second = out[1] as ToolResultMessage;
		expect(second.content[0]).toMatchObject({ type: "text" });
		expect((second.content[0] as { text: string }).text).toContain("identical to output of toolCallId c1");
	});
});
