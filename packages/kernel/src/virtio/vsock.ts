// SPDX-License-Identifier: MIT

import { Struct, U16LE, U32LE, U64LE } from "@lowland/bytes";
import { assert } from "../util.ts";
import {
  VirtioController,
  type VirtioDevice,
  type Virtqueue,
  type VirtqueueChain,
} from "./core.ts";

class VsockConfig extends Struct({ guest_cid: U64LE }) {}

class VsockHeader extends Struct({
  src_cid: U64LE,
  dst_cid: U64LE,
  src_port: U32LE,
  dst_port: U32LE,
  len: U32LE,
  type: U16LE,
  op: U16LE,
  flags: U32LE,
  buf_alloc: U32LE,
  fwd_cnt: U32LE,
}) {}

const VsockType = { STREAM: 1 } as const;

const VsockOp = {
  REQUEST: 1,
  RESPONSE: 2,
  RST: 3,
  SHUTDOWN: 4,
  RW: 5,
  CREDIT_UPDATE: 6,
  CREDIT_REQUEST: 7,
} as const;

const VsockShutdown = {
  RCV: 1,
  SEND: 2,
} as const;
const VSOCK_FULL_SHUTDOWN = VsockShutdown.RCV | VsockShutdown.SEND;

const HOST_CID = 2n;
const DEFAULT_VSOCK_BUF_ALLOC = 256 * 1024;
const MAX_VSOCK_PAYLOAD = 2048;
const MAX_GUEST_PAYLOAD = 64 * 1024;
const MAX_LISTENERS = 64;
const MAX_INCOMING_CONNECTIONS = 64;
const LISTENER_BACKLOG = 16;
const MAX_PENDING_PACKETS = 1024;
// Keep ordinary flow-control replies possible while the device queues data.
const MAX_PENDING_DATA_PACKETS = MAX_PENDING_PACKETS - 64;
const MAX_PENDING_REFUSALS = 16;

function concat_bytes(chunks: Uint8Array[]) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** A stream connection between this process and a guest, over vsock. */
export interface VsockConnection {
  /** Reads the next chunk; an empty chunk means the read side reached EOF. */
  read(): Promise<Uint8Array>;
  /** Reads `length` bytes, or fewer if the read side reaches EOF first. */
  readExactly(length: number): Promise<Uint8Array>;
  /** Writes data, waiting for credit when the peer's buffer is full. */
  write(data: Uint8Array): Promise<void>;
  /** Closes the connection. */
  close(): void;
}

/** Accepts Linux-initiated streams on a host vsock port. */
export interface VsockListener {
  /** Waits for one connection, or returns null after close. Only one call may wait at a time. */
  accept(): Promise<VsockConnection | null>;
  /** Stops accepting and closes queued streams. Already accepted streams stay open. */
  close(): void;
}

interface VsockEndpoint {
  readonly local_port: number;
  readonly peer_port: number;
  readonly peer_cid: bigint;
}

interface VsockConnectionController {
  readonly connection: VsockConnection;
  readonly bytes_read: number;
  readonly peer_receive_closed: boolean;
  update_credit(buf_alloc: number, fwd_cnt: number): void;
  enqueue(data: Uint8Array): boolean;
  receive_shutdown(flags: number): boolean;
  wake_writers(): void;
  close_from_peer(): void;
}

interface VsockConnectionOps {
  send(op: number, flags: number, payload: Uint8Array, fwd_cnt: number): boolean;
  close(): void;
}

function create_vsock_connection(ops: VsockConnectionOps): VsockConnectionController {
  const read_buffer: Uint8Array[] = [];
  const read_waiters: ((value: Uint8Array) => void)[] = [];
  const credit_waiters: (() => void)[] = [];
  let closed = false;
  let peer_shutdown = 0;
  let bytes_read = 0;
  let bytes_received = 0;
  let bytes_written = 0;
  let last_credit_update = 0;
  let peer_buf_alloc = DEFAULT_VSOCK_BUF_ALLOC;
  let peer_fwd_cnt = 0;
  let read_tail = Promise.resolve();
  let write_tail = Promise.resolve();

  function wake_credit_waiters() {
    while (credit_waiters.length > 0) credit_waiters.shift()!();
  }

  function wake_readers_at_eof() {
    while (read_waiters.length > 0) {
      read_waiters.shift()!(new Uint8Array());
    }
  }

  function close_from_peer() {
    if (closed) return;
    closed = true;
    wake_readers_at_eof();
    wake_credit_waiters();
  }

  async function read_chunk(): Promise<Uint8Array> {
    const chunk = read_buffer.shift();
    if (chunk) return chunk;
    if (closed || peer_shutdown & VsockShutdown.SEND) return new Uint8Array();
    return new Promise((resolve) => read_waiters.push(resolve));
  }

  function consume(length: number) {
    bytes_read = (bytes_read + length) >>> 0;
    const consumed = (bytes_read - last_credit_update) >>> 0;
    if (
      consumed >= DEFAULT_VSOCK_BUF_ALLOC / 4 &&
      ops.send(VsockOp.CREDIT_UPDATE, 0, new Uint8Array(), bytes_read)
    ) {
      last_credit_update = bytes_read;
    }
  }

  async function read(): Promise<Uint8Array> {
    const chunk = await read_chunk();
    consume(chunk.byteLength);
    return chunk;
  }

  async function readExactly(length: number): Promise<Uint8Array> {
    const out = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const chunk = await read_chunk();
      if (chunk.byteLength === 0) break;
      const n = Math.min(chunk.byteLength, length - offset);
      out.set(chunk.subarray(0, n), offset);
      offset += n;
      consume(n);
      if (n < chunk.byteLength) {
        read_buffer.unshift(chunk.subarray(n).slice());
      }
    }
    return out.subarray(0, offset);
  }

  function queue_read(operation: () => Promise<Uint8Array>): Promise<Uint8Array> {
    // Reserve the stream until this read has restored any unconsumed suffix.
    const result = read_tail.then(operation);
    read_tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  async function write_serialized(data: Uint8Array) {
    let offset = 0;
    while (offset < data.byteLength) {
      if (closed) throw new Error("vsock connection is closed");
      if (peer_shutdown & VsockShutdown.RCV) throw new Error("vsock peer stopped receiving");
      const used = (bytes_written - peer_fwd_cnt) >>> 0;
      const available = Math.max(0, peer_buf_alloc - used);
      const n = Math.min(MAX_VSOCK_PAYLOAD, available, data.byteLength - offset);
      if (n === 0 || !ops.send(VsockOp.RW, 0, data.subarray(offset, offset + n), bytes_read)) {
        await new Promise<void>((resolve) => credit_waiters.push(resolve));
        continue;
      }
      offset += n;
      bytes_written = (bytes_written + n) >>> 0;
    }
  }

  function write(data: Uint8Array): Promise<void> {
    const bytes = data.slice();
    const result = write_tail.then(() => write_serialized(bytes));
    write_tail = result.catch(() => {});
    return result;
  }

  const connection: VsockConnection = {
    read() {
      return queue_read(read);
    },
    readExactly(length) {
      return queue_read(() => readExactly(length));
    },
    write,
    close() {
      if (closed) return;
      ops.close();
      close_from_peer();
    },
  };

  return {
    connection,
    get bytes_read() {
      return bytes_read;
    },
    get peer_receive_closed() {
      return (peer_shutdown & VsockShutdown.RCV) !== 0;
    },
    update_credit(buf_alloc, fwd_cnt) {
      // Only bytes already queued for transmission can have been consumed by the peer.
      if ((fwd_cnt - peer_fwd_cnt) >>> 0 > (bytes_written - peer_fwd_cnt) >>> 0) return;
      peer_buf_alloc = buf_alloc;
      peer_fwd_cnt = fwd_cnt;
      wake_credit_waiters();
    },
    enqueue(data) {
      if (closed || peer_shutdown & VsockShutdown.SEND || data.byteLength === 0) return true;
      const buffered = (bytes_received - bytes_read) >>> 0;
      if (buffered + data.byteLength > DEFAULT_VSOCK_BUF_ALLOC) return false;
      bytes_received = (bytes_received + data.byteLength) >>> 0;
      const waiter = read_waiters.shift();
      if (waiter) waiter(data);
      else read_buffer.push(data.slice());
      return true;
    },
    receive_shutdown(flags) {
      const new_flags = flags & VSOCK_FULL_SHUTDOWN & ~peer_shutdown;
      peer_shutdown |= new_flags;
      if (new_flags & VsockShutdown.SEND) wake_readers_at_eof();
      if (new_flags & VsockShutdown.RCV) wake_credit_waiters();
      return peer_shutdown === VSOCK_FULL_SHUTDOWN;
    },
    wake_writers: wake_credit_waiters,
    close_from_peer,
  };
}

interface VsockConnectionState extends VsockEndpoint {
  readonly key: string;
  readonly controller: VsockConnectionController;
  readonly listener?: VsockListenerState;
  closing: boolean;
  termination?: VsockTerminationPacket;
  handshake?: {
    resolve(connection: VsockConnection): void;
    reject(error: Error): void;
  };
}

interface VsockTerminationPacket {
  readonly kind: "termination";
  readonly owner: VsockConnectionState;
  bytes: Uint8Array;
  reset?: { error: Error; preserve_pending: boolean };
}

type VsockQueuedPacket =
  | { kind: "stream"; bytes: Uint8Array; owner: VsockConnectionState; op: number }
  | { kind: "refusal"; bytes: Uint8Array; key: string }
  | VsockTerminationPacket;

interface VsockListenerState {
  readonly port: number;
  readonly pending: VsockConnectionState[];
  wait?: (connection: VsockConnection | null) => void;
  closed: boolean;
}

/**
 * A virtio-vsock device: stream sockets between the guest and this process,
 * addressed by port.
 */
export interface VsockDevice extends VirtioDevice {
  /** Connects to a vsock listener on `port` in the guest. */
  connect(
    port: number,
    options?: {
      /** Connection timeout in milliseconds. Defaults to 5000. */
      timeoutMs?: number;
    },
  ): Promise<VsockConnection>;
  /** Listens for connections to this host port (CID 2) from the Linux instance. */
  listen(port: number): VsockListener;
  /** Closes the device and every connection on it. */
  close(): void;
}

/**
 * A virtio-vsock device. `guestCid` is the context ID assigned to the
 * guest, defaulting to 3.
 */
export function vsockDevice({ guestCid = 3n }: { guestCid?: bigint } = {}): VsockDevice {
  const config = new Uint8Array(VsockConfig.size);
  new VsockConfig(config).guest_cid = guestCid;

  const rx_buffers: VirtqueueChain[] = [];
  const pending_packets: VsockQueuedPacket[] = [];
  const connections = new Map<string, VsockConnectionState>();
  const active_ports = new Map<number, number>();
  const listeners = new Map<number, VsockListenerState>();
  let queued_packets = 0;
  let queued_refusals = 0;
  let incoming_count = 0;
  let next_port = 49152;
  let closed = false;

  function endpoint_key({ local_port, peer_cid, peer_port }: VsockEndpoint) {
    return `${local_port}:${peer_cid}:${peer_port}`;
  }

  function valid_port(port: number) {
    return Number.isInteger(port) && port >= 0 && port < 0xffffffff;
  }

  function allocate_port() {
    for (let attempts = 0; attempts < 65536 - 49152; attempts++) {
      const port = next_port;
      next_port = port === 65535 ? 49152 : port + 1;
      if (!active_ports.has(port) && !listeners.has(port)) return port;
    }
    throw new Error("no local vsock ports available");
  }

  function flush_rx() {
    const data_queue_was_full = queued_packets >= MAX_PENDING_DATA_PACKETS;
    while (pending_packets.length > 0) {
      const packet = pending_packets[0]!;
      const stale =
        (packet.kind === "stream" &&
          (connections.get(packet.owner.key) !== packet.owner ||
            (packet.op === VsockOp.RW && packet.owner.controller.peer_receive_closed))) ||
        (packet.kind === "refusal" && connections.has(packet.key));
      if (!stale && rx_buffers.length === 0) break;
      pending_packets.shift();
      if (packet.kind !== "termination") queued_packets--;
      if (packet.kind === "refusal") queued_refusals--;
      if (stale) continue;

      const chain = rx_buffers.shift()!;
      const [desc, next_desc] = chain;
      assert(desc && desc.writable, "vsock rx buffer must be writable");
      assert(!next_desc, "vsock rx buffer should be a single descriptor");
      assert(desc.array.byteLength >= packet.bytes.byteLength, "vsock rx buffer too small");

      desc.array.set(packet.bytes);
      chain.release(packet.bytes.byteLength);
      if (packet.kind === "termination" && packet.owner.termination === packet) {
        packet.owner.termination = undefined;
        if (packet.reset) forget(packet.owner, packet.reset.error, packet.reset.preserve_pending);
      }
    }
    if (data_queue_was_full && queued_packets < MAX_PENDING_DATA_PACKETS) {
      for (const state of connections.values()) state.controller.wake_writers();
    }
  }

  function make_packet(
    endpoint: VsockEndpoint,
    op: number,
    flags = 0,
    payload: Uint8Array = new Uint8Array(),
    fwd_cnt = 0,
  ) {
    const packet = new Uint8Array(VsockHeader.size + payload.byteLength);
    const hdr = new VsockHeader(packet);
    hdr.src_cid = HOST_CID;
    hdr.dst_cid = endpoint.peer_cid;
    hdr.src_port = endpoint.local_port;
    hdr.dst_port = endpoint.peer_port;
    hdr.len = payload.byteLength;
    hdr.type = VsockType.STREAM;
    hdr.op = op;
    hdr.flags = flags;
    hdr.buf_alloc = DEFAULT_VSOCK_BUF_ALLOC;
    hdr.fwd_cnt = fwd_cnt;
    packet.set(payload, VsockHeader.size);
    return packet;
  }

  function send_packet(
    owner: VsockConnectionState,
    op: number,
    flags = 0,
    payload: Uint8Array = new Uint8Array(),
    fwd_cnt = 0,
  ) {
    const limit = op === VsockOp.RW ? MAX_PENDING_DATA_PACKETS : MAX_PENDING_PACKETS;
    if (queued_packets >= limit) return false;
    pending_packets.push({
      kind: "stream",
      bytes: make_packet(owner, op, flags, payload, fwd_cnt),
      owner,
      op,
    });
    queued_packets++;
    flush_rx();
    return true;
  }

  function refuse(endpoint: VsockEndpoint) {
    if (queued_refusals >= MAX_PENDING_REFUSALS || queued_packets >= MAX_PENDING_DATA_PACKETS)
      return;
    pending_packets.push({
      kind: "refusal",
      bytes: make_packet(endpoint, VsockOp.RST),
      key: endpoint_key(endpoint),
    });
    queued_packets++;
    queued_refusals++;
    flush_rx();
  }

  function terminate(state: VsockConnectionState, reset?: VsockTerminationPacket["reset"]) {
    // Each reserved tuple gets one terminal packet, independent of ordinary
    // packet credit. It shares the FIFO so accepted writes go out first.
    // The ephemeral-port pool and incoming admission cap also bound these slots.
    const previous = state.termination;
    if (previous && (!reset || previous.reset)) return;
    const bytes = reset
      ? make_packet(state, VsockOp.RST)
      : make_packet(
          state,
          VsockOp.SHUTDOWN,
          VSOCK_FULL_SHUTDOWN,
          new Uint8Array(),
          state.controller.bytes_read,
        );
    state.closing = true;
    state.controller.close_from_peer();
    if (reset) {
      state.handshake?.reject(reset.error);
      state.handshake = undefined;
    }
    if (previous) {
      previous.bytes = bytes;
      previous.reset = reset;
    } else {
      const packet: VsockTerminationPacket = { kind: "termination", owner: state, bytes, reset };
      state.termination = packet;
      pending_packets.push(packet);
    }
    flush_rx();
  }

  function forget(state: VsockConnectionState, error: Error, preserve_pending = false) {
    if (state.termination) {
      const index = pending_packets.indexOf(state.termination);
      if (index !== -1) pending_packets.splice(index, 1);
      state.termination = undefined;
    }
    connections.delete(state.key);
    const count = active_ports.get(state.local_port)!;
    if (count === 1) active_ports.delete(state.local_port);
    else active_ports.set(state.local_port, count - 1);
    state.controller.close_from_peer();
    state.handshake?.reject(error);
    state.handshake = undefined;
    if (state.listener) {
      const pending = state.listener.pending;
      const index = pending.indexOf(state);
      if (index !== -1 && preserve_pending) return;
      if (index !== -1) pending.splice(index, 1);
      incoming_count--;
    }
  }

  function create_state(endpoint: VsockEndpoint, listener?: VsockListenerState) {
    const connection = create_vsock_connection({
      send(op, flags, payload, fwd_cnt) {
        if (closed || state.closing || connections.get(state.key) !== state) return false;
        return send_packet(state, op, flags, payload, fwd_cnt);
      },
      close() {
        if (connections.get(state.key) !== state) return;
        // Reserve the tuple until peer shutdown. Otherwise late traffic could
        // reach another connection after the port is recycled.
        terminate(state);
      },
    });
    const state: VsockConnectionState = {
      ...endpoint,
      key: endpoint_key(endpoint),
      controller: connection,
      listener,
      closing: false,
    };
    connections.set(state.key, state);
    active_ports.set(state.local_port, (active_ports.get(state.local_port) ?? 0) + 1);
    if (listener) incoming_count++;
    return state;
  }

  function read_tx_packet(chain: VirtqueueChain) {
    const readable: Uint8Array[] = [];
    let length = 0;
    for (const desc of chain) {
      length += desc.array.byteLength;
      if (desc.writable || length > VsockHeader.size + MAX_GUEST_PAYLOAD) return;
      readable.push(desc.array);
    }
    if (length < VsockHeader.size) return;
    const header_bytes = concat_bytes(readable);
    const header = new VsockHeader(header_bytes);
    if (header.len > length - VsockHeader.size) return;
    const payload = header_bytes.subarray(VsockHeader.size, VsockHeader.size + header.len);
    return { header, payload };
  }

  function accept_request(endpoint: VsockEndpoint, header: VsockHeader) {
    const listener = listeners.get(endpoint.local_port);
    if (
      !listener ||
      listener.pending.length >= LISTENER_BACKLOG ||
      incoming_count >= MAX_INCOMING_CONNECTIONS ||
      header.fwd_cnt !== 0
    ) {
      refuse(endpoint);
      return;
    }
    const state = create_state(endpoint, listener);
    state.controller.update_credit(header.buf_alloc, header.fwd_cnt);
    if (!send_packet(state, VsockOp.RESPONSE)) {
      forget(state, new Error("vsock response queue is full"));
      return;
    }
    if (listener.wait) {
      const deliver = listener.wait;
      listener.wait = undefined;
      deliver(state.controller.connection);
    } else {
      listener.pending.push(state);
    }
  }

  function handle_tx_packet(header: VsockHeader, payload: Uint8Array) {
    if (
      header.dst_cid !== HOST_CID ||
      header.src_cid !== guestCid ||
      header.type !== VsockType.STREAM ||
      (header.op !== VsockOp.RW && header.len !== 0)
    )
      return;
    const endpoint = {
      local_port: header.dst_port,
      peer_port: header.src_port,
      peer_cid: header.src_cid,
    };
    const state = connections.get(endpoint_key(endpoint));
    if (!state) {
      if (header.op === VsockOp.REQUEST) accept_request(endpoint, header);
      else if (header.op !== VsockOp.RST) refuse(endpoint);
      return;
    }

    const connection = state.controller;
    connection.update_credit(header.buf_alloc, header.fwd_cnt);

    switch (header.op) {
      case VsockOp.REQUEST:
        if (state.listener && !state.closing)
          send_packet(state, VsockOp.RESPONSE, 0, new Uint8Array(), connection.bytes_read);
        break;
      case VsockOp.RESPONSE:
        state.handshake?.resolve(connection.connection);
        state.handshake = undefined;
        break;
      case VsockOp.RW:
        if (!state.closing && !state.handshake && !connection.enqueue(payload)) {
          terminate(state, {
            error: new Error("vsock peer exceeded receive credit"),
            preserve_pending: false,
          });
        }
        break;
      case VsockOp.CREDIT_UPDATE:
        break;
      case VsockOp.CREDIT_REQUEST:
        if (!state.closing)
          send_packet(state, VsockOp.CREDIT_UPDATE, 0, new Uint8Array(), connection.bytes_read);
        break;
      case VsockOp.SHUTDOWN:
        if (connection.receive_shutdown(header.flags)) {
          terminate(state, {
            error: new Error("guest shut down vsock connection"),
            preserve_pending: true,
          });
        } else {
          flush_rx();
        }
        break;
      case VsockOp.RST:
        forget(state, new Error("guest reset vsock connection"));
        flush_rx();
        break;
      default:
        console.warn("unknown vsock op", header.op);
    }
  }

  function notify_rx(queue: Virtqueue) {
    for (const chain of queue) rx_buffers.push(chain);
    flush_rx();
  }

  function notify_tx(queue: Virtqueue) {
    for (const chain of queue) {
      const packet = read_tx_packet(chain);
      if (packet) handle_tx_packet(packet.header, packet.payload);
      chain.release(0);
    }
  }

  function discard_pending(listener: VsockListenerState, reset_peer: boolean) {
    for (const state of listener.pending.splice(0)) {
      if (connections.get(state.key) === state) {
        if (reset_peer)
          terminate(state, {
            error: new Error("vsock listener is closed"),
            preserve_pending: false,
          });
        else forget(state, new Error("vsock listener is closed"));
      } else {
        incoming_count--;
      }
    }
  }

  function close_listener(listener: VsockListenerState) {
    if (listener.closed) return;
    listener.closed = true;
    listeners.delete(listener.port);
    discard_pending(listener, true);
    listener.wait?.(null);
    listener.wait = undefined;
  }

  function reset_device() {
    rx_buffers.length = 0;
    pending_packets.length = 0;
    queued_packets = 0;
    queued_refusals = 0;
    for (const state of connections.values()) {
      forget(state, new Error("vsock device reset while connecting"));
    }
    for (const listener of listeners.values()) discard_pending(listener, false);
  }

  function close_device() {
    for (const listener of listeners.values()) close_listener(listener);
    for (const state of connections.values()) {
      terminate(state, {
        error: new Error("vsock device closed while connecting"),
        preserve_pending: false,
      });
    }
    // The stopped transport cannot receive any more RX buffers. Retire any
    // terminations it could not publish along with the detached queues.
    reset_device();
  }

  const controller = new VirtioController(
    { deviceId: 19, config },
    {
      queues: [
        notify_rx,
        notify_tx,
        () => {
          // Event buffers are only needed for host transport reset, which is
          // not supported yet.
        },
      ],
      reset: reset_device,
      stop() {
        closed = true;
      },
      close: close_device,
    },
  );

  function connect(
    port: number,
    { timeoutMs = 5000 }: { timeoutMs?: number } = {},
  ): Promise<VsockConnection> {
    if (closed) {
      return Promise.reject(new Error("vsock device is closed"));
    }
    if (!valid_port(port)) return Promise.reject(new RangeError("invalid vsock port"));
    const state = create_state({
      local_port: allocate_port(),
      peer_port: port,
      peer_cid: guestCid,
    });

    const promise = new Promise<VsockConnection>((resolve, reject) => {
      const timeout = setTimeout(() => {
        terminate(state, {
          error: new Error(`timed out connecting to guest vsock port ${port}`),
          preserve_pending: false,
        });
      }, timeoutMs);

      state.handshake = {
        resolve(value) {
          clearTimeout(timeout);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timeout);
          reject(error);
        },
      };
    });

    if (!send_packet(state, VsockOp.REQUEST)) {
      forget(state, new Error("vsock request queue is full"));
    }
    return promise;
  }

  function listen(port: number): VsockListener {
    if (closed) throw new Error("vsock device is closed");
    if (!valid_port(port)) throw new RangeError("invalid vsock port");
    if (active_ports.has(port) || listeners.has(port)) throw new Error("vsock port is in use");
    if (listeners.size >= MAX_LISTENERS) throw new Error("too many vsock listeners");
    const listener: VsockListenerState = { port, pending: [], closed: false };
    listeners.set(port, listener);
    return {
      async accept() {
        if (listener.closed) return null;
        const state = listener.pending.shift();
        if (state) {
          if (connections.get(state.key) !== state) incoming_count--;
          return state.controller.connection;
        }
        if (listener.wait) throw new Error("another vsock accept is already pending");
        return new Promise((resolve) => {
          listener.wait = resolve;
        });
      },
      close() {
        close_listener(listener);
      },
    };
  }

  return controller.expose({ connect, listen, close: controller.close });
}
