/**
 * Heuristic, deterministic (regex-only, no LLM) extraction of file
 * read/write operations from a tool call's arguments.
 *
 * The real corpus this was validated against (see scripts/validate-sessions.ts)
 * uses a single "ipython" tool for everything — there is no dedicated
 * "read_file" or "write_file" tool. File I/O happens as Python source
 * (`open(...)`, `Path(...).read_text()`, `%%bash` cells with `cat`/redirection,
 * etc). This module recognizes common patterns; anything it can't confidently
 * classify is ignored (safer to under-detect than to mislabel a read as a
 * write and wrongly elide live content).
 */

export interface FileOp {
	path: string;
	kind: "read" | "write";
}

const PY_OPEN_RE = /\bopen\(\s*(?:r|rb|f)?['"]([^'"]+)['"]\s*(?:,\s*['"]([a-zA-Z]+)['"])?/g;
const PY_PATH_READ_RE = /\bPath\(\s*['"]([^'"]+)['"]\s*\)\s*\.\s*read_(?:text|bytes)\s*\(/g;
const PY_PATH_WRITE_RE = /\bPath\(\s*['"]([^'"]+)['"]\s*\)\s*\.\s*write_(?:text|bytes)\s*\(/g;

const WRITE_MODES = new Set(["w", "wb", "a", "ab", "x", "xb", "w+", "a+"]);

function extractPython(code: string): FileOp[] {
	const ops: FileOp[] = [];

	for (const match of code.matchAll(PY_OPEN_RE)) {
		const path = match[1];
		const mode = match[2];
		if (!path) continue;
		ops.push({ path, kind: mode && WRITE_MODES.has(mode) ? "write" : "read" });
	}

	for (const match of code.matchAll(PY_PATH_READ_RE)) {
		if (match[1]) ops.push({ path: match[1], kind: "read" });
	}

	for (const match of code.matchAll(PY_PATH_WRITE_RE)) {
		if (match[1]) ops.push({ path: match[1], kind: "write" });
	}

	return ops;
}

const BASH_READ_CMD_RE = /(?:^|[;&|\n]|&&)\s*(?:cat|head|tail|less|more)\s+(?:-\S+\s+)*(\S+)/g;
const BASH_WRITE_REDIRECT_RE = />{1,2}\s*(\S+)/g;

function extractBash(command: string): FileOp[] {
	const ops: FileOp[] = [];

	for (const match of command.matchAll(BASH_READ_CMD_RE)) {
		const path = match[1];
		if (path && !path.startsWith("-")) ops.push({ path, kind: "read" });
	}

	for (const match of command.matchAll(BASH_WRITE_REDIRECT_RE)) {
		if (match[1]) ops.push({ path: match[1], kind: "write" });
	}

	return ops;
}

/**
 * Extract file read/write operations implied by a tool call's name and
 * arguments. Returns an empty array when the tool/arguments shape isn't
 * recognized.
 */
export function extractFileOps(toolName: string, args: Record<string, unknown>): FileOp[] {
	if (toolName === "edit" && typeof args.path === "string") {
		return [{ path: args.path, kind: "write" }];
	}

	if ((toolName === "write" || toolName === "write_file" || toolName === "create_file") && typeof args.path === "string") {
		return [{ path: args.path, kind: "write" }];
	}

	if ((toolName === "read" || toolName === "read_file" || toolName === "view") && typeof args.path === "string") {
		return [{ path: args.path, kind: "read" }];
	}

	if (toolName === "bash" && typeof args.command === "string") {
		return extractBash(args.command);
	}

	if (toolName === "ipython" && typeof args.code === "string") {
		const code = args.code;
		if (code.trimStart().startsWith("%%bash")) {
			return extractBash(code);
		}
		return extractPython(code);
	}

	return [];
}
