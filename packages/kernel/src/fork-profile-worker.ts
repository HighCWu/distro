// SPDX-License-Identifier: MIT
// Node diagnostic bootstrap only. The parent withholds init until this import
// completes, so module_ns cannot include Linux/user initialization callbacks.
const started = performance.now();
const nodeProcess = Reflect.get(globalThis, "process");
const { parentPort } = nodeProcess.getBuiltinModule("node:worker_threads");
if (!parentPort) throw Error("fork profile bootstrap requires a Node Worker");
await import("./worker.js");
parentPort.postMessage({
  type: "fork_profile_module_ready",
  module_ns: Math.round((performance.now() - started) * 1e6),
});
