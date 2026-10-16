// SPDX-License-Identifier: MIT
import { LineDecoder, parseResult } from "./protocol.js";

export async function runRuntimeSmoke({
  bootMachine,
  consoleDevice,
  entropyDevice,
  loadInitramfs,
  timeoutMs = 120_000,
}) {
  let machine;
  let finished = false;
  let timer;
  let output = "";
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  void result.catch(() => {});
  const consoleOutput = (required) => {
    const decoder = new LineDecoder();
    const consume = (lines) => {
      for (const line of lines) {
        output += `${line}\n`;
        const status = parseResult(line);
        if (status?.passed) resolveResult();
        else if (status) rejectResult(new Error(status.reason));
        else if (line.includes("Kernel panic - not syncing")) rejectResult(new Error(line));
      }
    };
    return new WritableStream({
      write(chunk) {
        consume(decoder.write(chunk));
      },
      close() {
        consume(decoder.close());
        if (required) rejectResult(new Error("user console closed before completion"));
      },
      abort(error) {
        rejectResult(error);
      },
    });
  };
  try {
    await Promise.race([
      (async () => {
        const initcpio = await loadInitramfs();
        if (finished) return;
        const input = new TransformStream();
        machine = await bootMachine({
          cpus: 2,
          initcpio,
          plugins: [consoleDevice(input.readable, consoleOutput(true)), entropyDevice()],
        });
        if (finished) {
          machine.close();
          await machine.closed.catch(() => {});
          return;
        }
        void machine.bootConsole.pipeTo(consoleOutput(false)).catch(rejectResult);
        void machine.closed.then(
          () => rejectResult(new Error("machine closed before completion")),
          rejectResult,
        );
        await result;
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`user runtime timed out:\n${output}`)),
          timeoutMs,
        );
      }),
    ]);
    return output;
  } finally {
    finished = true;
    clearTimeout(timer);
    if (machine) {
      machine.close();
      await machine.closed.catch(() => {});
    }
  }
}
