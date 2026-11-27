// SPDX-License-Identifier: MIT

import { I32LE, Struct, U16LE } from "@lowland/bytes";
import { assert } from "../util.ts";
import {
  VirtioController,
  type VirtioDevice,
  type Virtqueue,
  type VirtqueueChain,
} from "./core.ts";

/** Virtio device ID for `virtio-input` (`VIRTIO_ID_INPUT`). */
export const VIRTIO_ID_INPUT = 18;

/** Configuration selectors from `<uapi/linux/virtio_input.h>`. */
export const VirtioInputConfigSelect = {
  UNSET: 0x00,
  ID_NAME: 0x01,
  ID_SERIAL: 0x02,
  ID_DEVIDS: 0x03,
  PROP_BITS: 0x10,
  EV_BITS: 0x11,
  ABS_INFO: 0x12,
} as const;

export type VirtioInputConfigSelectValue =
  (typeof VirtioInputConfigSelect)[keyof typeof VirtioInputConfigSelect];

/** Linux input event (`struct virtio_input_event`). */
export interface VirtioInputEvent {
  type: number;
  code: number;
  value: number;
}

/** Device identification tuple (`struct virtio_input_devids`). */
export interface VirtioInputDevids {
  bustype: number;
  vendor: number;
  product: number;
  version: number;
}

/** Absolute axis metadata (`struct virtio_input_absinfo`). */
export interface VirtioInputAbsInfo {
  min: number;
  max: number;
  fuzz: number;
  flat: number;
  res: number;
}

/** Configuration options for {@link inputDevice}. */
export interface VirtioInputOptions {
  /** Human-readable device name (`VIRTIO_INPUT_CFG_ID_NAME`). */
  name?: string;
  /** Device serial string (`VIRTIO_INPUT_CFG_ID_SERIAL`). */
  serial?: string;
  /** Bus/vendor/product/version tuple (`VIRTIO_INPUT_CFG_ID_DEVIDS`). */
  devids?: Partial<VirtioInputDevids>;
  /** Supported `INPUT_PROP_*` bit numbers (`VIRTIO_INPUT_CFG_PROP_BITS`). */
  propBits?: readonly number[];
  /** Supported event codes keyed by `EV_*` type (`VIRTIO_INPUT_CFG_EV_BITS`). */
  evBits?: ReadonlyMap<number, readonly number[]> | Readonly<Record<number, readonly number[]>>;
  /** Absolute axis ranges keyed by `ABS_*` code (`VIRTIO_INPUT_CFG_ABS_INFO`). */
  absInfo?:
    | ReadonlyMap<number, Partial<VirtioInputAbsInfo>>
    | Readonly<Record<number, Partial<VirtioInputAbsInfo>>>;
  /** Optional handler for guest status events (such as keyboard LEDs) on `statusq`. */
  onStatus?: (event: VirtioInputEvent) => void;
}

/** A virtio input device (`VIRTIO_ID_INPUT = 18`). */
export interface InputDevice extends VirtioDevice {
  /** Queues a single input event for delivery on `eventq` (queue 0). */
  sendEvent(event: VirtioInputEvent): void;
  /** Queues multiple input events for delivery on `eventq` (queue 0). */
  sendEvents(events: readonly VirtioInputEvent[]): void;
  /** Evaluates a `virtio_input_config` selector query into a 136-byte config buffer. */
  queryConfig(select: number, subsel?: number): Uint8Array;
}

class VirtioInputEventStruct extends Struct({
  type: U16LE,
  code: U16LE,
  value: I32LE,
}) {}

const CONFIG_HEADER_BYTES = 8;
const CONFIG_PAYLOAD_BYTES = 128;
const CONFIG_TOTAL_BYTES = CONFIG_HEADER_BYTES + CONFIG_PAYLOAD_BYTES;

const DEFAULT_DEVIDS: VirtioInputDevids = {
  bustype: 0x06, // BUS_VIRTUAL
  vendor: 0x1af4,
  product: 0x0012,
  version: 0x0001,
};

function encodeBitmap(bits: readonly number[], target: Uint8Array): number {
  let maxByte = 0;
  for (const bit of bits) {
    if (!Number.isInteger(bit) || bit < 0 || bit >= CONFIG_PAYLOAD_BYTES * 8) {
      throw new RangeError(`input bit out of range: ${bit}`);
    }
    const byteIndex = bit >> 3;
    target[byteIndex] = (target[byteIndex] ?? 0) | (1 << (bit & 7));
    if (byteIndex + 1 > maxByte) maxByte = byteIndex + 1;
  }
  return maxByte;
}

function lookupEvBits(
  evBits: VirtioInputOptions["evBits"],
  subsel: number,
): readonly number[] | undefined {
  if (!evBits) return undefined;
  if (evBits instanceof Map) return evBits.get(subsel);
  return (evBits as Readonly<Record<number, readonly number[]>>)[subsel];
}

function lookupAbsInfo(
  absInfo: VirtioInputOptions["absInfo"],
  subsel: number,
): Partial<VirtioInputAbsInfo> | undefined {
  if (!absInfo) return undefined;
  if (absInfo instanceof Map) return absInfo.get(subsel);
  return (absInfo as Readonly<Record<number, Partial<VirtioInputAbsInfo>>>)[subsel];
}

/**
 * Creates a virtio input device (`VIRTIO_ID_INPUT = 18`) with `eventq` (queue 0)
 * for host-to-guest input events and `statusq` (queue 1) for guest-to-host status
 * updates.
 */
export function inputDevice(options: VirtioInputOptions = {}): InputDevice {
  const nameBytes = new TextEncoder().encode(options.name ?? "Wasm Virtio Input");
  const serialBytes = new TextEncoder().encode(options.serial ?? "wasm-input-0");
  const devids: VirtioInputDevids = { ...DEFAULT_DEVIDS, ...options.devids };

  const event_chains: VirtqueueChain[] = [];
  const pending_events: VirtioInputEvent[] = [];

  function queryConfig(select: number, subsel = 0): Uint8Array {
    const config = new Uint8Array(CONFIG_TOTAL_BYTES);
    const view = new DataView(config.buffer);
    config[0] = select & 0xff;
    config[1] = subsel & 0xff;
    let payloadSize = 0;
    const payload = config.subarray(CONFIG_HEADER_BYTES);

    switch (select) {
      case VirtioInputConfigSelect.UNSET:
        break;
      case VirtioInputConfigSelect.ID_NAME: {
        const len = Math.min(nameBytes.byteLength, CONFIG_PAYLOAD_BYTES);
        payload.set(nameBytes.subarray(0, len));
        payloadSize = len;
        break;
      }
      case VirtioInputConfigSelect.ID_SERIAL: {
        const len = Math.min(serialBytes.byteLength, CONFIG_PAYLOAD_BYTES);
        payload.set(serialBytes.subarray(0, len));
        payloadSize = len;
        break;
      }
      case VirtioInputConfigSelect.ID_DEVIDS:
        view.setUint16(CONFIG_HEADER_BYTES + 0, devids.bustype, true);
        view.setUint16(CONFIG_HEADER_BYTES + 2, devids.vendor, true);
        view.setUint16(CONFIG_HEADER_BYTES + 4, devids.product, true);
        view.setUint16(CONFIG_HEADER_BYTES + 6, devids.version, true);
        payloadSize = 8;
        break;
      case VirtioInputConfigSelect.PROP_BITS:
        if (options.propBits && options.propBits.length > 0) {
          payloadSize = encodeBitmap(options.propBits, payload);
        }
        break;
      case VirtioInputConfigSelect.EV_BITS: {
        const bits = lookupEvBits(options.evBits, subsel);
        if (bits && bits.length > 0) {
          payloadSize = encodeBitmap(bits, payload);
        }
        break;
      }
      case VirtioInputConfigSelect.ABS_INFO: {
        const info = lookupAbsInfo(options.absInfo, subsel);
        if (info) {
          view.setUint32(CONFIG_HEADER_BYTES + 0, info.min ?? 0, true);
          view.setUint32(CONFIG_HEADER_BYTES + 4, info.max ?? 0, true);
          view.setUint32(CONFIG_HEADER_BYTES + 8, info.fuzz ?? 0, true);
          view.setUint32(CONFIG_HEADER_BYTES + 12, info.flat ?? 0, true);
          view.setUint32(CONFIG_HEADER_BYTES + 16, info.res ?? 0, true);
          payloadSize = 20;
        }
        break;
      }
      default:
        break;
    }

    config[2] = payloadSize;
    return config;
  }

  function flush_events() {
    while (event_chains.length > 0 && pending_events.length > 0) {
      const chain = event_chains.shift()!;
      const event = pending_events.shift()!;
      const buffers: Uint8Array[] = [];
      for (const desc of chain) {
        assert(desc.writable, "eventq buffer must be writable");
        buffers.push(desc.array);
      }
      const target = buffers[0];
      assert(
        target && target.byteLength >= VirtioInputEventStruct.size,
        "eventq buffer must hold struct virtio_input_event",
      );
      const record = new VirtioInputEventStruct(target.subarray(0, VirtioInputEventStruct.size));
      record.type = event.type;
      record.code = event.code;
      record.value = event.value;
      chain.release(VirtioInputEventStruct.size);
    }
  }

  function notify_eventq(queue: Virtqueue) {
    for (const chain of queue) {
      event_chains.push(chain);
    }
    flush_events();
  }

  function notify_statusq(queue: Virtqueue) {
    for (const chain of queue) {
      for (const desc of chain) {
        assert(!desc.writable, "statusq buffer must be readable");
        if (desc.array.byteLength >= VirtioInputEventStruct.size && options.onStatus) {
          const record = new VirtioInputEventStruct(
            desc.array.subarray(0, VirtioInputEventStruct.size),
          );
          options.onStatus({
            type: record.type,
            code: record.code,
            value: record.value,
          });
        }
      }
      chain.release(0);
    }
  }

  function reset() {
    event_chains.length = 0;
  }

  const controller = new VirtioController(
    {
      deviceId: VIRTIO_ID_INPUT,
      config: queryConfig(VirtioInputConfigSelect.ID_NAME, 0),
    },
    {
      queues: [notify_eventq, notify_statusq],
      setConfig(config, offset, length) {
        if (offset < 2 && offset + length > 0) {
          return queryConfig(config[0] ?? 0, config[1] ?? 0);
        }
      },
      reset,
    },
  );

  return controller.expose({
    sendEvent(event: VirtioInputEvent) {
      pending_events.push({ ...event });
      flush_events();
    },
    sendEvents(events: readonly VirtioInputEvent[]) {
      for (const event of events) pending_events.push({ ...event });
      flush_events();
    },
    queryConfig,
  });
}
