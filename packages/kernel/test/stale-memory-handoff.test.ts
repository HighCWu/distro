// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import {
  close_virtio_device,
  connect_virtio_device,
  VirtioController,
  type Virtqueue,
} from "../src/virtio/core.ts";
import { allocate_shared_memory, ensure_memory_buffer, type WasmAddressType } from "../src/wasm.ts";

function staleGrownMemory(address: WasmAddressType) {
  const p = (n: number) => (address === "i64" ? BigInt(n) : n);
  const { memory } = allocate_shared_memory(1, 3, undefined, address);
  const getter = Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype, "buffer")!.get!;
  const grow = WebAssembly.Memory.prototype.grow as unknown as (
    delta: number | bigint,
  ) => number | bigint;
  const original = getter.call(memory) as SharedArrayBuffer;
  grow.call(memory, p(1));
  let view = original;
  const calls: (number | bigint)[] = [];
  Object.defineProperty(memory, "buffer", { get: () => view });
  Object.defineProperty(memory, "grow", {
    value(delta: number | bigint) {
      calls.push(delta);
      const result = grow.call(memory, delta);
      view = getter.call(memory) as SharedArrayBuffer;
      return result;
    },
  });
  return {
    memory,
    calls,
    live: () => getter.call(memory) as SharedArrayBuffer,
    stale: () => {
      view = original;
    },
  };
}

for (const address of ["i32", "i64"] as const) {
  test(`${address}: ensure_memory_buffer skips in-range refresh and refreshes stale grown buffer`, () => {
    const target = staleGrownMemory(address);
    assert.equal(ensure_memory_buffer(target.memory, 65536).byteLength, 65536);
    assert.equal(target.calls.length, 0);

    const refreshed = ensure_memory_buffer(target.memory, 70000);
    assert.equal(refreshed.byteLength, 131072);
    assert.ok(target.calls.length >= 1);
  });
}

test("virtio queue and completion refresh stale shared memory after concurrent grow", async () => {
  const target = staleGrownMemory("i32");
  const live = new Uint8Array(target.live());
  const liveView = new DataView(target.live());

  const controller = new VirtioController(
    { deviceId: 1, features: 0n, config: new Uint8Array() },
    {
      queues: [
        (queue: Virtqueue) => {
          for (const chain of queue) {
            const [input, output] = [...chain];
            assert.ok(input && output);
            assert.deepEqual([...input.array], [1, 2, 3, 4]);
            output.array.set([5, 6, 7, 8]);
            chain.release(4);
          }
        },
      ],
    },
  );
  const device = controller.expose({});

  let irqResolve!: () => void;
  const irqDone = new Promise<void>((resolve) => {
    irqResolve = resolve;
  });
  const transport = connect_virtio_device(device, {
    memory: target.memory,
    trigger_irq() {
      irqResolve();
    },
    on_error(error) {
      throw error;
    },
  });

  // Place the descriptor ring and buffers in the newly grown second page (> 65536).
  const ringAddr = 65536;
  const inAddr = 66000;
  const outAddr = 67000;
  live.set([1, 2, 3, 4], inAddr);

  // Descriptor 0 (readable) with NEXT (1) | AVAIL (128)
  liveView.setBigUint64(ringAddr, BigInt(inAddr), true);
  liveView.setUint32(ringAddr + 8, 4, true);
  liveView.setUint16(ringAddr + 12, 0, true);
  liveView.setUint16(ringAddr + 14, 1 | 128, true);

  // Descriptor 1 (writable) with WRITE (2) | AVAIL (128)
  liveView.setBigUint64(ringAddr + 16, BigInt(outAddr), true);
  liveView.setUint32(ringAddr + 24, 4, true);
  liveView.setUint16(ringAddr + 28, 0, true);
  liveView.setUint16(ringAddr + 30, 2 | 128, true);

  target.stale();
  transport.enable_queue(0, 4, ringAddr, 1);
  target.stale();
  transport.notify(0);
  await irqDone;

  assert.deepEqual([...live.slice(outAddr, outAddr + 4)], [5, 6, 7, 8]);
  await close_virtio_device(device);
});
