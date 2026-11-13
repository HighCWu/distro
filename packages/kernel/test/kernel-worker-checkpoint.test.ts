// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { kernel_imports } from "../src/wasm.ts";

function imports(checkpoint?: () => number, checkpointV2?: () => 0 | 1 | 2) {
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
    worker_checkpoint_v2: checkpointV2,
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

test("single-step checkpoints preserve the three-state kernel ABI", () => {
  for (const value of [0, 1, 2] as const)
    assert.equal(imports(undefined, () => value).worker_checkpoint_v2(), value);
  assert.equal(imports().worker_checkpoint_v2(), 0);
  assert.throws(
    () => imports(undefined, () => 3 as 0 | 1 | 2).worker_checkpoint_v2(),
    /invalid Worker checkpoint v2 execution ABI result/,
  );
});

test("single-step checkpoints propagate runtime termination failures", () => {
  const failure = new Error("receiver checkpoint failed");
  assert.throws(
    () =>
      imports(undefined, () => {
        throw failure;
      }).worker_checkpoint_v2(),
    (error) => error === failure,
  );
});
