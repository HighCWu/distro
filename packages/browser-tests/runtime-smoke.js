// SPDX-License-Identifier: MIT
import { LineDecoder, parseResult } from "./protocol.js";

export async function runRuntimeSmoke({
  bootMachine,
  consoleDevice,
  entropyDevice,
  loadInitramfs,
  timeoutMs = 120_000,
  onProgress,
  completionReady,
}) {
  // Test diagnostics must not change pass/failure or cleanup semantics.
  const trace = (message) => {
    try {
      onProgress?.(message);
    } catch {}
  };
  let machine;
  let finished = false;
  let failed = false;
  let reportedPass = false;
  let runtimeFailure;
  let phase = "user runtime";
  let timer;
  let output = "";
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  void result.catch(() => {});
  const reportFailure = (error) => {
    // Device abort can arrive before machine.closed rejects with the original
    // Worker failure. Log every cause, even after the first rejection wins.
    trace(
      `runtime failure: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    runtimeFailure ??= error instanceof Error ? error : new Error(String(error));
    rejectResult(runtimeFailure);
  };
  const consoleOutput = (required) => {
    const decoder = new LineDecoder();
    const consume = (lines) => {
      for (const line of lines) {
        output += `${line}\n`;
        trace(`${required ? "user" : "boot"}: ${line}`);
        // Only the user console owns the test protocol. Boot diagnostics must
        // remain visible, but cannot certify that the user program ran.
        const status = required ? parseResult(line) : undefined;
        if (status?.passed) {
          reportedPass = true;
        } else if (status)
          reportFailure(new Error(`${status.reason}\nRuntime console:\n${output}`));
        else if (line.includes("Kernel panic - not syncing")) reportFailure(new Error(line));
        // A diagnostic build may still have records queued on other Worker
        // ports after the user console reports pass. Do not terminate those
        // Workers until the test-only output gate is satisfied. The same
        // watchdog bounds missing records; default callers have no extra gate.
        if (reportedPass && !runtimeFailure) {
          try {
            if (!completionReady || completionReady(output)) resolveResult();
          } catch (error) {
            reportFailure(error);
          }
        }
      }
    };
    return new WritableStream({
      write(chunk) {
        consume(decoder.write(chunk));
      },
      close() {
        consume(decoder.close());
        if (required && !reportedPass)
          reportFailure(new Error("user console closed before completion"));
      },
      abort(error) {
        consume(decoder.close());
        // ConsoleDevice.stop intentionally aborts with no reason. Preserve
        // actual errors, and inspect buffered output even for that normal stop.
        if (!finished || error !== undefined) reportFailure(error);
      },
    });
  };
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(() => {
      trace(`${phase} timed out`);
      reject(new Error(`${phase} timed out:\n${output}`));
    }, timeoutMs);
  });
  try {
    await Promise.race([
      (async () => {
        trace("loading initramfs");
        const initcpio = await loadInitramfs();
        if (finished) return;
        const input = new TransformStream();
        trace("boot requested");
        machine = await bootMachine({
          cpus: 2,
          initcpio,
          plugins: [consoleDevice(input.readable, consoleOutput(true)), entropyDevice()],
        });
        trace("boot returned");
        if (finished) {
          machine.close();
          await machine.closed.catch(() => {});
          return;
        }
        void machine.bootConsole.pipeTo(consoleOutput(false)).catch((error) => {
          if (!finished || error !== undefined) reportFailure(error);
        });
        void machine.closed.then(() => {
          if (!finished) reportFailure(new Error("machine closed before completion"));
        }, reportFailure);
        await result;
        trace("user result received");
      })(),
      watchdog,
    ]);
    if (runtimeFailure) throw runtimeFailure;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    finished = true;
    try {
      if (machine) {
        if (!failed) phase = "runtime shutdown";
        trace("shutdown requested");
        machine.close();
        await Promise.race([machine.closed, watchdog]);
        trace("shutdown completed");
      }
    } catch (error) {
      // A program pass is provisional until device flush/close completes.
      // Preserve an earlier program failure or timeout if cleanup also fails.
      if (!failed) throw runtimeFailure ?? error;
    } finally {
      clearTimeout(timer);
    }
  }
  // A pass remains provisional until shutdown and its final console callbacks
  // complete. Return the final text, not a snapshot taken before the await.
  if (runtimeFailure) throw runtimeFailure;
  return output;
}
