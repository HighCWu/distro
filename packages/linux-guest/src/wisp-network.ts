// SPDX-License-Identifier: MIT
// Protocol framing and synthetic DNS approach adapted from unkernel's net-wisp.ts.
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

import type { NetworkOptions, TcpSession } from "./network.ts";

const HANDSHAKE_MS = 10_000;
const MAX_STREAMS = 64;
const MAX_NAMES = 4096;
const MAX_PACKET = 64 * 1024;
const MAX_STREAM_BYTES = 256 * 1024;
const MAX_QUEUE_PACKETS = 128;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_SOCKET_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
const reasons: Record<number, string> = {
  1: "unspecified closure",
  3: "network error",
  0x41: "invalid destination",
  0x42: "host unreachable",
  0x43: "connect timed out",
  0x44: "connection refused",
  0x47: "transfer timed out",
  0x48: "destination blocked",
  0x49: "connection throttled",
};

function packet(type: number, id: number, payload: Uint8Array) {
  const bytes = new Uint8Array(5 + payload.length);
  bytes[0] = type;
  new DataView(bytes.buffer).setUint32(1, id, true);
  bytes.set(payload, 5);
  return bytes;
}

function numericAddress(host: string): boolean {
  const parts = host.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255)
  );
}

function syntheticAddress(host: string): boolean {
  return host.startsWith("198.18.") || host.startsWith("198.19.");
}

function checkedHostname(host: string) {
  if (
    !host ||
    !host.isWellFormed() ||
    encoder.encode(host).length > 253 ||
    /[\x00-\x20\x7f/\\:@?#]/.test(host)
  )
    throw new TypeError("invalid Wisp hostname");
  return host.toLowerCase();
}

interface Connection {
  socket: WebSocket | undefined;
  pending: Set<WebSocket> | undefined;
  timer: ReturnType<typeof setTimeout>;
  credit: number | undefined;
  closed: boolean;
}

interface Stream {
  id: number;
  connection: Connection | undefined;
  credit: number;
  opened: boolean;
  ended: boolean;
  error: Error | undefined;
  queue: Uint8Array[];
  bytes: number;
  wake: Set<() => void>;
}

/** Wisp v1 TCP over a caller-selected WebSocket proxy. DNS names receive
 * stable synthetic addresses in reserved 198.18.0.0/15 (at most 4096 names;
 * no eviction or reuse). Those addresses are routed back to proxy DNS names.
 * Other numeric IPv4 destinations are forwarded unchanged, except 127/8:
 * browser-host loopback must never silently become the proxy's loopback.
 *
 * v1 has no positive connect acknowledgement, server-to-client flow control,
 * or half-close. Guest EOF leaves the proxy stream open for replies; only
 * remote closure or cancellation ends it. Excess inbound buffering resets the
 * stream. This adapter handles TCP only, and selects no default public proxy.
 * Up to four unique explicit endpoints race until the first valid v1 initial
 * CONTINUE. Losers close; established streams never migrate or replay.
 * The shared WebSocket closes when its final session finishes or is aborted.
 */
export function wispNetwork(url: string | URL | readonly (string | URL)[]): NetworkOptions {
  const inputs: readonly (string | URL)[] = Array.isArray(url) ? url : [url as string | URL];
  const endpoints = new Set<string>();
  for (const input of inputs) {
    const endpoint = new URL(input);
    if (
      !["ws:", "wss:"].includes(endpoint.protocol) ||
      endpoint.hash ||
      endpoint.username ||
      endpoint.password
    )
      throw new TypeError("expected a ws: or wss: Wisp endpoint without credentials or fragment");
    endpoints.add(endpoint.href);
    if (endpoints.size > 4)
      throw new RangeError("at most four unique Wisp endpoints are supported");
  }
  if (endpoints.size === 0) throw new RangeError("at least one Wisp endpoint is required");
  let connection: Connection | undefined;
  let nextId = 1;
  let receivedBytes = 0;
  let sendingBytes = 0;
  const streams = new Map<number, Stream>();
  const names = new Map<string, string>();
  const addresses = new Map<string, string>();

  const notify = (stream: Stream) => {
    for (const wake of [...stream.wake]) wake();
  };
  const finish = (stream: Stream, error?: Error) => {
    if (stream.error || (stream.ended && !error)) return;
    stream.ended = true;
    stream.error = error;
    if (error) {
      receivedBytes -= stream.bytes;
      stream.bytes = 0;
      stream.queue.length = 0;
    }
    notify(stream);
  };
  const closeStream = (stream: Stream, reason: number) => {
    const c = stream.connection;
    if (!stream.opened || !c?.socket || c.closed || c.socket.readyState !== WebSocket.OPEN) return;
    const bytes = packet(4, stream.id, Uint8Array.of(reason));
    if (c.socket.bufferedAmount + bytes.length > MAX_SOCKET_BYTES) {
      failConnection(c, new Error("Wisp send buffer exceeded during closure"));
      return;
    }
    try {
      c.socket.send(bytes);
    } catch (error) {
      failConnection(c, new Error("Wisp stream closure failed", { cause: error }));
    }
  };
  function failConnection(c: Connection, error: Error) {
    if (c.closed) return;
    c.closed = true;
    clearTimeout(c.timer);
    if (connection === c) connection = undefined;
    for (const stream of streams.values()) if (stream.connection === c) finish(stream, error);
    const pending = c.pending;
    c.pending = undefined;
    if (pending) {
      for (const socket of pending) socket.close();
      pending.clear();
    }
    c.socket?.close();
  }
  function connectedPacket(c: Connection, bytes: Uint8Array<ArrayBuffer>) {
    const view = new DataView(bytes.buffer);
    const id = view.getUint32(1, true);
    const type = bytes[0];
    if (
      id === 0 ||
      (type !== 2 && type !== 3 && type !== 4) ||
      (type === 3 && bytes.length !== 9) ||
      (type === 4 && bytes.length !== 6)
    ) {
      failConnection(c, new Error("invalid Wisp stream packet"));
      return;
    }
    const stream = streams.get(id);
    if (!stream || stream.connection !== c || stream.ended) return;
    if (type === 3) {
      stream.credit = view.getUint32(5, true);
      notify(stream);
    } else if (type === 4) {
      const reason = bytes[5]!;
      stream.opened = false;
      finish(
        stream,
        reason === 2
          ? undefined
          : new Error(`Wisp: ${reasons[reason] ?? `close reason 0x${reason.toString(16)}`}`),
      );
    } else if (bytes.length > 5) {
      const length = bytes.length - 5;
      if (
        length > MAX_STREAM_BYTES - stream.bytes ||
        length > MAX_TOTAL_BYTES - receivedBytes ||
        stream.queue.length >= MAX_QUEUE_PACKETS
      ) {
        closeStream(stream, 0x81);
        finish(stream, new Error("Wisp receive buffer capacity exceeded"));
        return;
      }
      stream.queue.push(bytes.subarray(5));
      stream.bytes += length;
      receivedBytes += length;
      notify(stream);
    }
  }
  function getConnection() {
    if (connection) return connection;
    const pending = new Set<WebSocket>();
    const c: Connection = {
      socket: undefined,
      pending,
      timer: setTimeout(
        () => failConnection(c, new Error("Wisp initial CONTINUE timed out")),
        HANDSHAKE_MS,
      ),
      credit: undefined,
      closed: false,
    };
    connection = c;
    let lastError = new Error("Wisp endpoints unavailable");
    const failedCandidate = (socket: WebSocket, error: Error) => {
      if (c.closed || c.pending !== pending || !pending.delete(socket)) return;
      socket.close();
      if (pending.size === 0) failConnection(c, error);
    };
    for (const endpoint of endpoints) {
      let socket: WebSocket;
      try {
        socket = new WebSocket(endpoint);
      } catch (error) {
        lastError = new Error("Wisp WebSocket creation failed", { cause: error });
        continue;
      }
      pending.add(socket);
      socket.binaryType = "arraybuffer";
      const failed = (error: Error) => {
        if (c.socket === socket) failConnection(c, error);
        else failedCandidate(socket, error);
      };
      socket.addEventListener("error", () => failed(new Error("Wisp WebSocket error")));
      socket.addEventListener("close", () => failed(new Error("Wisp WebSocket closed")));
      socket.addEventListener("message", (event: MessageEvent) => {
        if (c.closed || (c.socket !== socket && (c.pending !== pending || !pending.has(socket))))
          return;
        if (
          !(event.data instanceof ArrayBuffer) ||
          event.data.byteLength < 5 ||
          event.data.byteLength > MAX_PACKET + 5
        ) {
          failed(new Error("invalid or oversized Wisp packet"));
          return;
        }
        const bytes = new Uint8Array(event.data);
        if (c.credit === undefined) {
          const view = new DataView(event.data);
          if (bytes.length !== 9 || bytes[0] !== 3 || view.getUint32(1, true) !== 0) {
            failed(new Error("expected Wisp v1 initial CONTINUE on stream zero"));
            return;
          }
          c.socket = socket;
          c.pending = undefined;
          c.credit = view.getUint32(5, true);
          clearTimeout(c.timer);
          for (const loser of pending) if (loser !== socket) loser.close();
          pending.clear();
          for (const stream of streams.values()) if (stream.connection === c) notify(stream);
          return;
        }
        connectedPacket(c, bytes);
      });
    }
    if (pending.size === 0) {
      failConnection(c, lastError);
      throw lastError;
    }
    return c;
  }
  function wait(stream: Stream) {
    return new Promise<void>((resolve) => {
      const wake = () => {
        stream.wake.delete(wake);
        resolve();
      };
      stream.wake.add(wake);
    });
  }
  function interruptOnError<T>(stream: Stream, task: Promise<T>) {
    return new Promise<T>((resolve, reject) => {
      const wake = () => {
        if (!stream.error) return;
        stream.wake.delete(wake);
        reject(stream.error);
      };
      stream.wake.add(wake);
      void task.then(
        (value) => {
          stream.wake.delete(wake);
          resolve(value);
        },
        (error) => {
          stream.wake.delete(wake);
          reject(error);
        },
      );
      wake();
    });
  }
  async function send(stream: Stream, bytes: Uint8Array<ArrayBuffer>, data = false) {
    const c = stream.connection!;
    const socket = c.socket;
    if (!socket) throw new Error("Wisp connection has no selected endpoint");
    for (;;) {
      if (stream.ended || c.closed) throw stream.error ?? new Error("Wisp stream closed");
      if (data && stream.credit === 0) {
        await wait(stream);
        continue;
      }
      if (socket.bufferedAmount + bytes.length > MAX_SOCKET_BYTES) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      if (socket.readyState !== WebSocket.OPEN) throw new Error("Wisp WebSocket is not open");
      // No suspension between checking/reserving packet credit and sending.
      if (data) stream.credit--;
      socket.send(bytes);
      return;
    }
  }
  // Await a source read without accumulating reactions on a permanent close
  // promise. Finishing the stream removes this waiter; releasing the reader
  // below settles a source read which is still pending at remote closure.
  function read(stream: Stream, reader: ReadableStreamDefaultReader<Uint8Array>) {
    return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
      const wake = () => {
        if (!stream.ended) return;
        stream.wake.delete(wake);
        resolve({ done: true, value: undefined });
      };
      stream.wake.add(wake);
      void reader.read().then(
        (value) => {
          stream.wake.delete(wake);
          resolve(value);
        },
        (error) => {
          stream.wake.delete(wake);
          reject(error);
        },
      );
      wake();
    });
  }

  return {
    async resolveDns(hostname) {
      const host = checkedHostname(hostname);
      if (numericAddress(host)) {
        if (syntheticAddress(host))
          throw new Error("198.18.0.0/15 is reserved for Wisp synthetic DNS");
        return [host];
      }
      const existing = names.get(host);
      if (existing) return [existing];
      if (names.size === MAX_NAMES) throw new Error("Wisp synthetic DNS capacity exceeded");
      const index = names.size + 1;
      const ip = `198.18.${Math.floor(index / 256)}.${index % 256}`;
      names.set(host, ip);
      addresses.set(ip, host);
      return [ip];
    },
    async connectTcp(session: TcpSession) {
      if (session.signal.aborted) throw session.signal.reason;
      const host = checkedHostname(session.target.hostname);
      if (numericAddress(host) && host.startsWith("127."))
        throw new Error("Wisp cannot route browser-host loopback through proxy loopback");
      if (
        !Number.isInteger(session.target.port) ||
        session.target.port <= 0 ||
        session.target.port > 65535
      )
        throw new TypeError("invalid Wisp TCP port");
      const target = addresses.get(host) ?? host;
      if (numericAddress(host) && syntheticAddress(host) && !addresses.has(host))
        throw new Error("unknown Wisp synthetic DNS address");
      if (streams.size >= MAX_STREAMS || nextId > 0xffffffff)
        throw new Error("Wisp stream capacity exceeded");
      const stream: Stream = {
        id: nextId++,
        connection: undefined,
        credit: 0,
        opened: false,
        ended: false,
        error: undefined,
        queue: [],
        bytes: 0,
        wake: new Set(),
      };
      streams.set(stream.id, stream);
      let closing = false;
      let completed = false;
      let abortTimer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        closeStream(stream, 2);
        finish(stream, new Error("Wisp TCP session aborted", { cause: session.signal.reason }));
        const c = stream.connection;
        if (
          c &&
          ![...streams.values()].some(
            (other) => other !== stream && other.connection === c && !other.ended,
          )
        )
          failConnection(c, stream.error!);
      };
      const onAbort = () => {
        if (closing) {
          // A successful guest FIN/ACK may abort the session inside the
          // sink's close callback. Let that same turn finish its stream close;
          // a genuinely stalled/failed close still observes cancellation.
          abortTimer = setTimeout(() => {
            if (!completed) abort();
          }, 0);
        } else abort();
      };
      session.signal.addEventListener("abort", onAbort, { once: true });
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
      try {
        const c = (stream.connection = getConnection());
        if (session.signal.aborted) abort();
        // Removable waiters avoid retaining aborted sessions on a shared
        // handshake promise while another session still awaits CONTINUE.
        while (!stream.ended && c.credit === undefined) await wait(stream);
        if (stream.ended) throw stream.error;
        stream.credit = c.credit!;
        const name = encoder.encode(target);
        const payload = new Uint8Array(3 + name.length);
        payload[0] = 1;
        new DataView(payload.buffer).setUint16(1, session.target.port, true);
        payload.set(name, 3);
        await send(stream, packet(1, stream.id, payload));
        stream.opened = true;
        reader = session.readable.getReader();
        writer = session.writable.getWriter();
        const outbound = async () => {
          while (!stream.ended) {
            const chunk = await read(stream, reader!);
            if (chunk.done || stream.ended) return;
            if (
              !(chunk.value instanceof Uint8Array) ||
              chunk.value.length > MAX_STREAM_BYTES ||
              chunk.value.length > MAX_TOTAL_BYTES - sendingBytes
            )
              throw new Error("Wisp outbound chunk capacity exceeded");
            sendingBytes += chunk.value.length;
            try {
              for (let offset = 0; offset < chunk.value.length; offset += MAX_PACKET) {
                if (stream.ended) return;
                try {
                  await send(
                    stream,
                    packet(2, stream.id, chunk.value.subarray(offset, offset + MAX_PACKET)),
                    true,
                  );
                } catch (error) {
                  if (stream.ended && !stream.error) return;
                  throw error;
                }
              }
            } finally {
              sendingBytes -= chunk.value.length;
            }
          }
        };
        const inbound = async () => {
          for (;;) {
            if (stream.error) throw stream.error;
            const chunk = stream.queue.shift();
            if (chunk) {
              stream.bytes -= chunk.length;
              receivedBytes -= chunk.length;
              await interruptOnError(stream, writer!.write(chunk));
            } else if (stream.ended) {
              closing = true;
              await interruptOnError(stream, writer!.close());
              completed = true;
              return;
            } else await wait(stream);
          }
        };
        await Promise.all([
          outbound().catch((error) => {
            finish(stream, error);
            throw error;
          }),
          inbound(),
        ]);
        if (stream.error) throw stream.error;
      } catch (error) {
        closeStream(stream, 0x81);
        finish(
          stream,
          error instanceof Error ? error : new Error("Wisp TCP failure", { cause: error }),
        );
        // Observe cancellation promises without waiting for a blocked guest sink.
        void reader?.cancel(error).catch(() => {});
        void writer?.abort(error).catch(() => {});
        throw error;
      } finally {
        session.signal.removeEventListener("abort", onAbort);
        if (abortTimer !== undefined) clearTimeout(abortTimer);
        reader?.releaseLock();
        writer?.releaseLock();
        receivedBytes -= stream.bytes;
        stream.bytes = 0;
        stream.queue.length = 0;
        streams.delete(stream.id);
        const c = stream.connection;
        if (c && ![...streams.values()].some((other) => other.connection === c))
          failConnection(c, new Error("Wisp final session ended"));
      }
    },
  };
}
