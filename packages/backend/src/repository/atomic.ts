import { randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Write a file via a temporary file in the same directory + atomic rename.
 * Retries transient Windows `EPERM`/`EBUSY` errors caused by virus scanners or
 * indexers holding the destination briefly.
 */
export async function writeFileAtomic(file: string, data: string | Buffer): Promise<void> {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;

  if (typeof data === "string") await writeFile(tmp, data, { encoding: "utf8" });
  else await writeFile(tmp, data);

  await renameWithRetry(tmp, file);
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      lastError = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EEXIST" && code !== "EACCES") break;
      await delay(25 * (attempt + 1));
    }
  }
  throw lastError;
}
