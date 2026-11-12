// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { kernel_imports } from "../src/wasm.ts";

function imports(checkpoint?: () => number) {
  return kernel_imports({
    address: "i32",
    is_worker: true,
    memory: new WebAssembly.Memory({ initial: 1 }),
    spawn_worker: () => 0,
    boot_console_write: () => {},
    boot_console_close: () => {},
    terminate_machine: () => {},
    run_on_main: () => {},
    get_user_context: () => null,
    worker_exit: () => {},
    worker_checkpoint: checkpoint,
  });
}

test("idle checkpoints request bounded rechecks only for the exact ABI value", () => {
  assert.equal(imports().worker_checkpoint_v1(), 0);
  for (const value of [0, 1, 2, -1, NaN]) {
    assert.equal(imports(() => value).worker_checkpoint_v1(), value === 1 ? 1 : 0);
  }
});

test("idle checkpoints propagate runtime termination failures", () => {
  const failure = new Error("execution checkpoint failed");
  assert.throws(
    () =>
      imports(() => {
        throw failure;
      }).worker_checkpoint_v1(),
    (error) => error === failure,
  );
});
