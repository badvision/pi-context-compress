import { describe, expect, it } from "vitest";
import { passGShingleDedup } from "../src/pass-g-shingle-dedup.js";
import type { CompressMessage, ToolResultMessage } from "../src/types.js";

function textResult(toolCallId: string, text: string): ToolResultMessage {
	return { role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text }], isError: false };
}

// A repeated "banner" long enough to clear the default shingle/min-repeat
// length (64 bytes) and short/unique surrounding text on each side, mimicking
// the real-world case: a fixed startup banner embedded in otherwise-different
// tool output.
const BANNER =
	"=== Apple //e Emulator v4.2.1 starting ===\nLoading ROM images... OK\nInitializing 6502 CPU core... OK\n=== Boot complete ===";

describe("passGShingleDedup", () => {
	it("collapses a repeated substring embedded in otherwise-different blocks", () => {
		// Content immediately after the banner diverges on the very first byte
		// (Z... vs Q...) so the greedy forward-extension of the match stops
		// exactly at the banner boundary instead of continuing to match a
		// shared "running disk image " prefix in the surrounding text — keeps
		// this test's expectations independent of the extension algorithm's
		// (correct) behavior of consuming any further shared bytes it finds.
		const messages: CompressMessage[] = [
			textResult("c1", `${BANNER}\nZZZ alpha.dsk run, stdout: 128 bytes read`),
			textResult("c2", `${BANNER}\nQQQ beta.dsk run, stdout: 512 bytes read, 3 sectors`),
		];

		const out = passGShingleDedup(messages);

		const first = out[0] as ToolResultMessage;
		const second = out[1] as ToolResultMessage;

		// First occurrence is untouched (nothing to reference yet).
		expect(first).toEqual(messages[0]);

		const secondText = (second.content[0] as { text: string }).text;
		expect(secondText).toContain("[repeated substring,");
		expect(secondText).toContain("see earlier occurrence in toolCallId c1");
		// Unique surrounding content in the second block must survive untouched.
		expect(secondText).toContain("QQQ beta.dsk run, stdout: 512 bytes read, 3 sectors");
		// The banner text itself should no longer appear verbatim in the second block.
		expect(secondText).not.toContain("Initializing 6502 CPU core");
	});

	it("collapses a repeated substring within a single block, not just across blocks", () => {
		const repeatedChunk = "x".repeat(80);
		const text = `prefix-unique-a ${repeatedChunk} middle-unique ${repeatedChunk} suffix-unique-b`;
		const messages: CompressMessage[] = [textResult("c1", text)];

		const out = passGShingleDedup(messages);
		const result = out[0] as ToolResultMessage;
		const resultText = (result.content[0] as { text: string }).text;

		expect(resultText).toContain("[repeated substring,");
		expect(resultText).toContain("prefix-unique-a");
		expect(resultText).toContain("middle-unique");
		expect(resultText).toContain("suffix-unique-b");
	});

	it("leaves short/non-repeated content untouched", () => {
		const messages: CompressMessage[] = [textResult("c1", "short output, nothing to repeat here"), textResult("c2", "totally different short output")];
		const out = passGShingleDedup(messages);
		expect(out).toEqual(messages);
	});

	it("does not collapse a repeated run shorter than the minimum length", () => {
		const shortRepeat = "y".repeat(20); // well below default shingleLength/minRepeatLength of 64
		const messages: CompressMessage[] = [
			textResult("c1", `alpha-block-one-unique-lead-in ${shortRepeat} bravo-block-one-unique-tail-content-padding-out`),
			textResult("c2", `charlie-block-two-different-lead-in ${shortRepeat} delta-block-two-different-tail-content-padding`),
		];
		const out = passGShingleDedup(messages, { shingleLength: 64, minRepeatLength: 64 });
		expect(out[1]).toEqual(messages[1]);
	});

	it("does not corrupt block structure: non-text blocks (e.g. images) pass through untouched", () => {
		const messages: CompressMessage[] = [
			textResult("c1", `${BANNER}\nfirst run`),
			{
				role: "toolResult",
				toolCallId: "c2",
				toolName: "ipython",
				content: [
					{ type: "text", text: `${BANNER}\nsecond run` },
					{ type: "image", data: "base64imagedata", mimeType: "image/png" },
				],
				isError: false,
			},
		];

		const out = passGShingleDedup(messages);
		const second = out[1] as ToolResultMessage;
		expect(second.content[1]).toEqual({ type: "image", data: "base64imagedata", mimeType: "image/png" });
	});

	it("preserves tool_call/tool_result pairing (message count/roles/toolCallId unchanged)", () => {
		const messages: CompressMessage[] = [textResult("c1", `${BANNER}\nfirst`), textResult("c2", `${BANNER}\nsecond`)];
		const out = passGShingleDedup(messages);
		expect(out).toHaveLength(2);
		expect(out.map((m) => m.role)).toEqual(["toolResult", "toolResult"]);
		expect((out[0] as ToolResultMessage).toolCallId).toBe("c1");
		expect((out[1] as ToolResultMessage).toolCallId).toBe("c2");
	});

	it("is a no-op on messages with no toolResult content", () => {
		const messages: CompressMessage[] = [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: [{ type: "text", text: "hi there" }] },
		];
		const out = passGShingleDedup(messages);
		expect(out).toEqual(messages);
	});

	it("round-trips to valid JSON and never drops a message", () => {
		const messages: CompressMessage[] = [textResult("c1", `${BANNER}\nrun one`), textResult("c2", `${BANNER}\nrun two, with extra detail appended here`)];
		const out = passGShingleDedup(messages);
		expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
		expect(out.length).toBe(messages.length);
	});
});



describe("passGShingleDedup low-disruption tuning", () => {
	// Two adjacent functions sharing an identical ~150-byte prefix with
	// diverging bodies - the real-world failure: a single file read with two
	// similar functions had the second one's signature/body-start collapsed
	// into a "see earlier occurrence" pointer to the first.
	const sharedPrefix = "export function buildPayload(kind: PayloadKind): string {\n\treturn this.blocks\n\t\t.map((b) => {\n\t\t\tif (b.type === \"text\") return ";
	const fnBodyA = "t:${b.text}\";\n\t\t\treturn \"\";\n\t\t})\n\t\t.join(\"\n\u0000\n\");\n}\n";
	const fnBodyB = "f:${b.text}\";\n\t\t\treturn \"\";\n\t\t})\n\t\t.join(\"\n\u0000\n\");\n}\n";

	it("does not collapse a short (<1KB) shared prefix when minRepeatLength=1024", () => {
		const messages: CompressMessage[] = [textResult("c1", "helper one\n" + sharedPrefix + fnBodyA + "helper two\n" + sharedPrefix + fnBodyB)];
		const out = passGShingleDedup(messages, { minRepeatLength: 1024 });
		expect(out[0]).toEqual(messages[0]);
	});

	it("still collapses long (>=1KB) repeated boilerplate", () => {
		const banner = "BOOT-HEADER " + "x".repeat(1200) + " END-HEADER\n";
		const messages: CompressMessage[] = [
			textResult("c1", "run-a unique lead " + banner + "unique tail A"),
			textResult("c2", "run-b different lead " + banner + "unique tail B"),
		];
		const out = passGShingleDedup(messages, { minRepeatLength: 1024, recentWindow: 0 });
		const secondText = ((out[1] as ToolResultMessage).content[0] as { text: string }).text;
		expect(secondText).toContain("[repeated substring,");
		expect(secondText).toContain("see earlier occurrence in toolCallId c1");
	});

	it("protects the most recent N tool results from collapse (recentWindow)", () => {
		const banner = "BOOT-HEADER " + "x".repeat(1200) + " END-HEADER\n";
		const messages: CompressMessage[] = [
			textResult("c1", "old-1 " + banner + "tail-1"),
			textResult("c2", "old-2 " + banner + "tail-2"),
			textResult("c3", "recent-1 " + banner + "tail-3"),
			textResult("c4", "recent-2 " + banner + "tail-4"),
		];
		const out = passGShingleDedup(messages, { minRepeatLength: 1024, recentWindow: 2 });
		const c2Text = ((out[1] as ToolResultMessage).content[0] as { text: string }).text;
		expect(c2Text).toContain("[repeated substring,");
		const c3Text = ((out[2] as ToolResultMessage).content[0] as { text: string }).text;
		const c4Text = ((out[3] as ToolResultMessage).content[0] as { text: string }).text;
		expect(c3Text).not.toContain("[repeated substring,");
		expect(c4Text).not.toContain("[repeated substring,");
	});
});
