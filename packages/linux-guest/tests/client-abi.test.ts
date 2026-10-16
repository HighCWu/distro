// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import type { VsockDevice } from "@lowland/kernel";
import { ProtocolError } from "../src/abi.ts";
import { create_guest_client } from "../src/client.ts";
import type { AgentAbi } from "../src/conn.ts";

function fixture() {
  const connections: { port: number; writes: Uint8Array[]; closed: boolean; close(): void }[] = [];
  let rejectNext = false;
  const device = {
    async connect(port: number) {
      let finish: ((bytes: Uint8Array) => void) | undefined;
      const reject = rejectNext;
      rejectNext = false;
      const conn = {
        port,
        writes: [] as Uint8Array[],
        closed: false,
        async write(bytes: Uint8Array) {
          conn.writes.push(bytes.slice());
        },
        async readExactly(length: number) {
          if (length === 8) {
            const echo = conn.writes[0]!.slice();
            if (reject) echo[6] = 0;
            return echo;
          }
          assert.equal(length, 12);
          const reply = new Uint8Array(12);
          new DataView(reply.buffer).setBigInt64(0, 42n, true);
          return reply;
        },
        read() {
          return new Promise<Uint8Array>((resolve) => {
            finish = resolve;
          });
        },
        close() {
          conn.closed = true;
          finish?.(new Uint8Array());
        },
      };
      connections.push(conn);
      return conn;
    },
  } as unknown as VsockDevice;
  return {
    device,
    connections,
    rejectNext() {
      rejectNext = true;
    },
    close() {
      for (const conn of connections) conn.close();
    },
  };
}

for (const abi of [undefined, "wasm32", "wasm64"] as const) {
  test(`high-level client pins ${abi ?? "legacy wasm32"} on its session and lanes`, async () => {
    const f = fixture();
    try {
      const options: { abi?: AgentAbi } = { abi };
      const client = create_guest_client(f.device, options);
      // Subsequent caller mutation cannot change the client's ABI identity.
      options.abi = abi === "wasm64" ? "wasm32" : "wasm64";
      await client.ping();
      await client.ping();
      assert.deepEqual(
        f.connections.map((conn) => conn.port),
        [1024, 1025],
      );
      const expected = Uint8Array.of(
        0x54,
        0x4c,
        0x4e,
        0x58,
        abi ? 4 : 3,
        0,
        abi === undefined ? 0 : abi === "wasm64" ? 64 : 32,
        0,
      );
      for (const conn of f.connections) assert.deepEqual(conn.writes[0], expected);
    } finally {
      f.close();
    }
  });
}

test("high-level native client retries a rejected session without ABI fallback", async () => {
  const f = fixture();
  try {
    const client = create_guest_client(f.device, { abi: "wasm64" });
    f.rejectNext();
    await assert.rejects(client.ping(), ProtocolError);
    assert.equal(f.connections.length, 1);
    assert.equal(f.connections[0]!.closed, true);
    await client.ping();
    assert.deepEqual(
      f.connections.map((conn) => conn.port),
      [1024, 1024, 1025],
    );
    for (const conn of f.connections) assert.equal(conn.writes[0]![6], 64);
  } finally {
    f.close();
  }
});

test("high-level client rejects an unknown ABI before transport use", () => {
  const f = fixture();
  assert.throws(() => create_guest_client(f.device, { abi: "invalid" as AgentAbi }), RangeError);
  assert.equal(f.connections.length, 0);
});
