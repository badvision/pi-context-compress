import { describe, expect, it } from "vitest";
import { passBSupersededReads } from "../src/pass-b-superseded-reads.js";
import type { AssistantMessage, CompressMessage, ToolResultMessage } from "../src/types.js";

function ipythonCall(id: string, code: string): AssistantMessage {
	return { role: "assistant", content: [{ type: "toolCall", id, name: "ipython", arguments: { code } }] };
}

function editCall(id: string, path: string): AssistantMessage {
	return { role: "assistant", content: [{ type: "toolCall", id, name: "edit", arguments: { path, edits: [] } }] };
}

function toolResult(toolCallId: string, toolName: string, text: string): ToolResultMessage {
	return { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false };
}

describe("passBSupersededReads", () => {
	it("elides an earlier read when a write and a later read of the same path both follow it", () => {
		const messages: CompressMessage[] = [
			ipythonCall("r1", "open('/tmp/foo.txt').read()"),
			toolResult("r1", "ipython", "original contents"),
			editCall("w1", "/tmp/foo.txt"),
			toolResult("w1", "edit", "applied edit"),
			ipythonCall("r2", "open('/tmp/foo.txt').read()"),
			toolResult("r2", "ipython", "updated contents"),
		];

		const out = passBSupersededReads(messages);

		const firstRead = out[1] as ToolResultMessage;
		expect((firstRead.content[0] as { text: string }).text).toContain("stale");
		expect((firstRead.content[0] as { text: string }).text).toContain("/tmp/foo.txt");

		// most recent read stays intact
		const secondRead = out[5] as ToolResultMessage;
		expect(secondRead.content[0]).toEqual({ type: "text", text: "updated contents" });
	});

	it("keeps a read intact when no write of the same path follows it", () => {
		const messages: CompressMessage[] = [
			ipythonCall("r1", "open('/tmp/foo.txt').read()"),
			toolResult("r1", "ipython", "contents"),
			ipythonCall("r2", "open('/tmp/foo.txt').read()"),
			toolResult("r2", "ipython", "contents"),
		];

		const out = passBSupersededReads(messages);

		// no write in between -> pass B leaves both alone (pass A would dedupe identical content separately)
		expect((out[1] as ToolResultMessage).content[0]).toEqual({ type: "text", text: "contents" });
		expect((out[3] as ToolResultMessage).content[0]).toEqual({ type: "text", text: "contents" });
	});

	it("does not touch reads/writes of a different path", () => {
		const messages: CompressMessage[] = [
			ipythonCall("r1", "open('/tmp/a.txt').read()"),
			toolResult("r1", "ipython", "a contents"),
			editCall("w1", "/tmp/b.txt"),
			toolResult("w1", "edit", "applied edit to b"),
			ipythonCall("r2", "open('/tmp/a.txt').read()"),
			toolResult("r2", "ipython", "a contents still"),
		];

		const out = passBSupersededReads(messages);

		expect((out[1] as ToolResultMessage).content[0]).toEqual({ type: "text", text: "a contents" });
	});

	it("preserves tool_call/tool_result pairing after pruning", () => {
		const messages: CompressMessage[] = [
			ipythonCall("r1", "open('/tmp/foo.txt').read()"),
			toolResult("r1", "ipython", "original"),
			editCall("w1", "/tmp/foo.txt"),
			toolResult("w1", "edit", "edit applied"),
			ipythonCall("r2", "open('/tmp/foo.txt').read()"),
			toolResult("r2", "ipython", "fresh"),
		];

		const out = passBSupersededReads(messages);

		expect(out).toHaveLength(messages.length);
		expect(out.map((m) => m.role)).toEqual(messages.map((m) => m.role));
		expect((out[1] as ToolResultMessage).toolCallId).toBe("r1");
	});

	it("handles a middle read that is superseded by a later write+read even though an earlier write already happened", () => {
		const messages: CompressMessage[] = [
			ipythonCall("r1", "open('/tmp/foo.txt').read()"),
			toolResult("r1", "ipython", "v1"),
			editCall("w1", "/tmp/foo.txt"),
			toolResult("w1", "edit", "edit v1->v2"),
			ipythonCall("r2", "open('/tmp/foo.txt').read()"),
			toolResult("r2", "ipython", "v2"),
			editCall("w2", "/tmp/foo.txt"),
			toolResult("w2", "edit", "edit v2->v3"),
			ipythonCall("r3", "open('/tmp/foo.txt').read()"),
			toolResult("r3", "ipython", "v3"),
		];

		const out = passBSupersededReads(messages);

		expect((out[1] as ToolResultMessage).content[0]).toMatchObject({ text: expect.stringContaining("stale") });
		expect((out[5] as ToolResultMessage).content[0]).toMatchObject({ text: expect.stringContaining("stale") });
		expect((out[9] as ToolResultMessage).content[0]).toEqual({ type: "text", text: "v3" });
	});
});
