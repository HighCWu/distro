// SPDX-License-Identifier: MIT
import type { ChildProcess, CommandStatus } from "./process.ts";

/** The collected result of a command. Nonzero status does not reject run(). */
export interface RunResult {
  readonly status: CommandStatus;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

/** @internal Collect the public run() result from one owned child. */
export async function collect_run_result(
  child: Pick<ChildProcess, "status" | "stdout" | "stderr" | "stdin" | "close">,
): Promise<RunResult> {
  let failed = false;
  let primary: unknown;
  try {
    const [status, stdout, stderr] = await Promise.all([
      child.status,
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).arrayBuffer(),
      child.stdin.close(),
    ]);
    return { status, stdout: new Uint8Array(stdout), stderr: new Uint8Array(stderr) };
  } catch (error) {
    failed = true;
    primary = error;
    throw error;
  } finally {
    try {
      await child.close();
    } catch (cleanupError) {
      // Do not silently replace the original transport/abort reason with a
      // secondary cleanup error. AggregateError is standard ES2021.
      if (failed) {
        throw new AggregateError([primary, cleanupError], "command execution and cleanup failed", {
          cause: primary,
        });
      }
      throw cleanupError;
    }
  }
}
