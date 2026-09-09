import { describe, expect, it } from "vitest";
import { extractFileOps } from "../src/file-ops.js";

describe("extractFileOps", () => {
	it("detects a plain open() read", () => {
		expect(extractFileOps("ipython", { code: "open('/tmp/a.txt').read()" })).toEqual([
			{ path: "/tmp/a.txt", kind: "read" },
		]);
	});

	it("detects open() with explicit read mode", () => {
		expect(extractFileOps("ipython", { code: "open('/tmp/a.txt', 'r').read()" })).toEqual([
			{ path: "/tmp/a.txt", kind: "read" },
		]);
	});

	it("detects open() with write mode", () => {
		expect(extractFileOps("ipython", { code: "open('/tmp/a.txt', 'w').write('x')" })).toEqual([
			{ path: "/tmp/a.txt", kind: "write" },
		]);
	});

	it("detects Path().read_text()", () => {
		expect(extractFileOps("ipython", { code: "Path('/tmp/a.txt').read_text()" })).toEqual([
			{ path: "/tmp/a.txt", kind: "read" },
		]);
	});

	it("detects Path().write_text()", () => {
		expect(extractFileOps("ipython", { code: "Path('/tmp/a.txt').write_text('hi')" })).toEqual([
			{ path: "/tmp/a.txt", kind: "write" },
		]);
	});

	it("detects bash cat as a read", () => {
		expect(extractFileOps("bash", { command: "cat /tmp/a.txt" })).toEqual([{ path: "/tmp/a.txt", kind: "read" }]);
	});

	it("detects bash redirection as a write", () => {
		expect(extractFileOps("bash", { command: "echo hi > /tmp/a.txt" })).toEqual([{ path: "/tmp/a.txt", kind: "write" }]);
	});

	it("detects %%bash cell magic inside ipython", () => {
		expect(extractFileOps("ipython", { code: "%%bash\ncat /tmp/a.txt" })).toEqual([
			{ path: "/tmp/a.txt", kind: "read" },
		]);
	});

	it("treats edit tool calls as a write to their path", () => {
		expect(extractFileOps("edit", { path: "/tmp/a.txt", edits: [] })).toEqual([{ path: "/tmp/a.txt", kind: "write" }]);
	});

	it("returns empty for unrecognized tools", () => {
		expect(extractFileOps("weather", { city: "nyc" })).toEqual([]);
	});

	it("returns empty for ipython code with no file I/O", () => {
		expect(extractFileOps("ipython", { code: "print(1 + 1)" })).toEqual([]);
	});
});
