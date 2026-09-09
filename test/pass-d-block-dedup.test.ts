import { describe, expect, it } from "vitest";
import { passDBlockDedup } from "../src/pass-d-block-dedup.js";
import type { CompressMessage, ToolResultMessage } from "../src/types.js";

const IMAGE_A = "A".repeat(300);
const IMAGE_B = "B".repeat(300);

function imageResult(toolCallId: string, text: string, data: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "ipython",
		content: [
			{ type: "text", text },
			{ type: "image", data, mimeType: "image/png" },
		],
		isError: false,
	};
}

describe("passDBlockDedup", () => {
	it("collapses an identical image block even when the sibling text block differs", () => {
		const messages: CompressMessage[] = [
			imageResult("c1", "ran cell, 42 bytes stdout", IMAGE_A),
			imageResult("c2", "ran cell, 57 bytes stdout", IMAGE_A),
		];

		const out = passDBlockDedup(messages);

		const second = out[1] as ToolResultMessage;
		expect(second.content[0]).toEqual({ type: "text", text: "ran cell, 57 bytes stdout" }); // sibling text untouched
		expect(second.content[1]).toMatchObject({ type: "text" });
		expect((second.content[1] as { text: string }).text).toContain("identical image block to output of toolCallId c1");
	});

	it("does not collapse two different images that differ in content", () => {
		const messages: CompressMessage[] = [imageResult("c1", "a", IMAGE_A), imageResult("c2", "a", IMAGE_B)];

		const out = passDBlockDedup(messages);

		expect(out[1]).toEqual(messages[1]);
	});

	it("preserves tool_call/tool_result pairing (message count/roles unchanged)", () => {
		const messages: CompressMessage[] = [imageResult("c1", "a", IMAGE_A), imageResult("c2", "b", IMAGE_A)];
		const out = passDBlockDedup(messages);
		expect(out).toHaveLength(2);
		expect(out.map((m) => m.role)).toEqual(["toolResult", "toolResult"]);
		expect((out[1] as ToolResultMessage).toolCallId).toBe("c2");
	});

	it("leaves small blocks below the threshold untouched even if duplicated", () => {
		const messages: CompressMessage[] = [imageResult("c1", "hi", "x"), imageResult("c2", "hi", "x")];
		const out = passDBlockDedup(messages);
		expect(out[1]).toEqual(messages[1]);
	});
});
