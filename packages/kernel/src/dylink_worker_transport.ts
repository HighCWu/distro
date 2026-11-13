// SPDX-License-Identifier: MIT

import {
  DylinkWorkerSnapshotError,
  type DylinkWorkerPublication,
} from "./dylink_process_worker.ts";
import { decode_linux_bytes, encode_linux_string } from "./linux-string.ts";

const MAGIC = [0x44, 0x57, 0x50, 0x55] as const; // DWPU
// Version 2 strings are Linux byte strings; U+DC80..U+DCFF round-trip as raw filename bytes.
const VERSION = 2;
const HEADER_BYTES = 12;
const MAX_WIRE_BYTES = 64 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = MAX_WIRE_BYTES - HEADER_BYTES;
const MAX_DEPTH = 64;
const BLOCK_BYTES = 16 * 1024;

const TAG_NULL = 0;
const TAG_FALSE = 1;
const TAG_TRUE = 2;
const TAG_NUMBER = 3;
const TAG_BIGINT = 4;
const TAG_STRING = 5;
const TAG_BYTES = 6;
const TAG_ARRAY = 7;
const TAG_RECORD = 8;

type ByteView = Uint8Array<ArrayBufferLike>;
type OwnedBytes = Uint8Array<ArrayBuffer>;

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const typedArrayByteOffsetGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteOffset",
)?.get;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)?.get;
function invalid(message: string, cause?: unknown): never {
  throw new DylinkWorkerSnapshotError("EINVAL", message, { cause });
}

function unsupported(message: string): never {
  throw new DylinkWorkerSnapshotError("EOPNOTSUPP", message);
}

function noMemory(message: string, cause?: unknown): never {
  throw new DylinkWorkerSnapshotError("ENOMEM", message, { cause });
}

function rethrowCodecError(error: unknown, label: string): never {
  if (error instanceof DylinkWorkerSnapshotError) throw error;
  if (error instanceof RangeError) noMemory(`${label} exhausted memory`, error);
  invalid(`${label} is not a valid publication wire value`, error);
}

function allocateBytes(length: number, label: string): OwnedBytes {
  try {
    return new Uint8Array(length);
  } catch (error) {
    if (error instanceof RangeError) noMemory(`${label} allocation failed`, error);
    throw error;
  }
}

function byteView(value: unknown, label: string): ByteView {
  if (
    !(value instanceof Uint8Array) ||
    !typedArrayBufferGetter ||
    !typedArrayByteOffsetGetter ||
    !typedArrayByteLengthGetter
  )
    invalid(`${label} must be a Uint8Array`);
  try {
    const buffer = typedArrayBufferGetter.call(value) as ArrayBufferLike;
    const offset = typedArrayByteOffsetGetter.call(value) as number;
    const length = typedArrayByteLengthGetter.call(value) as number;
    return new Uint8Array(buffer, offset, length);
  } catch (error) {
    invalid(`${label} is not a usable byte view`, error);
  }
}

function validateUnicode(value: string, label: string): void {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) invalid(`${label} contains an unpaired UTF-16 surrogate`);
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) invalid(`${label} contains an unpaired UTF-16 surrogate`);
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff && (unit < 0xdc80 || unit > 0xdcff)) {
      invalid(`${label} contains an unpaired UTF-16 surrogate`);
    }
  }
}

function encodeText(value: string, label: string): OwnedBytes {
  validateUnicode(value, label);
  try {
    return encode_linux_string(value);
  } catch (error) {
    rethrowCodecError(error, label);
  }
}

type Block = { bytes: OwnedBytes; view: DataView; used: number };

class PayloadWriter {
  #blocks: Block[] = [];
  #current: Block | null = null;
  #length = 0;

  get length(): number {
    return this.#length;
  }

  #newBlock(): Block {
    const bytes = allocateBytes(BLOCK_BYTES, "publication encoder block");
    const block = { bytes, view: new DataView(bytes.buffer), used: 0 };
    this.#blocks.push(block);
    this.#current = block;
    return block;
  }

  #reserve(byteLength: number): { block: Block; offset: number } {
    if (byteLength < 0 || byteLength > BLOCK_BYTES || byteLength > MAX_PAYLOAD_BYTES - this.#length)
      invalid("publication exceeds the transport size limit");
    let block = this.#current;
    if (!block || BLOCK_BYTES - block.used < byteLength) block = this.#newBlock();
    const offset = block.used;
    block.used += byteLength;
    this.#length += byteLength;
    return { block, offset };
  }

  writeU8(value: number): void {
    const { block, offset } = this.#reserve(1);
    block.bytes[offset] = value;
  }

  writeU32(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff)
      invalid("publication length field is out of range");
    const { block, offset } = this.#reserve(4);
    block.view.setUint32(offset, value, true);
  }

  writeF64(value: number): void {
    const { block, offset } = this.#reserve(8);
    block.view.setFloat64(offset, value, true);
  }

  writeBytes(bytes: ByteView): void {
    if (bytes.byteLength > MAX_PAYLOAD_BYTES - this.#length)
      invalid("publication exceeds the transport size limit");
    let sourceOffset = 0;
    while (sourceOffset < bytes.byteLength) {
      let block = this.#current;
      if (!block || block.used === BLOCK_BYTES) block = this.#newBlock();
      const amount = Math.min(BLOCK_BYTES - block.used, bytes.byteLength - sourceOffset);
      block.bytes.set(bytes.subarray(sourceOffset, sourceOffset + amount), block.used);
      block.used += amount;
      this.#length += amount;
      sourceOffset += amount;
    }
  }

  finish(): OwnedBytes {
    const output = allocateBytes(HEADER_BYTES + this.#length, "publication output");
    output.set(MAGIC, 0);
    const header = new DataView(output.buffer);
    header.setUint32(4, VERSION, true);
    header.setUint32(8, this.#length, true);
    let offset = HEADER_BYTES;
    for (const block of this.#blocks) {
      if (block.used !== 0) {
        output.set(block.bytes.subarray(0, block.used), offset);
        offset += block.used;
      }
    }
    if (offset !== output.byteLength) invalid("publication encoder length accounting failed");
    return output;
  }
}

function writeString(writer: PayloadWriter, value: string, label: string): void {
  const bytes = encodeText(value, label);
  writer.writeU32(bytes.byteLength);
  writer.writeBytes(bytes);
}

function writeBigInt(writer: PayloadWriter, value: bigint): void {
  const negative = value < 0n;
  let magnitude = negative ? -value : value;
  let length = 0;
  for (let remaining = magnitude; remaining !== 0n; remaining >>= 8n) {
    length++;
    if (length > MAX_PAYLOAD_BYTES) invalid("BigInt is too large for the publication transport");
  }
  writer.writeU8(negative ? 1 : 0);
  writer.writeU32(length);
  if (length === 0) return;
  const bytes = allocateBytes(length, "publication BigInt");
  for (let index = length - 1; index >= 0; index--) {
    bytes[index] = Number(magnitude & 0xffn);
    magnitude >>= 8n;
  }
  writer.writeBytes(bytes);
}

function writeArray(
  writer: PayloadWriter,
  value: unknown[],
  ancestors: Set<object>,
  depth: number,
  label: string,
): void {
  if (ancestors.has(value)) invalid(`${label} contains a cycle`);
  if (Object.getPrototypeOf(value) !== Array.prototype) invalid(`${label} must be a plain array`);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !lengthDescriptor ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value)
  )
    invalid(`${label} has an invalid length`);
  const length = lengthDescriptor.value as number;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== length + 1 ||
    keys.some(
      (key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)),
    )
  )
    invalid(`${label} has unsupported array properties`);
  ancestors.add(value);
  try {
    writer.writeU8(TAG_ARRAY);
    writer.writeU32(length);
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor))
        invalid(`${label}[${index}] is sparse or an accessor`);
      writeValue(writer, descriptor.value, ancestors, depth + 1, `${label}[${index}]`);
    }
  } finally {
    ancestors.delete(value);
  }
}

function writeRecord(
  writer: PayloadWriter,
  value: object,
  ancestors: Set<object>,
  depth: number,
  label: string,
): void {
  if (ancestors.has(value)) invalid(`${label} contains a cycle`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    invalid(`${label} must be a plain data record`);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) invalid(`${label} has a symbol key`);
  ancestors.add(value);
  try {
    writer.writeU8(TAG_RECORD);
    writer.writeU32(keys.length);
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) invalid(`${label}.${key} is an accessor`);
      writeString(writer, key, `${label} key`);
      writeValue(writer, descriptor.value, ancestors, depth + 1, `${label}.${key}`);
    }
  } finally {
    ancestors.delete(value);
  }
}

function writeValue(
  writer: PayloadWriter,
  value: unknown,
  ancestors: Set<object>,
  depth: number,
  label: string,
): void {
  if (depth > MAX_DEPTH) invalid(`${label} exceeds the maximum nesting depth`);
  if (value === null) {
    writer.writeU8(TAG_NULL);
    return;
  }
  switch (typeof value) {
    case "boolean":
      writer.writeU8(value ? TAG_TRUE : TAG_FALSE);
      return;
    case "number":
      if (!Number.isFinite(value)) invalid(`${label} must be a finite number`);
      writer.writeU8(TAG_NUMBER);
      writer.writeF64(value);
      return;
    case "bigint":
      writer.writeU8(TAG_BIGINT);
      writeBigInt(writer, value);
      return;
    case "string":
      writer.writeU8(TAG_STRING);
      writeString(writer, value, label);
      return;
    case "object":
      break;
    default:
      invalid(`${label} has an unsupported value type`);
  }

  if (value instanceof Uint8Array) {
    const bytes = byteView(value, label);
    writer.writeU8(TAG_BYTES);
    writer.writeU32(bytes.byteLength);
    writer.writeBytes(bytes);
    return;
  }
  if (Array.isArray(value)) {
    writeArray(writer, value, ancestors, depth, label);
    return;
  }
  writeRecord(writer, value as object, ancestors, depth, label);
}

class PayloadReader {
  #bytes: ByteView;
  #view: DataView;
  #offset: number;
  readonly #end: number;

  constructor(bytes: ByteView, offset: number, end: number) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.#offset = offset;
    this.#end = end;
  }

  get offset(): number {
    return this.#offset;
  }

  #require(byteLength: number, label: string): void {
    if (
      !Number.isSafeInteger(byteLength) ||
      byteLength < 0 ||
      byteLength > this.#end - this.#offset
    )
      invalid(`${label} is truncated`);
  }

  readU8(label: string): number {
    this.#require(1, label);
    return this.#bytes[this.#offset++]!;
  }

  readU32(label: string): number {
    this.#require(4, label);
    const value = this.#view.getUint32(this.#offset, true);
    this.#offset += 4;
    return value;
  }

  readF64(label: string): number {
    this.#require(8, label);
    const value = this.#view.getFloat64(this.#offset, true);
    this.#offset += 8;
    if (!Number.isFinite(value)) invalid(`${label} is not finite`);
    return value;
  }

  readOwnedBytes(byteLength: number, label: string): OwnedBytes {
    this.#require(byteLength, label);
    const copy = allocateBytes(byteLength, label);
    copy.set(this.#bytes.subarray(this.#offset, this.#offset + byteLength));
    this.#offset += byteLength;
    return copy;
  }

  readString(label: string): string {
    const byteLength = this.readU32(`${label} byte length`);
    const bytes = this.readOwnedBytes(byteLength, label);
    try {
      return decode_linux_bytes(bytes);
    } catch (error) {
      rethrowCodecError(error, label);
    }
  }

  readBigInt(label: string): bigint {
    const sign = this.readU8(`${label} sign`);
    if (sign > 1) invalid(`${label} has an invalid sign`);
    const byteLength = this.readU32(`${label} byte length`);
    this.#require(byteLength, label);
    if (byteLength === 0) {
      if (sign !== 0) invalid(`${label} uses a non-canonical negative zero`);
      return 0n;
    }
    if (this.#bytes[this.#offset] === 0) invalid(`${label} has a non-canonical leading zero`);
    let magnitude = 0n;
    for (let index = 0; index < byteLength; index++) {
      magnitude = (magnitude << 8n) | BigInt(this.#bytes[this.#offset++]!);
    }
    return sign === 1 ? -magnitude : magnitude;
  }

  readValue(depth: number, label: string): unknown {
    if (depth > MAX_DEPTH) invalid(`${label} exceeds the maximum nesting depth`);
    const tag = this.readU8(`${label} type tag`);
    switch (tag) {
      case TAG_NULL:
        return null;
      case TAG_FALSE:
        return false;
      case TAG_TRUE:
        return true;
      case TAG_NUMBER:
        return this.readF64(label);
      case TAG_BIGINT:
        return this.readBigInt(label);
      case TAG_STRING:
        return this.readString(label);
      case TAG_BYTES: {
        const length = this.readU32(`${label} byte length`);
        return this.readOwnedBytes(length, label);
      }
      case TAG_ARRAY: {
        const length = this.readU32(`${label} length`);
        if (length > this.#end - this.#offset)
          invalid(`${label} length exceeds the remaining payload`);
        const result = new Array<unknown>(length);
        for (let index = 0; index < length; index++)
          result[index] = this.readValue(depth + 1, `${label}[${index}]`);
        return result;
      }
      case TAG_RECORD: {
        const length = this.readU32(`${label} property count`);
        if (length > Math.floor((this.#end - this.#offset) / 5))
          invalid(`${label} property count exceeds the remaining payload`);
        const result: Record<string, unknown> = Object.create(null);
        const seen = new Set<string>();
        for (let index = 0; index < length; index++) {
          const key = this.readString(`${label} property key`);
          if (seen.has(key)) invalid(`${label} contains a duplicate property key`);
          seen.add(key);
          Object.defineProperty(result, key, {
            value: this.readValue(depth + 1, `${label}.${key}`),
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        return result;
      }
      default:
        invalid(`${label} has an unknown type tag`);
    }
  }
}

/** Encode publication data for internal Worker transport. */
export function encode_dylink_worker_publication(
  input: DylinkWorkerPublication,
): Uint8Array<ArrayBuffer> {
  try {
    const writer = new PayloadWriter();
    writeValue(writer, input, new Set(), 0, "publication");
    return writer.finish();
  } catch (error) {
    rethrowCodecError(error, "publication encoding");
  }
}

/**
 * Decode owned publication data; graph and ABI validation remains the apply path's responsibility.
 * When `bytes` views shared memory, the caller must keep its contents frozen for this synchronous read.
 */
export function decode_dylink_worker_publication(bytes: Uint8Array): unknown {
  try {
    const view = byteView(bytes, "publication wire");
    if (view.byteLength < HEADER_BYTES) invalid("publication wire header is truncated");
    if (view.byteLength > MAX_WIRE_BYTES)
      invalid("publication wire exceeds the transport size limit");
    for (let index = 0; index < MAGIC.length; index++) {
      if (view[index] !== MAGIC[index]) invalid("publication wire magic is invalid");
    }
    const header = new DataView(view.buffer, view.byteOffset, view.byteLength);
    const version = header.getUint32(4, true);
    if (version !== VERSION) unsupported("publication wire version is unsupported");
    const payloadLength = header.getUint32(8, true);
    if (payloadLength > MAX_PAYLOAD_BYTES || payloadLength !== view.byteLength - HEADER_BYTES)
      invalid("publication wire payload length is invalid");
    const reader = new PayloadReader(view, HEADER_BYTES, view.byteLength);
    const result = reader.readValue(0, "publication");
    if (reader.offset !== view.byteLength) invalid("publication wire has trailing bytes");
    return result;
  } catch (error) {
    rethrowCodecError(error, "publication decoding");
  }
}
