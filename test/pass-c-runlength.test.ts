import { describe, expect, it } from "vitest";
import { collapseRepeatedLines, passCRunLength } from "../src/pass-c-runlength.js";
import type { CompressMessage, ToolResultMessage } from "../src/types.js";

function toolResult(text: string): ToolResultMessage {
	return { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text }], isError: false };
}

describe("collapseRepeatedLines", () => {
	it("collapses 3+ consecutive identical lines", () => {
		const input = ["ok", "ok", "ok", "done"].join("\n");
		expect(collapseRepeatedLines(input)).toBe(["ok (×3)", "done"].join("\n"));
	});

	it("does not collapse exactly 2 repeats", () => {
		const input = ["ok", "ok", "done"].join("\n");
		expect(collapseRepeatedLines(input)).toBe(input);
	});

	it("collapses a long run (10 repeats)", () => {
		const input = Array(10).fill("PASS test_foo").join("\n");
		expect(collapseRepeatedLines(input)).toBe("PASS test_foo (×10)");
	});

	it("handles multiple separate runs in the same text", () => {
		const input = ["a", "a", "a", "b", "c", "c", "c", "c"].join("\n");
		expect(collapseRepeatedLines(input)).toBe(["a (×3)", "b", "c (×4)"].join("\n"));
	});

	it("leaves non-repeating text untouched", () => {
		const input = ["line1", "line2", "line3"].join("\n");
		expect(collapseRepeatedLines(input)).toBe(input);
	});
});

describe("passCRunLength", () => {
	it("applies collapse only to toolResult text content", () => {
		const messages: CompressMessage[] = [
			{ role: "user", content: Array(5).fill("x").join("\n") },
			toolResult(Array(5).fill("noisy log line").join("\n")),
		];

		const out = passCRunLength(messages);

		expect(out[0]).toEqual(messages[0]); // user message untouched
		expect((out[1] as ToolResultMessage).content[0]).toEqual({ type: "text", text: "noisy log line (×5)" });
	});

	it("preserves tool_call/tool_result pairing (message count/roles unchanged)", () => {
		const messages: CompressMessage[] = [toolResult(Array(4).fill("dup").join("\n"))];
		const out = passCRunLength(messages);
		expect(out).toHaveLength(1);
		expect(out[0].role).toBe("toolResult");
	});
});
