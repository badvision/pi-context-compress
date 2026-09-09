#!/usr/bin/env tsx
/**
 * Real-session validation harness.
 *
 * Loads every real Prime Agent session jsonl file found under
 * ~/.prime/agent/sessions/, extracts the message array each one would send
 * to the LLM, runs compress() on it, and reports:
 *   - byte size and rough token estimate (chars/4) before/after
 *   - structural integrity: JSON still parses, every tool_call has exactly
 *     one matching tool_result, no orphaned entries
 *
 * No LLM calls. No writes to the session files (read-only).
 */

import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compress } from "../src/compress.js";
import { passADedupe } from "../src/pass-a-dedupe.js";
import { passBSupersededReads } from "../src/pass-b-superseded-reads.js";
import { passCRunLength } from "../src/pass-c-runlength.js";
import { passDBlockDedup } from "../src/pass-d-block-dedup.js";
import { passFMinify } from "../src/pass-f-minify.js";
import { passGShingleDedup } from "../src/pass-g-shingle-dedup.js";
import type { CompressMessage } from "../src/types.js";

const SESSIONS_DIR = join(homedir(), ".prime", "agent", "sessions");

interface SessionEntry {
	type: string;
	id?: string;
	parentId?: string | null;
	message?: CompressMessage;
	[key: string]: unknown;
}

function loadSessionMessages(path: string): CompressMessage[] {
	const raw = readFileSync(path, "utf8");
	const lines = raw.trim().split("\n").filter(Boolean);
	const messages: CompressMessage[] = [];

	for (const line of lines) {
		let entry: SessionEntry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue; // malformed line, skip (harness is read-only/best-effort)
		}
		if (entry.type === "message" && entry.message) {
			messages.push(entry.message);
		}
	}

	return messages;
}

function byteSize(messages: CompressMessage[]): number {
	return Buffer.byteLength(JSON.stringify(messages), "utf8");
}

function tokenEstimate(bytes: number): number {
	return Math.round(bytes / 4);
}

interface ToolCallRef {
	id: string;
	name: string;
}

function collectToolCallIds(messages: CompressMessage[]): ToolCallRef[] {
	const refs: ToolCallRef[] = [];
	for (const m of messages) {
		if (m.role === "assistant" && Array.isArray((m as { content: unknown }).content)) {
			for (const block of (m as { content: { type: string; id?: string; name?: string }[] }).content) {
				if (block.type === "toolCall" && block.id && block.name) refs.push({ id: block.id, name: block.name });
			}
		}
	}
	return refs;
}

function collectToolResultIds(messages: CompressMessage[]): string[] {
	return messages.filter((m) => m.role === "toolResult").map((m) => (m as { toolCallId: string }).toolCallId);
}

interface IntegrityCheck {
	ok: boolean;
	issues: string[];
}

function checkIntegrity(before: CompressMessage[], after: CompressMessage[]): IntegrityCheck {
	const issues: string[] = [];

	// JSON still parses (guaranteed by JSON.stringify/parse round trip, but verify explicitly)
	try {
		JSON.parse(JSON.stringify(after));
	} catch (e) {
		issues.push(`Result does not serialize to valid JSON: ${(e as Error).message}`);
	}

	if (before.length !== after.length) {
		issues.push(`Message count changed: ${before.length} -> ${after.length}`);
	}

	if (before.map((m) => m.role).join(",") !== after.map((m) => m.role).join(",")) {
		issues.push("Role sequence changed");
	}

	const callsBefore = collectToolCallIds(before);
	const callsAfter = collectToolCallIds(after);
	const resultsBefore = collectToolResultIds(before);
	const resultsAfter = collectToolResultIds(after);

	if (callsBefore.length !== callsAfter.length) {
		issues.push(`Tool call count changed: ${callsBefore.length} -> ${callsAfter.length}`);
	}

	const beforeCallIds = new Set(callsBefore.map((c) => c.id));
	const beforeResultIds = new Set(resultsBefore);
	const afterCallIds = new Set(callsAfter.map((c) => c.id));
	const afterResultIds = new Set(resultsAfter);

	for (const id of beforeCallIds) {
		if (!beforeResultIds.has(id)) continue; // some calls never got a result in the original (e.g. aborted) - not our bug
		if (!afterResultIds.has(id)) issues.push(`Tool call ${id} lost its matching tool result after compression`);
	}

	for (const id of afterCallIds) {
		if (!beforeCallIds.has(id)) issues.push(`Orphaned tool call ${id} appeared after compression`);
	}

	// every tool result must map to a call id that exists somewhere in the same array (orphan check)
	for (const id of resultsAfter) {
		if (!afterCallIds.has(id)) issues.push(`Tool result references unknown toolCallId ${id} after compression`);
	}

	return { ok: issues.length === 0, issues };
}

function main() {
	let files: string[] = [];
	try {
		files = readdirSync(SESSIONS_DIR)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(SESSIONS_DIR, f));
	} catch (e) {
		console.error(`Could not read sessions dir ${SESSIONS_DIR}: ${(e as Error).message}`);
		process.exit(1);
	}

	if (files.length === 0) {
		console.log(`No session files found under ${SESSIONS_DIR}`);
		return;
	}

	console.log(`Found ${files.length} session file(s) under ${SESSIONS_DIR}\n`);

	const rows: {
		file: string;
		messages: number;
		bytesBefore: number;
		bytesAfter: number;
		ratio: number;
		tokensBefore: number;
		tokensAfter: number;
		perPass: { name: string; bytesBefore: number; bytesAfter: number; hits: number }[];
		integrity: IntegrityCheck;
	}[] = [];

	const timings: {
		file: string;
		bytesBefore: number;
		passGAloneMs: number;
		fullPipelineMs: number;
	}[] = [];

	let totalBefore = 0;
	let totalAfter = 0;
	let totalAfterDefaultOnly = 0;
	let anyIntegrityFailure = false;

	// F remains experimental (not part of the default pipeline). G and E were
	// promoted into the default composition in src/compress.ts after
	// real-session validation (G: +2.93pp, negligible latency, adversarial/
	// stress hardened — see test/pass-g-adversarial.test.ts; E: +0.71pp after
	// extension to scan toolCall arguments, spread across 6/9 real sessions,
	// negligible latency, no hardcoded tool names/phrases).
	const EXTRA_PASSES_EXPERIMENTAL = [{ name: "F-EXPERIMENTAL-minify", pass: passFMinify }];

	for (const file of files) {
		const messages = loadSessionMessages(file);
		if (messages.length === 0) {
			console.log(`${file}: no message entries, skipping`);
			continue;
		}

		const bytesBefore = byteSize(messages);

		// Time pass G alone: reproduce the default pipeline's pre-G state (A-D)
		// manually to get G's real input, then time only the G pass itself on it.
		const preGMessages = passDBlockDedup(passCRunLength(passBSupersededReads(passADedupe(messages))));
		const gStart = performance.now();
		passGShingleDedup(preGMessages);
		const passGAloneMs = performance.now() - gStart;

		// Default-pipeline-only result (A, B, C, D, G, E — no experimental extras).
		const defaultOnlyResult = compress(messages);
		const bytesAfterDefaultOnly = byteSize(defaultOnlyResult.messages);

		// Time the full pipeline (default A-G-E plus the experimental F extra) as it
		// would actually run per hook call if the extra were enabled.
		const fullStart = performance.now();
		const result = compress(messages, { extraPasses: EXTRA_PASSES_EXPERIMENTAL });
		const fullPipelineMs = performance.now() - fullStart;

		timings.push({ file, bytesBefore, passGAloneMs, fullPipelineMs });

		const bytesAfter = byteSize(result.messages);
		const integrity = checkIntegrity(messages, result.messages);
		if (!integrity.ok) anyIntegrityFailure = true;

		totalBefore += bytesBefore;
		totalAfter += bytesAfter;
		totalAfterDefaultOnly += bytesAfterDefaultOnly;

		rows.push({
			file,
			messages: messages.length,
			bytesBefore,
			bytesAfter,
			ratio: bytesBefore > 0 ? (1 - bytesAfter / bytesBefore) * 100 : 0,
			tokensBefore: tokenEstimate(bytesBefore),
			tokensAfter: tokenEstimate(bytesAfter),
			perPass: result.stats,
			integrity,
		});
	}

	console.log(
		"file".padEnd(46) +
			"msgs".padStart(6) +
			"bytesBefore".padStart(14) +
			"bytesAfter".padStart(14) +
			"ratio".padStart(9) +
			"tokBefore".padStart(11) +
			"tokAfter".padStart(11) +
			"integrity".padStart(11),
	);
	for (const r of rows) {
		const shortName = r.file.split("/").pop() ?? r.file;
		console.log(
			shortName.padEnd(46) +
				String(r.messages).padStart(6) +
				String(r.bytesBefore).padStart(14) +
				String(r.bytesAfter).padStart(14) +
				`${r.ratio.toFixed(2)}%`.padStart(9) +
				String(r.tokensBefore).padStart(11) +
				String(r.tokensAfter).padStart(11) +
				(r.integrity.ok ? "OK" : "FAIL").padStart(11),
		);
	}

	console.log("\nPer-pass byte contribution (aggregated across all sessions):");
	const passNames = rows[0]?.perPass.map((p) => p.name) ?? [];
	for (const name of passNames) {
		let pBefore = 0;
		let pAfter = 0;
		let hits = 0;
		for (const r of rows) {
			const stat = r.perPass.find((p) => p.name === name);
			if (!stat) continue;
			pBefore += stat.bytesBefore;
			pAfter += stat.bytesAfter;
			hits += stat.hits;
		}
		const passRatio = pBefore > 0 ? (1 - pAfter / pBefore) * 100 : 0;
		console.log(`  ${name.padEnd(24)} bytesBefore=${pBefore.toString().padStart(10)}  bytesAfter=${pAfter.toString().padStart(10)}  ratio=${passRatio.toFixed(3)}%  messagesTouched=${hits}`);
	}

	const defaultOnlyRatio = totalBefore > 0 ? (1 - totalAfterDefaultOnly / totalBefore) * 100 : 0;
	console.log(
		`\nAggregate (default pipeline only: A, B, C, D, G, E): bytesBefore=${totalBefore} bytesAfter=${totalAfterDefaultOnly} ratio=${defaultOnlyRatio.toFixed(3)}% ` +
			`tokensBefore=${tokenEstimate(totalBefore)} tokensAfter=${tokenEstimate(totalAfterDefaultOnly)}`,
	);

	const aggregateRatio = totalBefore > 0 ? (1 - totalAfter / totalBefore) * 100 : 0;
	console.log(
		`Aggregate (default pipeline + experimental F extra): bytesBefore=${totalBefore} bytesAfter=${totalAfter} ratio=${aggregateRatio.toFixed(3)}% ` +
			`tokensBefore=${tokenEstimate(totalBefore)} tokensAfter=${tokenEstimate(totalAfter)}`,
	);

	console.log("\nLatency (performance.now(), ms):");
	if (timings.length > 0) {
		const totalBytes = timings.reduce((s, t) => s + t.bytesBefore, 0);
		const totalKb = totalBytes / 1024;

		const summarize = (label: string, values: number[]) => {
			const total = values.reduce((s, v) => s + v, 0);
			const min = Math.min(...values);
			const max = Math.max(...values);
			const avg = total / values.length;
			const msPerKb = totalKb > 0 ? total / totalKb : 0;
			console.log(
				`  ${label.padEnd(24)} totalMs=${total.toFixed(2).padStart(10)}  min=${min.toFixed(3).padStart(8)}  max=${max.toFixed(3).padStart(9)}  avg=${avg.toFixed(3).padStart(8)}  ms/KB=${msPerKb.toFixed(4)}`,
			);
		};

		summarize(
			"G-alone",
			timings.map((t) => t.passGAloneMs),
		);
		summarize(
			"Full pipeline (A-G)",
			timings.map((t) => t.fullPipelineMs),
		);

		console.log(`  (n=${timings.length} sessions, ${totalBytes} total input bytes = ${totalKb.toFixed(1)} KB)`);
	} else {
		console.log("  no sessions timed");
	}

	const failures = rows.filter((r) => !r.integrity.ok);
	if (failures.length > 0) {
		console.log(`\nIntegrity FAILURES (${failures.length}):`);
		for (const r of failures) {
			console.log(`  ${r.file}`);
			for (const issue of r.integrity.issues) console.log(`    - ${issue}`);
		}
	} else {
		console.log("\nIntegrity: all sessions passed (message count, role sequence, tool_call/tool_result pairing intact).");
	}

	if (anyIntegrityFailure) process.exitCode = 1;
}

main();
