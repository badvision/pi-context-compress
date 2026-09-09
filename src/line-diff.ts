/**
 * Small, deterministic line-level LCS diff. Used by pass-e-near-dupe to
 * produce a lossless, reconstructable representation of "almost the same
 * text" tool results (e.g. the same file read after a one-line edit, or a
 * directory listing that only gained one new entry).
 *
 * This is NOT a general-purpose diff library — it's bounded and simple on
 * purpose. Callers must gate on size before calling `diffLines` (see
 * MAX_DIFF_LINES) since the LCS table is O(n*m).
 */

export const MAX_DIFF_LINES = 400;

export type DiffOp = { op: "equal" | "add" | "remove"; line: string };

/**
 * Classic LCS-based line diff. Returns an ordered list of ops that,
 * applied in sequence, reconstruct `after` from `before` (equal lines are
 * shared context, add/remove lines are the delta).
 */
export function diffLines(before: string[], after: string[]): DiffOp[] {
	const n = before.length;
	const m = after.length;
	// dp[i][j] = length of LCS of before[i..] and after[j..]
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i][j] = before[i] === after[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}

	const ops: DiffOp[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (before[i] === after[j]) {
			ops.push({ op: "equal", line: before[i] });
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			ops.push({ op: "remove", line: before[i] });
			i++;
		} else {
			ops.push({ op: "add", line: after[j] });
			j++;
		}
	}
	while (i < n) {
		ops.push({ op: "remove", line: before[i] });
		i++;
	}
	while (j < m) {
		ops.push({ op: "add", line: after[j] });
		j++;
	}

	return ops;
}

const EQUAL_RUN_CONTEXT = 2;

/**
 * Render diff ops as a compact, lossless patch. Long runs of unchanged
 * lines (more than 2x context) are collapsed to a count marker instead of
 * being spelled out — reconstruction still works because the reader has
 * the referenced original block and the op sequence's ordinal position is
 * unambiguous; only add/remove lines need their literal text here. Short
 * equal runs are kept as context so the diff reads naturally near a change.
 */
export function renderDiff(ops: DiffOp[]): string {
	const out: string[] = [];
	let i = 0;

	while (i < ops.length) {
		if (ops[i].op !== "equal") {
			const op = ops[i];
			out.push(op.op === "add" ? `+ ${op.line}` : `- ${op.line}`);
			i++;
			continue;
		}

		let j = i;
		while (j < ops.length && ops[j].op === "equal") j++;
		const runLength = j - i;

		if (runLength <= EQUAL_RUN_CONTEXT * 2) {
			for (let k = i; k < j; k++) out.push(`  ${ops[k].line}`);
		} else {
			for (let k = i; k < i + EQUAL_RUN_CONTEXT; k++) out.push(`  ${ops[k].line}`);
			out.push(`  ... (${runLength - EQUAL_RUN_CONTEXT * 2} unchanged lines elided) ...`);
			for (let k = j - EQUAL_RUN_CONTEXT; k < j; k++) out.push(`  ${ops[k].line}`);
		}
		i = j;
	}

	return out.join("\n");
}

/** Cheap O(n+m) similarity estimate via multiset (bag-of-lines) overlap. Not as precise as an LCS ratio, but fast enough to gate expensive diffing. */
export function bagOfLinesSimilarity(a: string[], b: string[]): number {
	if (a.length === 0 && b.length === 0) return 1;
	const counts = new Map<string, number>();
	for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);

	let common = 0;
	for (const line of b) {
		const remaining = counts.get(line) ?? 0;
		if (remaining > 0) {
			common++;
			counts.set(line, remaining - 1);
		}
	}

	return (2 * common) / (a.length + b.length);
}
