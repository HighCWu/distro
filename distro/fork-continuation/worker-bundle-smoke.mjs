// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

assert.equal(process.argv.length, 3);
const url = pathToFileURL(resolve(process.argv[2])).href;
// Import completion, not just Node's online event: exercise the actual emitted
// module graph in a Worker isolate, then explicitly await its termination.
for (let i = 0; i < 3; i++) {
  const worker = new Worker(
    `
    const { parentPort } = require('node:worker_threads');
    import(${JSON.stringify(url)}).then(() => parentPort.postMessage('imported'));
  `,
    { eval: true },
  );
  let timer;
  try {
    await new Promise((accept, reject) => {
      timer = setTimeout(() => reject(Error("bundle module import timed out")), 5000);
      worker.once("error", reject);
      worker.once("exit", () => reject(Error("bundle exited before import acknowledgement")));
      worker.once("message", (value) => {
        try {
          assert.equal(value, "imported");
          accept();
        } catch (error) {
          reject(error);
        }
      });
    });
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}
console.log("worker bundle: three real Worker module imports and terminations pass");
