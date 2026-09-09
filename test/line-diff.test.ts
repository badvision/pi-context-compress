import { describe, expect, it } from "vitest";
import { bagOfLinesSimilarity, diffLines, renderDiff } from "../src/line-diff.js";

function applyDiff(ops: ReturnType<typeof diffLines>): string[] {
	return ops.filter((o) => o.op !== "remove").map((o) => o.line);
}

describe("diffLines", () => {
	it("produces a diff that reconstructs the after text exactly", () => {
		const before = ["a", "b", "c", "d"];
		const after = ["a", "b", "X", "d"];
		const ops = diffLines(before, after);
		expect(applyDiff(ops)).toEqual(after);
	});

	it("handles pure additions", () => {
		const before = ["a", "b"];
		const after = ["a", "b", "c"];
		const ops = diffLines(before, after);
		expect(applyDiff(ops)).toEqual(after);
	});

	it("handles pure removals", () => {
		const before = ["a", "b", "c"];
		const after = ["a", "c"];
		const ops = diffLines(before, after);
		expect(applyDiff(ops)).toEqual(after);
	});

	it("handles identical inputs (all equal ops)", () => {
		const before = ["a", "b", "c"];
		const ops = diffLines(before, before);
		expect(ops.every((o) => o.op === "equal")).toBe(true);
	});

	it("renderDiff marks adds/removes/equal distinctly for short runs", () => {
		const ops = diffLines(["a", "b"], ["a", "c"]);
		const rendered = renderDiff(ops);
		expect(rendered).toContain("  a");
		expect(rendered).toContain("- b");
		expect(rendered).toContain("+ c");
	});

	it("renderDiff collapses long equal runs to a count marker, keeping only edge context", () => {
		const before = Array.from({ length: 50 }, (_, i) => `line-${i}`);
		const after = [...before.slice(0, 25), "CHANGED", ...before.slice(26)];
		const ops = diffLines(before, after);
		const rendered = renderDiff(ops);
		expect(rendered).toContain("unchanged lines elided");
		expect(rendered).toContain("- line-25");
		expect(rendered).toContain("+ CHANGED");
		// should be far smaller than spelling out all 50 lines
		expect(rendered.length).toBeLessThan(before.join("\n").length);
	});
});

describe("bagOfLinesSimilarity", () => {
	it("returns 1 for identical line arrays", () => {
		expect(bagOfLinesSimilarity(["a", "b"], ["a", "b"])).toBe(1);
	});

	it("returns 0 for completely disjoint line arrays", () => {
		expect(bagOfLinesSimilarity(["a", "b"], ["c", "d"])).toBe(0);
	});

	it("returns a high score for mostly-overlapping arrays", () => {
		const sim = bagOfLinesSimilarity(["a", "b", "c", "d"], ["a", "b", "c", "X"]);
		expect(sim).toBeGreaterThan(0.7);
		expect(sim).toBeLessThan(1);
	});

	it("returns 1 for two empty arrays", () => {
		expect(bagOfLinesSimilarity([], [])).toBe(1);
	});
});
