/**
 * Prime Agent extension: deterministic, lossless context compression.
 *
 * Wraps the pure compress() pipeline (src/compress.ts) in the `context`
 * hook, which fires before each LLM call with a deep copy of the message
 * array. We return a modified copy — this hook is explicitly documented as
 * non-destructive to session storage, so nothing is ever written back to
 * disk or mutated in the actual session (see docs/extensions.md#context).
 *
 * No LLM calls happen anywhere in this extension. Every pass is a pure,
 * synchronous string/array transform.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compress, type CompressOptions } from "./compress.js";
import type { CompressMessage, PassStats } from "./types.js";

let lastStats: { passStats: PassStats[]; bytesBefore: number; bytesAfter: number } | undefined;

function byteLen(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export default function (pi: ExtensionAPI) {
	pi.on("context", async (event) => {
		// event.messages is a deep copy per the context hook contract — safe to
		// treat as a plain CompressMessage[] and hand back a modified copy.
		const messages = event.messages as unknown as CompressMessage[];
		const bytesBefore = byteLen(messages);

		// Low-disruption tuning (2026-09-05, user request): the aggressive
		// defaults collapsed short code fragments — e.g. an identical 117-byte
		// function prefix shared by two adjacent functions in ONE file read —
		// into "see earlier occurrence" markers, corrupting the model's working
		// view of fresh file reads. Keep the big, safe wins:
		//  - Pass G: collapse only verified repeats >= 1KB, and never inside
		//    the 6 most recent tool results (fresh output is what the model is
		//    actively reasoning about).
		//  - Pass E: require 92% line similarity (was 85%) and blocks >= 512B
		//    (was 200B) before a near-dupe diff rewrite.
		// Exact passes (A/B/C/D) are untouched: byte-identical content is safe
		// to reference.
		const options: CompressOptions = {
			passGShingleDedup: { minRepeatLength: 1024, recentWindow: 6 },
			passENearDupe: { minLength: 512, similarityThreshold: 0.92 },
		};
		const result = compress(messages, options);

		const bytesAfter = byteLen(result.messages);
		lastStats = { passStats: result.stats, bytesBefore, bytesAfter };

		return { messages: result.messages as unknown as typeof event.messages };
	});

	pi.registerCommand("compression-stats", {
		description: "Show how much the last context-compress pass shrank the conversation",
		handler: async (_args, ctx) => {
			if (!lastStats) {
				ctx.ui.notify("No context compression has run yet in this session.", "info");
				return;
			}

			const { passStats, bytesBefore, bytesAfter } = lastStats;
			const pct = bytesBefore > 0 ? ((1 - bytesAfter / bytesBefore) * 100).toFixed(2) : "0.00";

			const lines = [
				`Context compression: ${bytesBefore} -> ${bytesAfter} bytes (-${pct}%)`,
				...passStats.map((s) => {
					const passPct = s.bytesBefore > 0 ? ((1 - s.bytesAfter / s.bytesBefore) * 100).toFixed(2) : "0.00";
					return `  ${s.name}: ${s.bytesBefore} -> ${s.bytesAfter} bytes (-${passPct}%, ${s.hits} message(s) touched)`;
				}),
			];

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
