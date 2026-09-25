// SPDX-License-Identifier: MIT

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const packagePath = process.argv[2];
if (!packagePath) throw new Error("usage: smoke-memory64.mjs <kernel-package>");

const entry = pathToFileURL(resolve(packagePath, "dist/index.js"));
const { bootMachine } = await import(entry.href);

const machine = await bootMachine({ cpus: 1, args: ["panic=-1"] });
const reader = machine.bootConsole.getReader();
const decoder = new TextDecoder();
let output = "";

const timeout = AbortSignal.timeout(20_000);
const timedOut = new Promise((_, reject) => {
  timeout.addEventListener("abort", () => reject(new Error("Memory64 kernel boot timed out")));
});

try {
  await Promise.race([
    (async () => {
      while (!output.includes("Linux version")) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`Memory64 kernel stopped before its banner:\n${output}`);
        output += decoder.decode(value, { stream: true });
      }
    })(),
    machine.closed.then(() => {
      throw new Error(`Memory64 kernel stopped before its banner:\n${output}`);
    }),
    timedOut,
  ]);
  process.stdout.write(output);
} finally {
  reader.releaseLock();
  machine.close();
  await machine.closed.catch(() => {});
}
