/**
 * Decode DDL source bytes emitted by the ADT CLI.
 *
 * SAP DDL sources are UTF-16 LE with a BOM (`FF FE`) in practice. We also
 * tolerate UTF-16 BE, UTF-8 (with/without BOM), and UTF-16 without a BOM via a
 * simple null-byte heuristic, so the same code works for hand-written fixtures.
 */

export function decodeSource(buffer: Buffer): string {
  if (buffer.length === 0) return "";

  // UTF-8 BOM
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString("utf8");
  }
  // UTF-16 LE BOM
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }
  // UTF-16 BE BOM
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return decodeUtf16Be(buffer.subarray(2));
  }

  // Heuristic: many NUL bytes → UTF-16 LE without BOM.
  const sample = buffer.subarray(0, Math.min(buffer.length, 256));
  let nuls = 0;
  for (const b of sample) if (b === 0) nuls++;
  if (nuls > sample.length / 4) return buffer.toString("utf16le");

  return buffer.toString("utf8");
}

function decodeUtf16Be(buffer: Buffer): string {
  const swapped = Buffer.alloc(buffer.length);
  for (let i = 0; i + 1 < buffer.length; i += 2) {
    swapped[i] = buffer[i + 1]!;
    swapped[i + 1] = buffer[i]!;
  }
  return swapped.toString("utf16le");
}

/** Decode a string file body (fixtures) using the same rules. */
export function decodeSourceText(text: string): string {
  if (text.charCodeAt(0) === 0xfeff) return text.slice(1);
  return text;
}
