import { describe, expect, it } from "vitest";
import { compress } from "../src/compress.js";
import { passDBlockDedup } from "../src/pass-d-block-dedup.js";
import { passGShingleDedup } from "../src/pass-g-shingle-dedup.js";
import type { CompressMessage, ToolResultMessage } from "../src/types.js";

function textResult(toolCallId: string, text: string): ToolResultMessage {
	return { role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text }], isError: false };
}

/** Detects a lone (unpaired) UTF-16 surrogate — the signature of a slice that split a multi-byte character in half. */
function hasLoneSurrogate(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff) {
			const next = s.charCodeAt(i + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
		} else if (c >= 0xdc00 && c <= 0xdfff) {
			const prev = s.charCodeAt(i - 1);
			if (!(prev >= 0xd800 && prev <= 0xdbff)) return true;
		}
	}
	return false;
}

describe("passGShingleDedup — adversarial/stress hardening", () => {
	it("pathological repetition: thousands of repeats of a short pattern collapse without marker explosion", () => {
		const unit = "abcdefghij"; // 10 bytes
		const text = unit.repeat(5000); // 50,000 bytes, entirely one repeated pattern
		const messages: CompressMessage[] = [textResult("c1", text)];

		const start = performance.now();
		const out = passGShingleDedup(messages);
		const elapsedMs = performance.now() - start;

		const outText = (out[0] as ToolResultMessage).content[0] as { text: string };
		const outBytes = Buffer.byteLength(outText.text, "utf8");
		const inBytes = Buffer.byteLength(text, "utf8");

		// Must shrink drastically, never explode (one marker per repeat would be MORE bytes, not fewer).
		expect(outBytes).toBeLessThan(inBytes);
		expect(outBytes).toBeLessThan(1000); // in practice collapses to a couple hundred bytes
		expect(elapsedMs).toBeLessThan(1000); // generous CI-safe bound; typically <5ms
	});

	it("cross-block pathological repetition: many messages of the same short repeated pattern collapse without explosion", () => {
		const unit = "abcdefghij";
		const messages: CompressMessage[] = Array.from({ length: 200 }, (_, i) => textResult(`c${i}`, unit.repeat(20)));
		const totalIn = messages.reduce((s, m) => s + Buffer.byteLength(((m as ToolResultMessage).content[0] as { text: string }).text, "utf8"), 0);

		const out = passGShingleDedup(messages);
		const totalOut = out.reduce((s, m) => s + Buffer.byteLength(((m as ToolResultMessage).content[0] as { text: string }).text, "utf8"), 0);

		expect(totalOut).toBeLessThan(totalIn);
	});

	it("large single block (multi-hundred-KB): no rolling-hash corruption, near-linear time scaling (not quadratic)", () => {
		function makeLog(sizeBytes: number): string {
			const lines: string[] = [];
			let total = 0;
			let i = 0;
			const banner = "[2026-08-29T10:00:00Z] INFO worker-pool: heartbeat ok, queue_depth=0, latency_ms=12.3, node=worker-7\n";
			while (total < sizeBytes) {
				const line = i % 5 === 0 ? banner : `[2026-08-29T10:00:${String(i % 60).padStart(2, "0")}Z] DEBUG task-${i}: item ${i} ok\n`;
				lines.push(line);
				total += Buffer.byteLength(line, "utf8");
				i++;
			}
			return lines.join("");
		}

		const base = 64 * 1024;
		const sizes = [base, base * 4, base * 16];
		const timings: number[] = [];

		for (const size of sizes) {
			const text = makeLog(size);
			const messages: CompressMessage[] = [textResult("c1", text)];
			const start = performance.now();
			const out = passGShingleDedup(messages);
			timings.push(performance.now() - start);

			const outText = (out[0] as ToolResultMessage).content[0] as { text: string };
			expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
			expect(hasLoneSurrogate(outText.text)).toBe(false);
			expect(Buffer.byteLength(outText.text, "utf8")).toBeLessThan(Buffer.byteLength(text, "utf8"));
		}

		// 16x input should not take anywhere near 16^2=256x the time of 1x (quadratic blowup).
		// Generous bound to keep this CI-stable while still catching a real O(n^2) regression.
		const scalingFactor = timings[2] / timings[0];
		expect(scalingFactor).toBeLessThan(60);
	});

	it("regression: multi-byte/Unicode content never produces a lone surrogate (previously reproducible corruption)", () => {
		// Concrete repro captured from fuzzing: a shared Unicode (CJK + emoji + ASCII)
		// substring across 4 tool results, at the default shingleLength=64, produced
		// a lone low surrogate in the collapsed output before the boundary-snapping
		// fix (see collapseRepeats' surrogate-pair handling in pass-g-shingle-dedup.ts).
		const shared =
			"wa🐍🤖db🚀测🌟理u😂文nh🌈oplr试务北✨🐍🎉m🍕j🎈理🔥n🎁😀qi务t上试y文🔥ae✨cm试🎉xw中务京🔥nh🍕🌈文xm内中试🤖🎈试🤖b务中🌟测💯🥳理任😂🥳京c";
		const rawTexts = [
			`n中${shared}测🌟理u😂文nh🌈oplr试务北✨🐍🎉m🍕j🎈理🔥n🎁😀qi务t上试y文🔥ae✨cm试🎉xw中务京🔥nh🍕🌈文xm内中试🤖🎈试🤖b务中🌟测💯🥳理任😂🥳京c🚀🎉🎈`,
			`${shared}测🎈🎈🥳测🐍`,
			`mm${shared}🍕京🎁🌟🎁jx🐍c`,
			`🍕c🎁${shared}😂文✨🥳y文jk🎁d`,
		];
		const messages: CompressMessage[] = rawTexts.map((t, i) => textResult(`c${i}`, t));

		const out = passGShingleDedup(messages);

		for (const m of out) {
			const tr = m as ToolResultMessage;
			for (const block of tr.content) {
				if (block.type === "text") {
					expect(hasLoneSurrogate(block.text)).toBe(false);
					// Encoding to UTF-8 and back must round-trip exactly — a lone
					// surrogate would silently become U+FFFD on the way through.
					expect(Buffer.from(block.text, "utf8").toString("utf8")).toBe(block.text);
				}
			}
		}
		expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
	});

	it("marker reports real UTF-8 byte counts, not UTF-16 code-unit counts, for multi-byte content", () => {
		// A CJK character is 1 UTF-16 code unit but 3 UTF-8 bytes — a marker that
		// reports code-unit count as "bytes" understates real savings ~3x.
		const cjkBanner = "中文测试内容北京上海处理任务".repeat(6);
		const messages: CompressMessage[] = [textResult("c1", `${cjkBanner}第一次运行独特内容`), textResult("c2", `${cjkBanner}第二次运行不同独特内容`)];

		const out = passGShingleDedup(messages);
		const secondText = ((out[1] as ToolResultMessage).content[0] as { text: string }).text;
		const match = secondText.match(/\[repeated substring, (\d+) bytes,/);
		expect(match).not.toBeNull();

		const reportedBytes = Number(match?.[1]);
		const actualCjkBannerBytes = Buffer.byteLength(cjkBanner, "utf8");
		// The reported byte count must be in the ballpark of real UTF-8 bytes
		// (>= the banner's own byte length), not the ~3x-smaller code-unit count.
		expect(reportedBytes).toBeGreaterThanOrEqual(actualCjkBannerBytes);
	});

	it("does not corrupt UTF-8 when multi-byte characters straddle the shingle window boundary (targeted, non-fuzz case)", () => {
		// Emoji (surrogate pairs) repeated with deliberately misaligned padding on
		// each side so a naive shingle match is likely to start/end mid-character.
		const emojiBlock = "😀🎉😂🚀🔥💯🌟✨🎈🎁".repeat(5);
		for (let pad = 0; pad < 8; pad++) {
			const lead = "X".repeat(pad);
			const messages: CompressMessage[] = [textResult("c1", `${lead}${emojiBlock}tail-one-unique`), textResult("c2", `${lead}${emojiBlock}tail-two-different`)];
			const out = passGShingleDedup(messages, { shingleLength: 7, minRepeatLength: 7 });
			for (const m of out) {
				const tr = m as ToolResultMessage;
				for (const block of tr.content) {
					if (block.type === "text") expect(hasLoneSurrogate(block.text)).toBe(false);
				}
			}
		}
	});

	it("D+G interaction: a whole-block-duplicate that also contains an internal repeat is not double-marked or corrupted", () => {
		const internallyRepeatedBanner = "STARTUP-BANNER-XYZ-0123456789-STARTUP-BANNER-XYZ-0123456789-".repeat(4);
		const wholeBlockText = `${internallyRepeatedBanner} unique-tail-content-not-repeated-here`;

		const messages: CompressMessage[] = [
			textResult("c1", wholeBlockText),
			textResult("c2", wholeBlockText), // exact duplicate of the whole block — pass D's territory
			textResult("c3", `${internallyRepeatedBanner} different-tail-content-here`), // shares only the internal banner — pass G's territory
		];

		// Run D then G directly (current default pipeline order) to isolate the interaction.
		const out = passGShingleDedup(passDBlockDedup(messages));

		expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
		expect(out).toHaveLength(messages.length);

		const c1Text = ((out[0] as ToolResultMessage).content[0] as { text: string }).text;
		const c2Text = ((out[1] as ToolResultMessage).content[0] as { text: string }).text;
		const c3Text = ((out[2] as ToolResultMessage).content[0] as { text: string }).text;

		// c1 (first occurrence of everything) gets G's internal-repeat collapse.
		expect(c1Text).toContain("[repeated substring,");
		// c2 was already collapsed to D's short marker; G must not try to "compress" that marker text
		// (no double-marking, no G marker embedded inside D's marker).
		expect(c2Text).toContain("identical");
		expect(c2Text).not.toContain("[repeated substring,");
		// c3 shares only the internal banner with c1, so G (not D) collapses it.
		expect(c3Text).toContain("[repeated substring,");
		expect(c3Text).toContain("different-tail-content-here");
	});

	it("tool_call/tool_result pairing invariant holds through the full default pipeline including G", () => {
		const messages: CompressMessage[] = [
			{ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }] },
			textResult("call-1", "STARTUP-BANNER-XYZ-0123456789-STARTUP-BANNER-XYZ-0123456789-".repeat(4)),
			{ role: "assistant", content: [{ type: "toolCall", id: "call-2", name: "bash", arguments: {} }] },
			textResult("call-2", `${"STARTUP-BANNER-XYZ-0123456789-STARTUP-BANNER-XYZ-0123456789-".repeat(4)} extra unique output`),
		];

		const result = compress(messages);

		expect(result.messages).toHaveLength(messages.length);
		expect(result.messages.map((m) => m.role)).toEqual(messages.map((m) => m.role));
		expect(() => JSON.parse(JSON.stringify(result.messages))).not.toThrow();
	});
});
