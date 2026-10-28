import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/**
 * Turn an untrusted SAP name into a filesystem-safe, Windows-safe segment.
 *
 * - Namespace separators (`/NAMESPACE/NAME`) become `~`.
 * - Other unsafe characters become `_`.
 * - Windows-reserved device names are prefixed with `_`.
 * - Trailing dots/spaces are removed.
 * - Long or lossy conversions get an 8-hex SHA-256 suffix to avoid collisions.
 *
 * The original SAP spelling is always preserved in `metadata.json`.
 */
export function sanitizeSegment(raw: string, maxLength = 80): string {
  const original = raw.trim();
  if (!original) return "_";

  let key = original
    .replace(/\//g, "~")
    .replace(/[^A-Za-z0-9._~-]/g, "_")
    .replace(/[. ]+$/g, "");

  if (!key) key = "_";
  if (WINDOWS_RESERVED.test(key)) key = `_${key}`;

  const normalizedOriginal = original.replace(/\//g, "~");
  const needsHash = key !== normalizedOriginal || key.length > maxLength;
  if (key.length > maxLength) key = key.slice(0, maxLength);
  if (needsHash) {
    const hash = createHash("sha256").update(original.toUpperCase()).digest("hex").slice(0, 8);
    key = `${key.slice(0, Math.max(1, maxLength - 9))}-${hash}`;
  }
  return key;
}

/** Safe directory key for an object (canonical names are upper-cased). */
export function objectKey(canonicalName: string): string {
  return sanitizeSegment(canonicalName);
}

/** Safe directory key for a package; unknown packages go to `_unassigned`. */
export function packageKey(packageName?: string): string {
  const trimmed = packageName?.trim();
  return trimmed ? sanitizeSegment(trimmed) : "_unassigned";
}

/** Resolve a path and refuse anything outside the repository root. */
export function assertInside(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolved = resolve(candidate);
  const rel = relative(resolvedRoot, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Refusing to access a path outside the repository root: ${candidate}`);
  }
  return resolved;
}
