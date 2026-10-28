import { spawn } from "node:child_process";
import type { ProcessAdapter, ProcessResult } from "./types.js";

/**
 * Spawn-based process adapter.
 *
 * The `adt` CLI is installed as an npm shim (`adt.cmd` on Windows, `adt` shell
 * script elsewhere), which Node cannot execute without a shell. We therefore
 * run with `shell: true` on Windows. Arguments are always passed as an array
 * and the caller is responsible for validating any dynamic argument; this code
 * never builds a shell command string from untrusted input.
 */
export class NodeProcessAdapter implements ProcessAdapter {
  private readonly shell: boolean;

  constructor(options: { shell?: boolean } = {}) {
    this.shell = options.shell ?? process.platform === "win32";
  }

  run(
    command: string,
    args: string[],
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ProcessResult> {
    return new Promise<ProcessResult>((resolve) => {
      const child = spawn(command, args, {
        shell: this.shell,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stdout: Buffer[] = [];
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const finish = (result: ProcessResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const kill = (): void => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      };

      const timer = options?.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            kill();
          }, options.timeoutMs)
        : undefined;

      if (options?.signal) {
        if (options.signal.aborted) {
          if (timer) clearTimeout(timer);
          timedOut = true;
          kill();
          finish({ exitCode: null, stdout: Buffer.concat(stdout), stderr, timedOut: true });
          return;
        }
        options.signal.addEventListener(
          "abort",
          () => {
            if (timer) clearTimeout(timer);
            timedOut = true;
            kill();
          },
          { once: true },
        );
      }

      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        finish({
          exitCode: null,
          stdout: Buffer.concat(stdout),
          stderr: stderr ? `${stderr}\n${err.message}` : err.message,
          timedOut: false,
        });
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        finish({ exitCode: code, stdout: Buffer.concat(stdout), stderr, timedOut });
      });
    });
  }
}
