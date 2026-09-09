import { byteLength } from "./hash.js";
import { passADedupe, type PassAOptions } from "./pass-a-dedupe.js";
import { passBSupersededReads } from "./pass-b-superseded-reads.js";
import { passCRunLength } from "./pass-c-runlength.js";
import { passDBlockDedup, type PassDOptions } from "./pass-d-block-dedup.js";
import { passENearDupe, type PassEOptions } from "./pass-e-near-dupe.js";
import { passGShingleDedup, type PassGOptions } from "./pass-g-shingle-dedup.js";
import type { CompressMessage, CompressResult, PassStats } from "./types.js";

export type Pass = (messages: CompressMessage[]) => CompressMessage[];

function messagesByteLength(messages: CompressMessage[]): number {
	return byteLength(JSON.stringify(messages));
}

function runPass(name: string, pass: Pass, messages: CompressMessage[]): { messages: CompressMessage[]; stats: PassStats } {
	const bytesBefore = messagesByteLength(messages);
	const out = pass(messages);
	const bytesAfter = messagesByteLength(out);
	const hits = out.reduce((count, m, i) => (JSON.stringify(m) !== JSON.stringify(messages[i]) ? count + 1 : count), 0);
	return { messages: out, stats: { name, bytesBefore, bytesAfter, hits } };
}

export interface CompressOptions {
	passADedupe?: PassAOptions;
	passDBlockDedup?: PassDOptions;
	passENearDupe?: PassEOptions;
	passGShingleDedup?: PassGOptions;
	/** Additional experimental passes to run after the core default passes, in order. */
	extraPasses?: { name: string; pass: Pass }[];
}

/**
 * Compose the deterministic compression passes:
 *   compress(messages) = passE(passG(passD(passC(passB(passA(messages))))))
 *
 * Each pass only shrinks content in place; it never removes or reorders
 * message entries, so tool_call/tool_result pairing is always preserved.
 *
 * Pass D (block-level exact dedup) was promoted from an experiment into the
 * default pipeline after real-session validation showed it was the single
 * largest contributor (see scripts/validate-sessions.ts output) — repeated
 * images (e.g. unchanged screenshots) paired with slightly different
 * sibling text weren't caught by pass A's whole-message fingerprint.
 *
 * Pass G (rolling-hash shingle-based repeated-substring collapse) was
 * promoted after real-session validation showed it was the second-largest
 * contributor (+2.93pp), with negligible added latency, and a subsequent
 * hardening round of adversarial/stress testing (pathological repetition,
 * multi-megabyte blocks, multi-byte/Unicode content, and interaction with
 * pass D) found and fixed a real UTF-16 surrogate-pair-splitting corruption
 * bug before promotion — see pass-g-shingle-dedup.ts and
 * test/pass-g-adversarial.test.ts.
 *
 * Pass E (near-duplicate line-diff collapse) was promoted after being
 * extended to scan assistant toolCall arguments (e.g. retyped code across
 * iterative fix-attempt turns), not just toolResult text — real-session
 * validation showed +0.71pp, spread across 6 of 9 real sessions (not one
 * outlier workflow), with detection purely structural (byte length, line
 * diff, bag-of-lines similarity — no hardcoded tool names or phrases) and
 * latency (~380ms on the largest, most toolCall-heavy real session)
 * negligible against the multi-minute LLM-call budget this runs ahead of.
 */
export function compress(messages: CompressMessage[], options: CompressOptions = {}): CompressResult {
	const stats: PassStats[] = [];
	let current = messages;

	const passes: { name: string; pass: Pass }[] = [
		{ name: "A-dedupe", pass: (m) => passADedupe(m, options.passADedupe) },
		{ name: "B-superseded-reads", pass: passBSupersededReads },
		{ name: "C-runlength", pass: passCRunLength },
		{ name: "D-block-dedup", pass: (m) => passDBlockDedup(m, options.passDBlockDedup) },
		{ name: "G-shingle-dedup", pass: (m) => passGShingleDedup(m, options.passGShingleDedup) },
		{ name: "E-near-dupe", pass: (m) => passENearDupe(m, options.passENearDupe) },
		...(options.extraPasses ?? []),
	];

	for (const { name, pass } of passes) {
		const result = runPass(name, pass, current);
		current = result.messages;
		stats.push(result.stats);
	}

	return { messages: current, stats };
}
