// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import type { VsockDevice } from "@lowland/kernel";
import { NR, O, ProtocolError } from "../src/abi.ts";
import { create_guest_client } from "../src/client.ts";
import { GuestSession, type AgentAbi } from "../src/conn.ts";

function copyFixture(
  abi: AgentAbi,
  sameFile: boolean,
  statError = false,
  differentDevice = false,
  openError = false,
) {
  const requests: { nr: number; fd: number; flags: number; data: Uint8Array }[] = [];
  let opens = 0;
  let reads = 0;
  const payload = Uint8Array.of(0, 255, 65);
  const session = {
    abi,
    async exchange<T>(
      fn: (lane: {
        write(bytes: Uint8Array): Promise<void>;
        read(length: number): Promise<Uint8Array>;
      }) => Promise<T>,
    ) {
      let nr = 0;
      let fd = 0;
      let ret = 0n;
      return fn({
        async write(bytes) {
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          nr = view.getUint32(1, true);
          fd = Number(view.getBigUint64(11, true));
          requests.push({
            nr,
            fd,
            flags: Number(view.getBigUint64(27, true)),
            data: bytes.slice(59),
          });
          if (nr === NR.openat) ret = BigInt(40 + opens++);
          if (nr === NR.read) ret = reads++ === 0 ? BigInt(payload.length) : 0n;
          if (nr === NR.write) ret = BigInt(Math.min(2, bytes.byteLength - 59));
        },
        async read(length) {
          const result = new Uint8Array(length);
          const view = new DataView(result.buffer);
          if (length === 12) {
            const failed = (statError && nr === NR.fstat64) || (openError && nr === NR.openat);
            view.setBigInt64(0, failed ? -1n : ret, true);
            if (failed) view.setUint32(8, 5, true);
          } else if (nr === NR.fstat64 || nr === NR.fstatat64) {
            assert.equal(length, abi === "wasm64" ? 128 : 104);
            view.setBigUint64(0, differentDevice && fd === 41 ? 2n : 1n, true);
            // Path lookup is stale: different path identities, but possibly
            // identical opened objects. Values deliberately exceed JS precision.
            view.setBigUint64(
              8,
              nr === NR.fstatat64
                ? BigInt(requests.length)
                : 9007199254740992n + BigInt(sameFile ? 0 : fd - 40),
              true,
            );
          } else {
            assert.equal(nr, NR.read);
            assert.equal(length, Number(ret));
            if (length === 0) return result;
            result.set(payload);
          }
          return result;
        },
      });
    },
  } as GuestSession;
  return { session, requests, payload };
}

for (const abi of ["wasm32", "wasm64"] as const) {
  for (const failure of ["abort", "source"] as const) {
    test(`${abi} writeFile disposes its opened fd and input lock after ${failure}`, async (t) => {
      const f = copyFixture(abi, false);
      t.mock.method(GuestSession, "connect", async () => f.session);
      const client = create_guest_client({} as VsockDevice, { abi });
      const ready = Promise.withResolvers<void>();
      const controller = new AbortController();
      const reason = new Error(failure);
      let input: ReadableStreamDefaultController<Uint8Array>;
      const cancellations: unknown[] = [];
      const source = new ReadableStream<Uint8Array>(
        {
          pull(c) {
            input = c;
            ready.resolve();
          },
          cancel(error) {
            cancellations.push(error);
          },
        },
        { highWaterMark: 0 },
      );
      const writing = client.fs.writeFile("/existing", source, { signal: controller.signal });
      void writing.catch(() => {});
      await ready.promise;
      if (failure === "abort") controller.abort(reason);
      else input!.error(reason);
      await assert.rejects(writing, (error) => error === reason);
      assert.equal(source.locked, false);
      assert.deepEqual(cancellations, failure === "abort" ? [reason] : []);
      assert.deepEqual(
        f.requests.map(({ nr }) => nr),
        [NR.openat, NR.close],
      );
    });
  }

  test(`${abi} locked writeFile input rejects before connection or destination truncation`, async (t) => {
    const f = copyFixture(abi, false);
    let connections = 0;
    t.mock.method(GuestSession, "connect", async () => {
      connections++;
      return f.session;
    });
    const client = create_guest_client({} as VsockDevice, { abi });
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(1, 2, 3));
        controller.close();
      },
    });
    const reader = source.getReader();
    await assert.rejects(client.fs.writeFile("/existing", source), TypeError);
    assert.equal(connections, 0);
    assert.deepEqual(f.requests, []);
    reader.releaseLock();
    await client.fs.writeFile("/existing", source);
    assert.equal(source.locked, false);
    assert.deepEqual(
      f.requests.filter(({ nr }) => nr === NR.write).map(({ data }) => data),
      [Uint8Array.of(1, 2, 3), Uint8Array.of(3)],
    );
  });

  for (const failure of ["connect", "open", "abort-before", "abort-connect"] as const) {
    test(`${abi} writeFile releases unread input on ${failure} failure`, async (t) => {
      const f = copyFixture(abi, false, false, false, failure === "open");
      const reason = new Error(failure);
      const controller = new AbortController();
      let connections = 0;
      t.mock.method(GuestSession, "connect", async () => {
        connections++;
        if (failure === "connect") throw reason;
        if (failure === "abort-connect") controller.abort(reason);
        return f.session;
      });
      if (failure === "abort-before") controller.abort(reason);
      const client = create_guest_client({} as VsockDevice, { abi });
      let pulls = 0;
      let cancels = 0;
      const source = new ReadableStream<Uint8Array>(
        {
          pull(c) {
            pulls++;
            c.enqueue(Uint8Array.of(42));
            c.close();
          },
          cancel() {
            cancels++;
          },
        },
        { highWaterMark: 0 },
      );
      await assert.rejects(
        client.fs.writeFile("/existing", source, { signal: controller.signal }),
        failure === "open" ? { code: "EIO" } : (error) => error === reason,
      );
      assert.equal(source.locked, false);
      assert.equal(pulls, 0);
      assert.equal(cancels, 0);
      assert.equal(connections, failure === "abort-before" ? 0 : 1);
      assert.deepEqual(
        f.requests.map(({ nr }) => nr),
        failure === "open" ? [NR.openat] : [],
      );
      const reader = source.getReader();
      assert.deepEqual((await reader.read()).value, Uint8Array.of(42));
      reader.releaseLock();
    });
  }

  for (const operation of ["open-read", "open-append", "write", "write-text"] as const) {
    test(`${abi} ${operation} keeps SDK descriptors out of executed programs`, async (t) => {
      const f = copyFixture(abi, false);
      t.mock.method(GuestSession, "connect", async () => f.session);
      const client = create_guest_client({} as VsockDevice, { abi });
      if (operation === "open-read") await (await client.fs.open("/file")).close();
      else if (operation === "open-append")
        await (await client.fs.open("/file", { append: true, createNew: true })).close();
      else if (operation === "write")
        await client.fs.writeFile("/file", Uint8Array.of(1, 2, 3), { append: true });
      else await client.fs.writeTextFile("/file", "text", { createNew: true });
      const opened = f.requests.filter(({ nr }) => nr === NR.openat);
      assert.equal(opened.length, 1);
      assert.ok(opened[0]!.flags & O.CLOEXEC);
      if (operation === "open-append" || operation === "write")
        assert.ok(opened[0]!.flags & O.APPEND);
      if (operation === "open-append" || operation === "write-text")
        assert.ok(opened[0]!.flags & O.EXCL);
      assert.deepEqual(
        f.requests.filter(({ nr }) => nr === NR.close).map(({ fd }) => fd),
        [40],
      );
    });
  }

  test(`${abi} copy checks opened identities before truncating a replaced alias`, async (t) => {
    const f = copyFixture(abi, true);
    t.mock.method(GuestSession, "connect", async () => f.session);
    const client = create_guest_client({} as VsockDevice, { abi });
    await assert.rejects(client.fs.copyFile("/source", "/replaced"), { code: "EINVAL" });
    assert.deepEqual(
      f.requests.map(({ nr }) => nr),
      [NR.openat, NR.openat, NR.fstat64, NR.fstat64, NR.close, NR.close],
    );
    assert.deepEqual(
      f.requests.filter(({ nr }) => nr === NR.close).map(({ fd }) => fd),
      [41, 40],
    );
  });

  for (const differentDevice of [false, true]) {
    test(`${abi} copy uses full descriptor identity and preserves short writes (${differentDevice})`, async (t) => {
      const f = copyFixture(abi, differentDevice, false, differentDevice);
      t.mock.method(GuestSession, "connect", async () => f.session);
      const client = create_guest_client({} as VsockDevice, { abi });
      await client.fs.copyFile("/source", "/destination");
      assert.deepEqual(
        f.requests.slice(0, 5).map(({ nr }) => nr),
        [NR.openat, NR.openat, NR.fstat64, NR.fstat64, NR.ftruncate64],
      );
      for (const request of f.requests.filter(({ nr }) => nr === NR.openat))
        assert.ok(request.flags & O.CLOEXEC);
      const writes = f.requests.filter(({ nr }) => nr === NR.write);
      assert.deepEqual(
        writes.map(({ data }) => data),
        [f.payload, f.payload.subarray(2)],
      );
      assert.deepEqual(
        f.requests.filter(({ nr }) => nr === NR.close).map(({ fd }) => fd),
        [41, 40],
      );
    });
  }

  test(`${abi} copy metadata failure closes both files without truncation`, async (t) => {
    const f = copyFixture(abi, false, true);
    t.mock.method(GuestSession, "connect", async () => f.session);
    const client = create_guest_client({} as VsockDevice, { abi });
    await assert.rejects(client.fs.copyFile("/source", "/destination"), { code: "EIO" });
    assert.ok(!f.requests.some(({ nr }) => [NR.ftruncate64, NR.read, NR.write].includes(nr)));
    assert.deepEqual(
      f.requests.filter(({ nr }) => nr === NR.close).map(({ fd }) => fd),
      [41, 40],
    );
  });
}

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

test("invalid stdin mode rejects before connecting or spawning", async () => {
  const f = fixture();
  const client = create_guest_client(f.device, { abi: "wasm64" });
  await assert.rejects(client.exec(["true"], { stdinMode: "invalid" as "streaming" }), TypeError);
  assert.equal(f.connections.length, 0);
});
