import { byteLength } from "./hash.js";
import { isToolResultMessage, type CompressMessage, type ToolResultMessage } from "./types.js";

const DEFAULT_SHINGLE_LENGTH = 64;
const DEFAULT_MIN_REPEAT_LENGTH = 64;
const HASH_BASE = 257;
const HASH_MOD = 1_000_000_007;

export interface PassGOptions {
	/** Rolling-hash window ("shingle") length in bytes. Larger windows reduce false-positive hash collisions but miss shorter repeats. */
	shingleLength?: number;
	/** Minimum verified matched-run length (bytes) before a repeat is collapsed. Always clamped to at least shingleLength. */
	minRepeatLength?: number;
	/**
	 * Number of trailing toolResult messages protected from substring collapse.
	 * Fresh output is what the model is actively reasoning about; the token
	 * savings from collapsing inside this window are negligible while the
	 * disruption cost is highest there. 0 (default) = no protection.
	 * Protected messages are still committed to the match corpus, so other
	 * messages can reference their content.
	 */
	recentWindow?: number;
}

interface Occurrence {
	toolCallId: string;
	/** Offset into the conceptual "corpus so far" stream (all original tool-result text, in session order, concatenated). */
	globalOffset: number;
}

function mod(a: number, m: number): number {
	return ((a % m) + m) % m;
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * base^exponent mod m, used to remove the outgoing byte's contribution when
 * sliding the rolling hash window. Computed with BigInt: repeated squaring
 * of a ~1e9-range Number would overflow Number.MAX_SAFE_INTEGER (b*b can
 * reach ~1e18) and silently corrupt the result via float rounding, so the
 * squaring itself must happen at arbitrary precision even though the final
 * result is small enough to hand back as a Number.
 */
function modPow(base: number, exponent: number, m: number): number {
	let result = 1n;
	let b = BigInt(base) % BigInt(m);
	let e = exponent;
	const bigM = BigInt(m);
	while (e > 0) {
		if (e & 1) result = (result * b) % bigM;
		b = (b * b) % bigM;
		e >>= 1;
	}
	return Number(result);
}

/**
 * Read a global-stream character code at `pos`, where the stream is
 * conceptually `corpus` (everything committed from earlier blocks) followed
 * by `currentText` (the block currently being scanned, not yet committed).
 */
function charCodeAtGlobal(corpus: string, currentText: string, corpusOffsetBase: number, pos: number): number {
	if (pos < corpus.length) return corpus.charCodeAt(pos);
	return currentText.charCodeAt(pos - corpusOffsetBase);
}

/**
 * Read a global-stream slice, transparently spanning the corpus/currentText
 * boundary if needed (a match found near the end of the committed corpus
 * can legitimately continue into the block being scanned).
 */
function sliceGlobal(corpus: string, currentText: string, corpusOffsetBase: number, pos: number, len: number): string {
	const end = pos + len;
	if (end <= corpus.length) return corpus.slice(pos, end);
	if (pos >= corpusOffsetBase) return currentText.slice(pos - corpusOffsetBase, end - corpusOffsetBase);
	return corpus.slice(pos) + currentText.slice(0, end - corpus.length);
}

/**
 * Scan `text` for byte runs that have already appeared verbatim earlier in
 * the session (tracked via `hashIndex`, keyed by a rolling hash over
 * fixed-length shingles), and replace verified repeats with a short marker.
 *
 * Detection is O(n): the rolling hash lets each shingle's hash be derived
 * from the previous one in O(1), so no shingle is ever rehashed from
 * scratch. Every hash hit is verified against the actual bytes (via
 * sliceGlobal) before being trusted, so hash collisions can never corrupt
 * content — at worst they cost a wasted comparison.
 */
function collapseRepeats(
	text: string,
	corpus: string,
	hashIndex: Map<number, Occurrence>,
	toolCallId: string,
	corpusOffsetBase: number,
	shingleLength: number,
	minRepeatLength: number,
): { text: string; changed: boolean } {
	const n = text.length;
	if (n < shingleLength) return { text, changed: false };

	const highPow = modPow(HASH_BASE, shingleLength - 1, HASH_MOD);

	let hash = 0;
	for (let k = 0; k < shingleLength; k++) {
		hash = (hash * HASH_BASE + text.charCodeAt(k)) % HASH_MOD;
	}

	const out: string[] = [];
	let segmentStart = 0;
	let i = 0;
	let changed = false;

	while (i + shingleLength <= n) {
		const candidate = hashIndex.get(hash);
		let collapsedHere = false;

		if (candidate) {
			const candidateWindow = sliceGlobal(corpus, text, corpusOffsetBase, candidate.globalOffset, shingleLength);
			if (candidateWindow === text.slice(i, i + shingleLength)) {
				// Verified shingle-level match; greedily extend forward one byte at a time.
				let matchLen = shingleLength;
				const maxExtend = n - i; // can never extend past the end of the text we're scanning
				while (
					matchLen < maxExtend &&
					text.charCodeAt(i + matchLen) === charCodeAtGlobal(corpus, text, corpusOffsetBase, candidate.globalOffset + matchLen)
				) {
					matchLen++;
				}

				// Snap the collapsed span inward so it never splits a UTF-16
				// surrogate pair. `text` (and the earlier occurrence, verified
				// byte-for-byte equal above) may be well-formed Unicode where a
				// character happens to straddle the shingle boundary; slicing
				// there would leave a lone surrogate in the output, which
				// corrupts to U+FFFD on UTF-8 encoding. Shrinking (never
				// expanding) the collapsed span is always safe: the excluded
				// unit(s) simply fall back to literal, unmatched text and get
				// re-paired with their other half on the next segment.
				let collapseStart = i;
				let collapseLen = matchLen;
				if (collapseStart > 0 && isHighSurrogate(text.charCodeAt(collapseStart - 1)) && isLowSurrogate(text.charCodeAt(collapseStart))) {
					collapseStart += 1;
					collapseLen -= 1;
				}
				if (collapseLen > 0) {
					const lastIdx = collapseStart + collapseLen - 1;
					if (lastIdx + 1 < n && isHighSurrogate(text.charCodeAt(lastIdx)) && isLowSurrogate(text.charCodeAt(lastIdx + 1))) {
						collapseLen -= 1;
					}
				}

				const collapsedSlice = text.slice(collapseStart, collapseStart + collapseLen);
				const marker = `[repeated substring, ${byteLength(collapsedSlice)} bytes, see earlier occurrence in toolCallId ${candidate.toolCallId}]`;
				if (collapseLen >= minRepeatLength && marker.length < collapsedSlice.length) {
					out.push(text.slice(segmentStart, collapseStart));
					out.push(marker);
					changed = true;
					collapsedHere = true;

					i += matchLen;
					segmentStart = collapseStart + collapseLen;

					if (i + shingleLength <= n) {
						hash = 0;
						for (let k = 0; k < shingleLength; k++) {
							hash = (hash * HASH_BASE + text.charCodeAt(i + k)) % HASH_MOD;
						}
					}
				}
			}
		}

		if (collapsedHere) continue;

		// No usable match at this position: remember the first-seen occurrence of this shingle, then slide the window by one byte.
		if (!hashIndex.has(hash)) {
			hashIndex.set(hash, { toolCallId, globalOffset: corpusOffsetBase + i });
		}

		if (i + shingleLength < n) {
			const outgoing = text.charCodeAt(i);
			const incoming = text.charCodeAt(i + shingleLength);
			hash = mod(hash - outgoing * highPow, HASH_MOD);
			hash = (hash * HASH_BASE + incoming) % HASH_MOD;
		}
		i++;
	}

	out.push(text.slice(segmentStart));
	return { text: out.join(""), changed };
}

/**
 * Pass G — Repeated-substring collapse via rolling-hash shingles.
 *
 * Motivated by a corpus finding that ~85% of apparent repetition in real
 * sessions is tool-output boilerplate embedded as a *substring* inside
 * otherwise-different blocks (e.g. a fixed startup banner printed by a
 * long-running process, surrounded each time by different stdout/state).
 * Pass A and Pass D only collapse whole-block exact duplicates, so they
 * never catch this — the containing block differs, only a chunk within it
 * repeats.
 *
 * This pass is deliberately generic: it has no knowledge of any specific
 * tool, banner, or string. It breaks every toolResult text block into
 * fixed-length overlapping shingles, hashes each with an O(1)-per-shift
 * rolling hash, and looks up whether that shingle has been seen verbatim
 * anywhere earlier in the session (across blocks, not just within one).
 * Verified matches (hash hit + direct byte comparison) are greedily
 * extended and, if long enough to be worth the marker overhead, the
 * matched substring — and only that substring — is replaced in place. All
 * unique surrounding content in the same block is left untouched.
 *
 * Promoted to the default pipeline after real-session validation showed it
 * was the second-largest contributor after pass D (see
 * scripts/validate-sessions.ts output), with negligible added latency, and
 * after a hardening pass confirmed it is safe against pathological
 * repetition, multi-megabyte blocks, and multi-byte/Unicode content
 * (surrogate-pair-safe boundary snapping — see collapseRepeats above).
 *
 * Same invariant as passes A-F: never removes a message, never breaks
 * tool_call/tool_result pairing — only shrinks text content in place.
 */
export function passGShingleDedup(messages: CompressMessage[], options: PassGOptions = {}): CompressMessage[] {
	const shingleLength = options.shingleLength ?? DEFAULT_SHINGLE_LENGTH;
	const minRepeatLength = Math.max(options.minRepeatLength ?? DEFAULT_MIN_REPEAT_LENGTH, shingleLength);
	const recentWindow = options.recentWindow ?? 0;

	const hashIndex = new Map<number, Occurrence>();
	let corpus = "";

	return messages.map((message, index) => {
		if (!isToolResultMessage(message)) return message;

		// Low-disruption tuning: never rewrite the freshest tool results — that is
		// what the model is actively working on. Their original text is still
		// committed to the corpus so other messages can match against it.
		if (index >= messages.length - recentWindow) {
			for (const block of message.content) {
				if (block.type === "text") corpus += block.text;
			}
			return message;
		}

		let changed = false;
		const content = message.content.map((block) => {
			if (block.type !== "text") return block;

			const corpusOffsetBase = corpus.length;
			const { text: rewritten, changed: blockChanged } = collapseRepeats(
				block.text,
				corpus,
				hashIndex,
				message.toolCallId,
				corpusOffsetBase,
				shingleLength,
				minRepeatLength,
			);

			// Always commit the ORIGINAL text to the corpus, never the rewritten
			// (marker-containing) text — future blocks must be able to match
			// against real content, not against our own markers.
			corpus += block.text;

			if (blockChanged) {
				changed = true;
				return { ...block, text: rewritten };
			}
			return block;
		});

		if (!changed) return message;
		const updated: ToolResultMessage = { ...message, content };
		return updated;
	});
}
