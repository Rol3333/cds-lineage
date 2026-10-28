import { createHash } from "node:crypto";

/** SHA-256 of the UTF-8 encoding of `text`. */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
