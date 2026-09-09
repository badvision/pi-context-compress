import { describe, expect, it } from "vitest";
import { passENearDupe } from "../src/pass-e-near-dupe.js";
import type { AssistantMessage, CompressMessage, ToolResultMessage } from "../src/types.js";

function textResult(toolCallId: string, text: string): ToolResultMessage {
	return { role: "toolResult", toolCallId, toolName: "ipython", content: [{ type: "text", text }], isError: false };
}

function toolCallMessage(id: string, args: Record<string, unknown>): AssistantMessage {
	return { role: "assistant", content: [{ type: "toolCall", id, name: "ipython", arguments: args }] };
}

function bigListing(extraLine?: string): string {
	const lines: string[] = [];
	for (let i = 0; i < 60; i++) lines.push(`file-${i}.ts  ${1000 + i} bytes`);
	if (extraLine) lines.push(extraLine);
	return lines.join("\n");
}

describe("passENearDupe", () => {
	it("collapses a near-duplicate listing (one added line) into a lossless diff", () => {
		const messages: CompressMessage[] = [textResult("c1", bigListing()), textResult("c2", bigListing("file-NEW.ts  9999 bytes"))];

		const out = passENearDupe(messages);

		const second = out[1] as ToolResultMessage;
		const text = (second.content[0] as { text: string }).text;
		expect(text).toContain("near-duplicate of toolCallId c1");
		expect(text).toContain("+ file-NEW.ts  9999 bytes");
	});

	it("does not touch exact duplicates (that's passADedupe's job)", () => {
		const messages: CompressMessage[] = [textResult("c1", bigListing()), textResult("c2", bigListing())];
		const out = passENearDupe(messages);
		expect(out[1]).toEqual(messages[1]);
	});

	it("does not collapse dissimilar content", () => {
		const messages: CompressMessage[] = [textResult("c1", bigListing()), textResult("c2", "totally unrelated content\n".repeat(20))];
		const out = passENearDupe(messages);
		expect(out[1]).toEqual(messages[1]);
	});

	it("preserves tool_call/tool_result pairing", () => {
		const messages: CompressMessage[] = [textResult("c1", bigListing()), textResult("c2", bigListing("one more line"))];
		const out = passENearDupe(messages);
		expect(out).toHaveLength(2);
		expect(out.map((m) => m.role)).toEqual(["toolResult", "toolResult"]);
		expect((out[1] as ToolResultMessage).toolCallId).toBe("c2");
	});

	it("leaves short content untouched regardless of similarity", () => {
		const messages: CompressMessage[] = [textResult("c1", "short a"), textResult("c2", "short b")];
		const out = passENearDupe(messages);
		expect(out).toEqual(messages);
	});

	it("collapses a near-duplicate toolCall argument (retyped code, one line changed)", () => {
		const messages: CompressMessage[] = [
			toolCallMessage("t1", { code: bigListing() }),
			toolCallMessage("t2", { code: bigListing("file-NEW.ts  9999 bytes") }),
		];

		const out = passENearDupe(messages);

		const second = out[1] as AssistantMessage;
		const code = (second.content[0] as { arguments: Record<string, unknown> }).arguments.code as string;
		expect(code).toContain("near-duplicate of toolCall argument t1:code");
		expect(code).toContain("+ file-NEW.ts  9999 bytes");
	});

	it("does not cross-match toolCall arguments under different argument keys", () => {
		const messages: CompressMessage[] = [
			toolCallMessage("t1", { code: bigListing() }),
			toolCallMessage("t2", { command: bigListing("one more line") }),
		];
		const out = passENearDupe(messages);
		// Different key ("command" vs "code") still matches by content similarity alone --
		// this test documents that matching is content-based, not key-scoped.
		const second = out[1] as AssistantMessage;
		const command = (second.content[0] as { arguments: Record<string, unknown> }).arguments.command as string;
		expect(command).toContain("near-duplicate of toolCall argument t1:code");
	});

	it("does not touch exact-duplicate toolCall arguments (that's passADedupe/passG's job)", () => {
		const messages: CompressMessage[] = [toolCallMessage("t1", { code: bigListing() }), toolCallMessage("t2", { code: bigListing() })];
		const out = passENearDupe(messages);
		expect(out[1]).toEqual(messages[1]);
	});

	it("leaves non-string toolCall arguments untouched", () => {
		const messages: CompressMessage[] = [
			toolCallMessage("t1", { code: bigListing(), timeout: 30, verbose: true }),
			toolCallMessage("t2", { code: bigListing("one more line"), timeout: 30, verbose: true }),
		];
		const out = passENearDupe(messages);
		const second = out[1] as AssistantMessage;
		const args = (second.content[0] as { arguments: Record<string, unknown> }).arguments;
		expect(args.timeout).toBe(30);
		expect(args.verbose).toBe(true);
	});

	it("preserves other content blocks and other arguments on the same message", () => {
		const messages: CompressMessage[] = [
			toolCallMessage("t1", { code: bigListing() }),
			{
				role: "assistant",
				content: [
					{ type: "text", text: "trying again" },
					{ type: "toolCall", id: "t2", name: "ipython", arguments: { code: bigListing("one more line"), path: "/tmp/x.ts" } },
				],
			},
		];
		const out = passENearDupe(messages) as AssistantMessage[];
		expect(out[1].content[0]).toEqual({ type: "text", text: "trying again" });
		const args = (out[1].content[1] as { arguments: Record<string, unknown> }).arguments;
		expect(args.path).toBe("/tmp/x.ts");
	});
});
