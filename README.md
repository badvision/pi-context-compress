# context-compress (Pi extension)

Deterministic, lossless context compression for the [Pi](https://github.com/earendil-works/pi-coding-agent) coding agent (prime-agent). Before every LLM call, the agent fires its `context` lifecycle event with a deep copy of the message history; this extension scans that copy, elides tool-output content the model has already seen, and returns the shrunk messages for the outgoing request. The session on disk is never modified.

> **Sibling repo**: the [opencode port of this plugin](https://github.com/badvision/opencode-context-compress) lives at [github.com/badvision/opencode-context-compress](https://github.com/badvision/opencode-context-compress).

## How it works

- **Hook**: `pi.on("context", handler)` — fires before each LLM call with a deep copy of the message array. Returning `{ messages }` replaces what is sent to the LLM for that call. The event is explicitly documented by Pi as non-destructive to session storage, so nothing is ever written back to disk.
- **Targets**: `toolResult` message content (text blocks) and assistant `toolCall` string arguments (e.g. `command`, `code`). User input and everything else is never touched.
- **Safe by invariant**: it never removes or reorders messages, so toolCall/toolResult pairing is always intact. Every elision is "lossless" in the sense that marker + the referenced earlier occurrence reconstructs the original; if the model needs the content again it can just re-run the tool.
- **No LLM calls**: all passes are pure synchronous string/array transforms. The only runtime import outside Node built-ins is the Pi package, used for **types only** (`src/types.ts` mirrors Pi's `AgentMessage` union locally so the core is unit-testable standalone).

### The pipeline (execution order A → B → C → D → G → E)

| Pass | What it does | Example marker |
|---|---|---|
| A — dedupe | A tool result whose entire content byte-matches an earlier one (≥ 40 B) | `[identical to output of toolCallId tc_123, 48213 bytes elided]` |
| B — superseded reads | A file read where the same path was read → written → read again; the stale read is elided (file ops classified by regex in `src/file-ops.ts`) | `[stale: file (/src/foo.ts) was modified after this read, see later read for current content — 2048 chars elided]` |
| C — runlength | 3+ consecutive identical lines in a tool result | `hello (×4)` |
| D — block dedupe | Per-block (text/image) exact duplicate ≥ 200 B — catches identical images with slightly different sibling text | `[identical text block to output of toolCallId tc_456, 2048 bytes elided]` |
| G — shingle dedupe | Rolling-hash detection of repeated substrings ≥ 1 KB anywhere earlier in the session (verified byte-for-byte, surrogate-pair-safe). The 6 most recent tool results are protected from rewriting (still indexable as match sources). | `[repeated substring, 4096 bytes, see earlier occurrence in toolCallId tc_789]` |
| E — near-dupe | Near-duplicate collapse (≥ 512 B, ≥ 92% line similarity) using a lossless LCS line diff; also applies to assistant toolCall string arguments (re-typed code pattern) | `[near-duplicate of toolCallId tc_321 (95% similar), lossless line diff follows]` + diff |

A seventh pass, **F — minify** (trailing whitespace, blank-run collapse, JSON compaction with round-trip verification), is fully implemented and tested but **not enabled** by default; it is the intended `extraPasses` experiment candidate.

## Installation

The extension uses the standard Pi "package with dependencies" layout — a directory with a `package.json` declaring the entry point — so it installs the same way on upstream Pi and on prime-agent (a Pi fork). Only the extensions directory differs.

### Pi (upstream)

1. Copy this folder into the global extensions directory:

   ```sh
   mkdir -p ~/.pi/agent/extensions
   cp -R <this-folder> ~/.pi/agent/extensions/context-compress
   ```

2. Install dependencies (the Pi package is a runtime dependency for types; vitest/tsx/typescript for dev):

   ```sh
   cd ~/.pi/agent/extensions/context-compress
   npm install
   ```

3. No registration step is needed: Pi auto-discovers package-style extension directories (a `package.json` with a `pi.extensions` entry, per the [Pi extensions documentation](https://pi.dev/docs/latest/extensions)) and resolves the entry point from:

   ```json
   "pi": { "extensions": [ "./src/index.ts" ] }
   ```

   That doc page also covers project-local placement (`.pi/extensions/`), extra paths via `settings.json`, and npm/git distribution as pi packages. For a quick test without installing: `pi -e ./src/index.ts`. Auto-discovered extensions can be hot-reloaded with `/reload`.

### prime-agent (Pi fork)

1. Copy this folder into prime-agent's extensions directory:

   ```sh
   mkdir -p ~/.prime/agent/extensions
   cp -R <this-folder> ~/.prime/agent/extensions/context-compress
   ```

2. Install dependencies:

   ```sh
   cd ~/.prime/agent/extensions/context-compress
   npm install
   ```

3. No registration step is needed: prime-agent's extension loader discovers `~/.prime/agent/extensions/<dir>/` and resolves the entry point from the same `package.json` `pi.extensions` key.

4. Restart the agent.

### Uninstall

Delete the extension folder (then restart, or `/reload` in upstream Pi). Nothing else is touched.

## Configuration

There are no environment variables or settings keys — behavior is controlled by constants in `src/index.ts`:

```ts
const options: CompressOptions = {
	passGShingleDedup: { minRepeatLength: 1024, recentWindow: 6 },
	passENearDupe: { minLength: 512, similarityThreshold: 0.92 },
};
```

| Option | Default (live) | Meaning |
|---|---|---|
| `passGShingleDedup.minRepeatLength` | `1024` | Minimum verified repeated-substring length (bytes) for pass G. Lower = more aggressive, risk of eliding small meaningful fragments. |
| `passGShingleDedup.recentWindow` | `6` | Number of most-recent tool results protected from pass G rewriting (still indexable as match sources). |
| `passENearDupe.minLength` | `512` | Minimum block/argument size (bytes) for pass E near-duplicate collapse. |
| `passENearDupe.similarityThreshold` | `0.92` | Minimum bag-of-lines similarity (0–1) for pass E. |

Exact-match passes (A/B/C/D) use their built-in defaults (`src/compress.ts`); see each `pass-*.ts` header for their thresholds.

The live values above were tuned on 2026-09-05 after more aggressive settings collapsed short shared code fragments (e.g. an identical 117-byte function prefix) into markers. If you lower a threshold, watch for over-elision of small but meaningful repeated snippets.

**Rebuild discipline**: after editing `src/`, run `npm test` before restarting the agent.

### Observability

The extension registers a `/compression-stats` command. Run it in a session to see how much the last compression pass shrank the conversation (per-pass byte shrinkage, via `ctx.ui.notify`).

## Results to expect

**Per transform**: small, precise wins. The smoke test collapsed `hello\nhello\nhello\nhello\n` (24 B) to `hello (×4)` (12 B). Savings scale with how much your session repeats itself.

**In a typical coding session** you can expect elisions when:

- The same file is read, edited, and read again → pass B elides the stale read.
- An identical command is re-run (e.g. `git status`, repeated `ls`) → pass A elides the byte-identical output.
- A large file is read twice, or a big chunk appears in two different outputs → pass G references the first occurrence.
- The model re-types code nearly verbatim (patch then full write) → pass E sends a lossless diff instead.
- Tools emit repeated line runs (spinners, progress logs, columnar output) → pass C run-lengths them.

**What you will NOT see**:

- Any change to the stored session — the full tool outputs remain in session storage.
- Any removed/reordered messages, broken toolCall/toolResult pairing, or LLM calls made by the extension.
- Compression of your own prompts or the assistant's prose.
- A fixed percentage: a session with little repetition saves little.

**How to verify it's live**: run a session where some tool output repeats (e.g. ask it to run the same command twice), then run `/compression-stats` — a non-zero shrink with per-pass breakdown means it fired.

## Tests

```sh
cd ~/.prime/agent/extensions/context-compress
npm test          # vitest run — 11 files / 90 tests
npm run validate  # tsx scripts/validate-sessions.ts — validates the pipeline against real recorded Pi session data
```

The core tests pin the pipeline behavior, the pass order A→B→C→D→G→E, and the invariants (no removal/reorder, pairing intact, lossless markers).

## Caveats

- **Pi API version-pinned**: the extension is built and tested against `@earendil-works/pi-coding-agent@^0.84.4`. Re-verify the `context` event contract (deep copy, non-destructive, `{ messages }` return) after Pi upgrades.
- **Pass F is off**: enabling `passFMinify` (e.g. via `extraPasses`) is a deliberate experiment, not a bug.
