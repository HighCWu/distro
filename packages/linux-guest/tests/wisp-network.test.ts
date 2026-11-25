// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { wispNetwork } from "../src/wisp-network.ts";
import type { TcpSession } from "../src/network.ts";

function frame(type: number, id: number, payload: Uint8Array) {
  const bytes = new Uint8Array(5 + payload.length);
  bytes[0] = type;
  new DataView(bytes.buffer).setUint32(1, id, true);
  bytes.set(payload, 5);
  return bytes;
}
function credit(value: number) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}
class FakeSocket extends EventTarget {
  static OPEN = 1;
  static sockets: FakeSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  binaryType = "blob";
  sent: Uint8Array[] = [];
  readonly url: string | URL;
  constructor(url: string | URL) {
    super();
    this.url = url;
    FakeSocket.sockets.push(this);
  }
  send(bytes: Uint8Array) {
    assert.equal(this.readyState, 1);
    this.sent.push(new Uint8Array(bytes));
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
  receive(type: number, id: number, payload: Uint8Array) {
    const bytes = frame(type, id, payload);
    this.dispatchEvent(new MessageEvent("message", { data: bytes.buffer }));
  }
  handshake(count = 1) {
    this.readyState = 1;
    this.receive(3, 0, credit(count));
  }
}

function session(
  hostname = "203.0.113.9",
  port = 8080,
  sink?: (bytes: Uint8Array) => Promise<void>,
  onClose?: () => void | Promise<void>,
) {
  const abort = new AbortController();
  let input!: ReadableStreamDefaultController<Uint8Array>;
  let reads = 0;
  let closed = false;
  const output: Uint8Array[] = [];
  const value: TcpSession = {
    target: { hostname, port },
    signal: abort.signal,
    readable: new ReadableStream<Uint8Array>(
      {
        start(controller) {
          input = controller;
        },
        pull() {
          reads++;
        },
      },
      { highWaterMark: 0 },
    ),
    writable: new WritableStream<Uint8Array>({
      async write(bytes) {
        output.push(new Uint8Array(bytes));
        await sink?.(bytes);
      },
      async close() {
        await onClose?.();
        closed = true;
      },
    }),
  };
  return {
    value,
    abort,
    input,
    output,
    get reads() {
      return reads;
    },
    get closed() {
      return closed;
    },
  };
}
async function turn() {
  await new Promise((resolve) => setImmediate(resolve));
}
async function withSocket(fn: () => Promise<void>) {
  const original = globalThis.WebSocket;
  FakeSocket.sockets = [];
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  try {
    await fn();
  } finally {
    for (const socket of FakeSocket.sockets) socket.close();
    globalThis.WebSocket = original;
  }
}

test("Wisp DNS keeps bounded stable names and numeric destinations without collisions", async () => {
  const network = wispNetwork("wss://proxy.invalid/");
  const first = await network.resolveDns("Example.COM");
  assert.deepEqual(first, ["198.18.0.1"]);
  assert.deepEqual(await network.resolveDns("example.com"), first);
  assert.deepEqual(await network.resolveDns("203.0.113.5"), ["203.0.113.5"]);
  for (let i = 1; i < 4096; i++) await network.resolveDns(`host-${i}.invalid`);
  await assert.rejects(network.resolveDns("overflow.invalid"), /capacity/);
  assert.deepEqual(await network.resolveDns("example.com"), first);
  await assert.rejects(network.resolveDns("198.18.0.1"), /reserved/);
  await assert.rejects(network.resolveDns("bad\0host"), /invalid/);
  assert.throws(() => wispNetwork("https://proxy.invalid/"), /endpoint/);
});

test("Wisp multiplexes exact TCP packets, resets credit and preserves reply after guest EOF", async () =>
  withSocket(async () => {
    const network = wispNetwork(new URL("ws://proxy.invalid/path/"));
    const [address] = await network.resolveDns("Example.COM");
    const first = session(address!);
    const second = session("203.0.113.7", 443);
    const a = Promise.resolve(network.connectTcp(first.value));
    const b = Promise.resolve(network.connectTcp(second.value));
    const refused = assert.rejects(b, /connection refused/);
    assert.equal(FakeSocket.sockets.length, 1);
    const socket = FakeSocket.sockets[0]!;
    assert.equal(first.reads, 0, "proxy handshake precedes lazy guest TCP activation");
    socket.handshake(1);
    await turn();
    const connects = socket.sent.filter((bytes) => bytes[0] === 1);
    assert.equal(connects.length, 2);
    assert.equal(connects[0]![5], 1);
    assert.equal(new DataView(connects[0]!.buffer).getUint16(6, true), 8080);
    assert.equal(new TextDecoder().decode(connects[0]!.subarray(8)), "example.com");
    assert.equal(new TextDecoder().decode(connects[1]!.subarray(8)), "203.0.113.7");
    const id = new DataView(connects[0]!.buffer).getUint32(1, true);
    const otherId = new DataView(connects[1]!.buffer).getUint32(1, true);
    const payload = new Uint8Array(65537);
    payload[0] = 255;
    payload[65535] = 17;
    payload[65536] = 128;
    first.input.enqueue(payload);
    first.input.close();
    socket.receive(4, otherId, Uint8Array.of(0x44));
    await refused;
    await turn();
    assert.equal(socket.sent.filter((bytes) => bytes[0] === 2).length, 1);
    socket.receive(3, id, credit(1));
    await turn();
    const data = socket.sent.filter((bytes) => bytes[0] === 2);
    assert.equal(data.length, 2);
    assert.deepEqual(new Uint8Array([...data[0]!.subarray(5), ...data[1]!.subarray(5)]), payload);
    assert.equal(
      socket.sent.some(
        (bytes) => bytes[0] === 4 && new DataView(bytes.buffer).getUint32(1, true) === id,
      ),
      false,
      "v1 cannot half-close; EOF must leave the stream available for a reply",
    );
    socket.receive(2, id, Uint8Array.of(0, 255, 128, 1));
    socket.receive(4, id, Uint8Array.of(2));
    await a;
    assert.deepEqual(first.output, [Uint8Array.of(0, 255, 128, 1)]);
    assert.equal(first.closed, true);
    assert.equal(socket.readyState, 3, "last completed flow releases its WebSocket");
  }));

test("aborting one initial handshake waiter leaves other streams alive, aborting last closes socket", async () =>
  withSocket(async () => {
    const network = wispNetwork("ws://proxy.invalid/");
    const first = session();
    const second = session();
    const a = Promise.resolve(network.connectTcp(first.value));
    const b = Promise.resolve(network.connectTcp(second.value));
    const aborted = assert.rejects(a, /aborted/);
    first.abort.abort("first");
    await aborted;
    const socket = FakeSocket.sockets[0]!;
    assert.notEqual(socket.readyState, 3);
    assert.equal(second.reads, 0);
    socket.handshake(0);
    await turn();
    assert.equal(socket.sent.filter((bytes) => bytes[0] === 1).length, 1);
    const last = assert.rejects(b, /aborted/);
    second.abort.abort("last");
    await last;
    assert.equal(socket.readyState, 3);
    assert.ok(socket.sent.some((bytes) => bytes[0] === 4 && bytes[5] === 2));
  }));

test("missing or malformed initial CONTINUE cannot hang or activate guest TCP", async (t) =>
  withSocket(async () => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const network = wispNetwork("ws://proxy.invalid/");
    const first = session();
    const a = Promise.resolve(network.connectTcp(first.value));
    const timedOut = assert.rejects(a, /initial CONTINUE timed out/);
    t.mock.timers.tick(10_000);
    await timedOut;
    assert.equal(first.reads, 0);
    const second = session();
    const b = Promise.resolve(network.connectTcp(second.value));
    const malformed = assert.rejects(b, /stream zero/);
    FakeSocket.sockets[1]!.receive(3, 9, credit(1));
    await malformed;
    assert.equal(second.reads, 0);
  }));

test("bounded inbound buffering resets only the overloaded stream and settles blocked sink", async () =>
  withSocket(async () => {
    const block = Promise.withResolvers<void>();
    const network = wispNetwork("ws://proxy.invalid/");
    const first = session("203.0.113.1", 80, () => block.promise);
    const second = session("203.0.113.2");
    const a = Promise.resolve(network.connectTcp(first.value));
    const b = Promise.resolve(network.connectTcp(second.value));
    const overload = assert.rejects(a, /receive buffer capacity/);
    const socket = FakeSocket.sockets[0]!;
    socket.handshake();
    await turn();
    const ids = socket.sent
      .filter((bytes) => bytes[0] === 1)
      .map((bytes) => new DataView(bytes.buffer).getUint32(1, true));
    socket.receive(2, ids[0]!, new Uint8Array(65536));
    await turn();
    for (let i = 0; i < 5; i++) socket.receive(2, ids[0]!, new Uint8Array(65536));
    await overload;
    assert.ok(socket.sent.some((bytes) => bytes[0] === 4 && bytes[5] === 0x81));
    assert.notEqual(socket.readyState, 3, "healthy multiplexed flow survives stream overload");
    block.resolve();
    second.input.close();
    socket.receive(4, ids[1]!, Uint8Array.of(2));
    await b;
  }));

test("CONTINUE received during WebSocket backpressure replaces credit before the actual DATA send", async () =>
  withSocket(async () => {
    const network = wispNetwork("ws://proxy.invalid/");
    const first = session();
    const done = Promise.resolve(network.connectTcp(first.value));
    const socket = FakeSocket.sockets[0]!;
    socket.handshake(1);
    await turn();
    const id = new DataView(socket.sent[0]!.buffer).getUint32(1, true);
    socket.bufferedAmount = 1024 * 1024;
    first.input.enqueue(Uint8Array.of(4, 5, 6));
    await turn();
    socket.receive(3, id, credit(0));
    socket.bufferedAmount = 0;
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(
      socket.sent.some((bytes) => bytes[0] === 2),
      false,
    );
    socket.receive(3, id, credit(1));
    await turn();
    assert.equal(socket.sent.filter((bytes) => bytes[0] === 2).length, 1);
    first.input.close();
    socket.receive(4, id, Uint8Array.of(2));
    await done;
  }));

test("successful FIN/ACK abort during writable close stays graceful; blocked close abort still settles", async () =>
  withSocket(async () => {
    const network = wispNetwork("ws://proxy.invalid/");
    const first = session("203.0.113.1", 80, undefined, () =>
      first.abort.abort(new Error("TCP connection closed")),
    );
    const done = Promise.resolve(network.connectTcp(first.value));
    FakeSocket.sockets[0]!.handshake();
    await turn();
    first.input.close();
    FakeSocket.sockets[0]!.receive(2, 1, Uint8Array.of(42));
    FakeSocket.sockets[0]!.receive(4, 1, Uint8Array.of(2));
    await done;
    assert.deepEqual(first.output, [Uint8Array.of(42)]);
    assert.equal(first.closed, true);
    const blocked = Promise.withResolvers<void>();
    const second = session("203.0.113.2", 80, undefined, () => blocked.promise);
    const pending = Promise.resolve(network.connectTcp(second.value));
    const aborted = assert.rejects(pending, /aborted/);
    FakeSocket.sockets[1]!.handshake();
    await turn();
    second.input.close();
    FakeSocket.sockets[1]!.receive(4, 2, Uint8Array.of(2));
    await turn();
    second.abort.abort("stop stalled close");
    await aborted;
    blocked.resolve();
  }));

test("host-local gateway loopback is rejected before contacting the proxy", async () =>
  withSocket(async () => {
    const network = wispNetwork("ws://proxy.invalid/");
    for (const host of ["127.0.0.1", "127.123.45.67"]) {
      const s = session(host);
      await assert.rejects(Promise.resolve(network.connectTcp(s.value)), /loopback/);
      assert.equal(s.reads, 0);
    }
    assert.equal(FakeSocket.sockets.length, 0);
  }));

test("voluntary CLOSE drains queued replies while outbound DATA waits on credit or socket capacity", async () =>
  withSocket(async () => {
    for (const socketBlocked of [false, true]) {
      const network = wispNetwork("ws://proxy.invalid/");
      const s = session();
      const done = Promise.resolve(network.connectTcp(s.value));
      const socket = FakeSocket.sockets.at(-1)!;
      socket.handshake(socketBlocked ? 1 : 0);
      await turn();
      if (socketBlocked) socket.bufferedAmount = 1024 * 1024;
      s.input.enqueue(Uint8Array.of(9));
      await turn();
      socket.receive(2, 1, Uint8Array.of(3, 2, 1));
      socket.receive(4, 1, Uint8Array.of(2));
      await done;
      assert.deepEqual(s.output, [Uint8Array.of(3, 2, 1)]);
      assert.equal(s.closed, true);
      assert.equal(socket.sent.filter((bytes) => bytes[0] === 2).length, 0);
    }
  }));
