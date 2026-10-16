// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import type { VsockConnection, VsockDevice } from "@lowland/kernel";
import { ProtocolError } from "../src/abi.ts";
import { GuestSession, type AgentAbi } from "../src/conn.ts";
import { fstat64, GuestFd } from "../src/syscalls.ts";

function fixture(changes: ((bytes: Uint8Array) => Uint8Array)[] = []) {
  const connections: { writes: Uint8Array[]; closed: boolean; close(): void }[] = [];
  const calls: { port: number; options: unknown }[] = [];
  const device = {
    async connect(port: number, options?: unknown) {
      calls.push({ port, options });
      let finish: ((bytes: Uint8Array) => void) | undefined;
      const change = changes[connections.length];
      const conn = {
        writes: [] as Uint8Array[],
        closed: false,
        async write(bytes: Uint8Array) {
          conn.writes.push(bytes.slice());
        },
        async readExactly(length: number) {
          assert.equal(length, 8);
          const hello = conn.writes[0]!;
          return change ? change(hello.slice()) : hello.slice();
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
      return conn as unknown as VsockConnection;
    },
  } as unknown as VsockDevice;
  return { device, connections, calls };
}

test("default sessions retain the exact v3 wasm32 handshake and lane identity", async () => {
  const f = fixture();
  const session = await GuestSession.connect(f.device, { timeoutMs: 123 });
  try {
    assert.equal(session.abi, "wasm32");
    assert.equal(session.protocolVersion, 3);
    assert.deepEqual(
      f.connections[0]!.writes[0],
      Uint8Array.of(0x54, 0x4c, 0x4e, 0x58, 3, 0, 0, 0),
    );
    assert.equal(await session.exchange(async () => 7), 7);
    assert.deepEqual(f.connections[1]!.writes[0], f.connections[0]!.writes[0]);
    assert.equal(f.calls[0]!.port, 1024);
    assert.deepEqual(f.calls[0]!.options, { timeoutMs: 123 });
    assert.equal(f.calls[1]!.port, 1025);
  } finally {
    session.close();
  }
});

for (const abi of ["wasm32", "wasm64"] as const) {
  test(`explicit ${abi} sessions and lanes require the same v4 ABI tag`, async () => {
    const f = fixture();
    const session = await GuestSession.connect(f.device, { abi });
    try {
      assert.equal(session.abi, abi);
      assert.equal(session.protocolVersion, 4);
      const expected = Uint8Array.of(0x54, 0x4c, 0x4e, 0x58, 4, 0, abi === "wasm64" ? 64 : 32, 0);
      assert.deepEqual(f.connections[0]!.writes[0], expected);
      await session.exchange(async () => {});
      assert.deepEqual(f.connections[1]!.writes[0], expected);
    } finally {
      session.close();
    }
  });
}

for (const [name, change] of [
  [
    "magic",
    (bytes: Uint8Array) => {
      bytes[0] = bytes[0]! ^ 1;
      return bytes;
    },
  ],
  [
    "version",
    (bytes: Uint8Array) => {
      bytes[4] = 3;
      return bytes;
    },
  ],
  [
    "ABI",
    (bytes: Uint8Array) => {
      bytes[6] = 32;
      return bytes;
    },
  ],
  ["short reply", (bytes: Uint8Array) => bytes.subarray(0, 7)],
] as const) {
  test(`rejects ${name} mismatch without fallback or opening a lane`, async () => {
    const f = fixture([change]);
    await assert.rejects(GuestSession.connect(f.device, { abi: "wasm64" }), ProtocolError);
    assert.equal(f.calls.length, 1);
    assert.equal(f.connections[0]!.closed, true);
  });
}

test("a v3 reply with nonzero reserved bits is rejected", async () => {
  const f = fixture([
    (bytes) => {
      bytes[6] = 32;
      return bytes;
    },
  ]);
  await assert.rejects(GuestSession.connect(f.device), ProtocolError);
  assert.equal(f.connections[0]!.closed, true);
});

test("a lane ABI mismatch closes the whole session before requests can run", async () => {
  const f = fixture([
    (bytes) => bytes,
    (bytes) => {
      bytes[6] = 32;
      return bytes;
    },
  ]);
  const session = await GuestSession.connect(f.device, { abi: "wasm64" });
  let executed = false;
  await assert.rejects(
    session.exchange(async () => {
      executed = true;
    }),
    ProtocolError,
  );
  assert.equal(executed, false);
  assert.ok(f.connections.every((conn) => conn.closed));
  await assert.rejects(
    session.exchange(async () => {}),
    ProtocolError,
  );
  assert.equal(f.calls.length, 2);
});

test("unknown ABI is rejected before opening a connection", async () => {
  const f = fixture();
  await assert.rejects(GuestSession.connect(f.device, { abi: "unknown" as AgentAbi }), RangeError);
  assert.equal(f.calls.length, 0);
});

test("native sessions cannot accidentally marshal a legacy stat syscall", async () => {
  const f = fixture();
  const session = await GuestSession.connect(f.device, { abi: "wasm64" });
  try {
    await assert.rejects(
      fstat64(new GuestFd(session, 42)),
      /wasm64 agent syscall marshalling is not enabled/,
    );
    assert.equal(f.calls.length, 1, "no syscall lane may be opened");
  } finally {
    session.close();
  }
});
