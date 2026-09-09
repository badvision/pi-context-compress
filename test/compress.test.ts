import { describe, expect, it } from "vitest";
import { compress } from "../src/compress.js";
import type { AssistantMessage, CompressMessage, ToolResultMessage } from "../src/types.js";

function ipythonCall(id: string, code: string): AssistantMessage {
	return { role: "assistant", content: [{ type: "toolCall", id, name: "ipython", arguments: { code } }] };
}

function toolResult(toolCallId: string, toolName: string, text: string): ToolResultMessage {
	return { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false };
}

describe("compress", () => {
	it("shrinks total serialized size on a realistic mixed session", () => {
		const longOutput = Array(10).fill("PASS test_thing").join("\n");
		const messages: CompressMessage[] = [
			{ role: "user", content: "run the tests" },
			ipythonCall("c1", "print('run tests')"),
			toolResult("c1", "ipython", longOutput),
			{ role: "user", content: "run them again" },
			ipythonCall("c2", "print('run tests')"),
			toolResult("c2", "ipython", longOutput),
		];

		const result = compress(messages);
		const before = JSON.stringify(messages).length;
		const after = JSON.stringify(result.messages).length;

		expect(after).toBeLessThan(before);
		expect(result.stats.map((s) => s.name)).toEqual([
			"A-dedupe",
			"B-superseded-reads",
			"C-runlength",
			"D-block-dedup",
			"G-shingle-dedup",
			"E-near-dupe",
		]);
	});

	it("never changes message count or role sequence (tool_call/tool_result pairing invariant)", () => {
		const messages: CompressMessage[] = [
			ipythonCall("c1", "open('/tmp/a.txt').read()"),
			toolResult("c1", "ipython", "a".repeat(100)),
			ipythonCall("c2", "open('/tmp/a.txt', 'w').write('x')"),
			toolResult("c2", "ipython", "wrote"),
			ipythonCall("c3", "open('/tmp/a.txt').read()"),
			toolResult("c3", "ipython", "b".repeat(100)),
		];

		const result = compress(messages);

		expect(result.messages).toHaveLength(messages.length);
		expect(result.messages.map((m) => m.role)).toEqual(messages.map((m) => m.role));
		expect((result.messages[1] as ToolResultMessage).toolCallId).toBe("c1");
		expect((result.messages[3] as ToolResultMessage).toolCallId).toBe("c2");
		expect((result.messages[5] as ToolResultMessage).toolCallId).toBe("c3");
	});

	it("runs additional experimental passes when provided, in order", () => {
		const messages: CompressMessage[] = [toolResult("c1", "bash", "hello")];
		const calls: string[] = [];

		const result = compress(messages, {
			extraPasses: [
				{ name: "extra-1", pass: (m) => (calls.push("extra-1"), m) },
				{ name: "extra-2", pass: (m) => (calls.push("extra-2"), m) },
			],
		});

		expect(calls).toEqual(["extra-1", "extra-2"]);
		expect(result.stats.map((s) => s.name)).toEqual([
			"A-dedupe",
			"B-superseded-reads",
			"C-runlength",
			"D-block-dedup",
			"G-shingle-dedup",
			"E-near-dupe",
			"extra-1",
			"extra-2",
		]);
	});

	it("is a no-op on an empty message array", () => {
		const result = compress([]);
		expect(result.messages).toEqual([]);
	});
});
