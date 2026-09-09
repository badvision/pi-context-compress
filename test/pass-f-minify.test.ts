import { describe, expect, it } from "vitest";
import { passFMinify } from "../src/pass-f-minify.js";
import type { CompressMessage, ToolResultMessage } from "../src/types.js";

function toolResult(text: string): ToolResultMessage {
	return { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text }], isError: false };
}

describe("passFMinify", () => {
	it("strips trailing whitespace from each line", () => {
		const input = "line one   \nline two\t\t\nline three";
		const out = passFMinify([toolResult(input)]);
		expect((out[0] as ToolResultMessage).content[0]).toEqual({
			type: "text",
			text: "line one\nline two\nline three",
		});
	});

	it("does not touch leading or mid-line whitespace", () => {
		const input = "  indented line\n    more   spaced   text";
		const out = passFMinify([toolResult(input)]);
		expect((out[0] as ToolResultMessage).content[0]).toEqual({ type: "text", text: input });
	});

	it("collapses runs of 3+ consecutive blank lines to a single blank line", () => {
		const input = "a\n\n\n\n\nb";
		const out = passFMinify([toolResult(input)]);
		expect((out[0] as ToolResultMessage).content[0]).toEqual({ type: "text", text: "a\n\nb" });
	});

	it("leaves 1 or 2 consecutive blank lines untouched", () => {
		const oneBlank = "a\n\nb";
		const twoBlank = "a\n\n\nb";
		expect((passFMinify([toolResult(oneBlank)])[0] as ToolResultMessage).content[0]).toEqual({
			type: "text",
			text: oneBlank,
		});
		expect((passFMinify([toolResult(twoBlank)])[0] as ToolResultMessage).content[0]).toEqual({
			type: "text",
			text: twoBlank,
		});
	});

	it("re-serializes a whole-block valid JSON document compactly", () => {
		const input = JSON.stringify({ foo: "bar", nested: { a: 1, b: [1, 2, 3] } }, null, 2);
		const out = passFMinify([toolResult(input)]);
		const resultText = (out[0] as ToolResultMessage).content[0] as { text: string };
		expect(resultText.text).toBe(JSON.stringify({ foo: "bar", nested: { a: 1, b: [1, 2, 3] } }));
		expect(JSON.parse(resultText.text)).toEqual(JSON.parse(input));
	});

	it("re-serializes a pretty-printed JSON array compactly", () => {
		const input = JSON.stringify([1, 2, { a: "b" }], null, 4);
		const out = passFMinify([toolResult(input)]);
		const resultText = (out[0] as ToolResultMessage).content[0] as { text: string };
		expect(resultText.text).toBe(JSON.stringify([1, 2, { a: "b" }]));
	});

	it("leaves invalid/partial JSON-like text untouched", () => {
		const input = '{ "foo": "bar", this is not valid json }';
		const out = passFMinify([toolResult(input)]);
		expect((out[0] as ToolResultMessage).content[0]).toEqual({ type: "text", text: input });
	});

	it("leaves mixed text with an embedded JSON-looking fragment untouched (no fuzzy extraction)", () => {
		const input = 'Some log output before\n{"a": 1}\nand some log output after';
		const out = passFMinify([toolResult(input)]);
		expect((out[0] as ToolResultMessage).content[0]).toEqual({ type: "text", text: input });
	});

	it("leaves plain non-JSON, non-whitespace-issue content completely untouched", () => {
		const input = "just a normal line\nanother normal line";
		const out = passFMinify([toolResult(input)]);
		expect(out[0]).toEqual(toolResult(input));
	});

	it("does not touch non-toolResult messages", () => {
		const messages: CompressMessage[] = [{ role: "user", content: "trailing space   \n\n\n\nafter" }];
		const out = passFMinify(messages);
		expect(out[0]).toEqual(messages[0]);
	});

	it("preserves tool_call/tool_result pairing (message count/roles unchanged)", () => {
		const messages: CompressMessage[] = [toolResult("line   \n\n\n\nend")];
		const out = passFMinify(messages);
		expect(out).toHaveLength(1);
		expect(out[0].role).toBe("toolResult");
		expect((out[0] as ToolResultMessage).toolCallId).toBe("c1");
	});

	it("does not compact JSON if the compact form is not actually smaller", () => {
		// A tiny JSON document where compact form isn't smaller than the trimmed original.
		const input = "{}";
		const out = passFMinify([toolResult(input)]);
		expect((out[0] as ToolResultMessage).content[0]).toEqual({ type: "text", text: "{}" });
	});
});
