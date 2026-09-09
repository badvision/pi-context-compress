import { createHash } from "node:crypto";

/**
 * Deterministic content hash for exact-duplicate detection. SHA-256 is
 * cheap enough for tool-result-sized strings and gives us collision
 * resistance we don't have to reason about.
 */
export function hashContent(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

export function byteLength(s: string): number {
	return Buffer.byteLength(s, "utf8");
}
