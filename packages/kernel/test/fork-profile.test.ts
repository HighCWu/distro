// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { create_fork_profile, new_fork_profile_request } from "../src/fork-profile.ts";
import { ForkContinuation } from "../src/fork-continuation.ts";

test("disabled profiling allocates no request, calls no clock and emits nothing", () => {
  let calls = 0;
  assert.equal(new_fork_profile_request(false), undefined);
  assert.equal(
    create_fork_profile(
      { id: "unused" },
      () => calls++,
      false,
      () => {
        calls++;
        return 0;
      },
    ),
    undefined,
  );
  assert.equal(
    create_fork_profile(undefined, () => calls++, true),
    undefined,
  );
  assert.equal(calls, 0);
});

test("enabled requests use distinct opaque identifiers", () => {
  const a = new_fork_profile_request(true),
    b = new_fork_profile_request(true);
  assert.ok(a?.id && b?.id);
  assert.notEqual(a.id, b.id);
});

test("startup v2 records keep cumulative host markers distinct from local module/send durations", () => {
  let time = 0;
  const events: Array<Record<string, unknown>> = [];
  const profile = create_fork_profile(
    { id: "startup-v2" },
    (line) => events.push(JSON.parse(line.slice(14))),
    true,
    () => time,
  )!;
  time = 1;
  profile.workerConstructed();
  time = 10;
  profile.workerOnline();
  time = 11;
  profile.mainTurn();
  time = 12;
  profile.moduleReady(4e6);
  time = 13;
  profile.initPosted(9e6, 1e6);
  assert.deepEqual(
    events.map((e) => e.ns),
    [1e6, 10e6, 11e6, 12e6, 13e6],
  );
  assert.ok(events.every((e) => e.schemaVersion === 2));
  assert.equal(events[3]?.module_ns, 4e6);
  assert.equal(events[4]?.queued_ns, 9e6);
  assert.equal(events[4]?.post_ns, 1e6);
});

test("Worker start notification is measured wholly on the main clock, including dispatch delay", () => {
  let clock = 5000;
  const events: Array<{ kind: string; ns: number }> = [];
  const profile = create_fork_profile(
    { id: "startup" },
    (line) => events.push(JSON.parse(line.slice(14))),
    true,
    () => clock,
  )!;
  clock += 40;
  profile.workerStarted();
  assert.deepEqual(
    events.map((e) => [e.kind, e.ns]),
    [["worker-start-message", 40e6]],
  );
});

test("profile phases use local durations and distinguish preparation from reaching the checkpoint", () => {
  let time = 1000;
  const events: Array<Record<string, unknown>> = [];
  const profile = create_fork_profile(
    { id: "copy-A" },
    (line) => events.push(JSON.parse(line.slice(14))),
    true,
    () => time,
  )!;
  for (const name of ["allocate_ns", "copy_ns", "kernel_instance_ns", "user_instance_ns"] as const)
    assert.equal(
      profile.measure(name, () => {
        time += 2;
        return 42;
      }),
      42,
    );
  profile.childReady();
  profile.prepareChild(() => {
    time += 3;
  });
  assert.equal(events.length, 2, "preparation is not a completed rewind");
  time += 4;
  profile.childRewound();
  profile.childRewound();
  assert.deepEqual(
    events.map((e) => [e.kind, e.ns]),
    [
      ["child-ready", 8e6],
      ["child-prepare-rewind", 3e6],
      ["child-rewind-checkpoint", 7e6],
    ],
  );
  assert.equal(events[0]?.copy_ns, 2e6);
  const parent = create_fork_profile(
    { id: "copy-A" },
    (line) => events.push(JSON.parse(line.slice(14))),
    true,
    () => time + 50000,
  )!;
  time += 9;
  parent.parentReady();
  assert.equal(events[3]?.ns, 9e6, "clock origin does not enter the elapsed duration");
});

test("diagnostics preserve callback return values and exceptions; broken output is non-fatal", () => {
  const profile = create_fork_profile(
    { id: "copy-B" },
    () => {
      throw Error("closed output");
    },
    true,
  )!;
  const failure = Error("allocation failed");
  assert.throws(
    () =>
      profile.measure("allocate_ns", () => {
        throw failure;
      }),
    (e) => e === failure,
  );
  assert.doesNotThrow(() => profile.parentReady());
  assert.doesNotThrow(() => profile.prepareChild(() => {}));
  assert.doesNotThrow(() => profile.childRewound());
});

for (const address of ["i32", "i64"] as const)
  test(`${address}: child observer runs once at actual rewind checkpoint, never parent preparation`, () => {
    const p = (v: number) => (address === "i64" ? BigInt(v) : v);
    const memory = new WebAssembly.Memory({ initial: 1 });
    let state = 0,
      calls = 0;
    const e = {
      _start() {},
      __wasm_fork_abi: () => 1,
      __wasm_fork_child_entry: () => p(1),
      __wasm_fork_clone: () => p(123),
      __stack_pointer: new WebAssembly.Global({ value: address, mutable: true }, p(4096)),
      __tls_base: new WebAssembly.Global({ value: address, mutable: true }, p(128)),
      asyncify_get_state: () => state,
      asyncify_start_unwind() {
        state = 1;
      },
      asyncify_stop_unwind() {
        state = 0;
      },
      asyncify_start_rewind() {
        state = 2;
      },
      asyncify_stop_rewind() {
        state = 0;
      },
    };
    const f = new ForkContinuation(
      { exports: e } as unknown as WebAssembly.Instance,
      memory,
      address,
      () => {
        calls++;
        throw Error("diagnostic sink");
      },
    );
    const view = new DataView(memory.buffer);
    if (address === "i64") {
      view.setBigUint64(64, 128n, true);
      view.setBigUint64(72, 1024n, true);
    } else {
      view.setUint32(64, 128, true);
      view.setUint32(68, 1024, true);
    }
    assert.equal(f.checkpoint(p(64), true), 0);
    const snapshot = f.suspend();
    f.resumeParent(p(123));
    assert.equal(f.checkpoint(p(64), true), 123);
    assert.equal(calls, 0);
    f.resumeChild(snapshot);
    assert.equal(calls, 0);
    assert.equal(f.checkpoint(p(64), true), 0);
    assert.equal(calls, 1);
    assert.equal(f.checkpoint(p(64), true), 0);
    f.suspend();
    f.resumeParent(p(-11));
    assert.equal(f.checkpoint(p(64), true), -11);
    assert.equal(calls, 1);
  });
