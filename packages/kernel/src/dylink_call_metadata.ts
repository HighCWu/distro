// SPDX-License-Identifier: MIT
import { read_wasm_dynamic_signatures, WasmParseError } from "./wasm_binary.ts";

const names = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();
// Tag precedes globals. Data count precedes code, despite its larger ID.
const sectionOrder = new Map(
  [1, 2, 3, 4, 5, 13, 6, 7, 8, 9, 12, 10, 11].map((id, index) => [id, index]),
);

class Reader {
  offset: number;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly end: number;
  constructor(bytes: Uint8Array<ArrayBuffer>, offset: number, end: number) {
    this.bytes = bytes;
    this.offset = offset;
    this.end = end;
  }
  byte() {
    if (this.offset >= this.end) this.fail("unexpected end of metadata input");
    return this.bytes[this.offset++]!;
  }
  u32() {
    let value = 0;
    for (let index = 0; index < 5; index++) {
      const byte = this.byte();
      if (index === 4 && byte > 15) this.fail("u32 LEB128 overflows");
      value += (byte & 127) * 2 ** (index * 7);
      if (!(byte & 128)) return value;
    }
    return this.fail("u32 LEB128 is too long");
  }
  text() {
    const length = this.u32(),
      end = this.offset + length;
    if (end > this.end) this.fail("export name extends past its section");
    let result: string;
    try {
      result = names.decode(this.bytes.subarray(this.offset, end));
    } catch {
      return this.fail("export name is not valid UTF-8");
    }
    this.offset = end;
    return result;
  }
  fail(message: string): never {
    throw new WasmParseError(message, this.offset);
  }
}

function u32(value: number): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
    throw new WasmParseError("metadata length exceeds u32", 0);
  const result: number[] = [];
  do {
    const byte = value & 127;
    value >>>= 7;
    result.push(byte | (value ? 128 : 0));
  } while (value);
  return new Uint8Array(result);
}

function concatenate(parts: readonly Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  const length = parts.reduce((total, part) => total + part.length, 0);
  if (length > 0xffffffff) throw new WasmParseError("metadata input exceeds u32", 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/** Internal compiler input. Public admission and signatures are checked before
 * private function aliases are added. The aliases include imported functions;
 * callers must filter privateExports from all public symbol lookup scopes.
 */
export function prepare_dylink_call_metadata(
  bytes: Uint8Array,
  allowDefinedTable = false,
): {
  bytes: Uint8Array<ArrayBuffer>;
  functions: ReadonlyMap<string, { signature: string; imported: boolean }>;
  privateExports: ReadonlySet<string>;
} {
  const source = new Uint8Array(bytes);
  const signatures = read_wasm_dynamic_signatures(source, allowDefinedTable);
  const functions = new Map<string, { signature: string; imported: boolean }>();
  const privateExports = new Set<string>();
  const publicNames = new Set<string>();
  const input = new Reader(source, 8, source.length);
  let exportStart = source.length,
    exportEnd = source.length;
  let entries = source.subarray(0, 0),
    exportCount = 0;
  let lastOrder = -1;
  while (input.offset < input.end) {
    const start = input.offset,
      id = input.byte(),
      length = input.u32();
    const end = input.offset + length;
    if (end > input.end) input.fail("section extends past metadata input");
    if (id !== 0) {
      const order = sectionOrder.get(id) ?? input.fail("invalid section ID");
      if (order <= lastOrder) input.fail("invalid or duplicate section order");
      lastOrder = order;
      if (order > sectionOrder.get(7)! && exportStart === source.length) {
        exportStart = start;
        exportEnd = start;
      }
    }
    if (id === 7) {
      exportStart = start;
      exportEnd = end;
      const part = new Reader(source, input.offset, end);
      exportCount = part.u32();
      const entriesStart = part.offset;
      for (let index = 0; index < exportCount; index++) {
        const name = part.text();
        if (publicNames.has(name)) part.fail("duplicate export name");
        publicNames.add(name);
        if (part.byte() > 4) part.fail("invalid export kind");
        part.u32();
      }
      if (part.offset !== end) part.fail("trailing bytes in export section");
      entries = source.subarray(entriesStart, end);
    }
    input.offset = end;
  }
  if (!signatures.functions.length) return { bytes: source, functions, privateExports };
  const additions: Uint8Array<ArrayBuffer>[] = [];
  for (const [index, signature] of signatures.functions.entries()) {
    const base = `__wasm_private_call_${index}`;
    let name = base,
      suffix = 0;
    while (publicNames.has(name) || privateExports.has(name)) name = `${base}_${++suffix}`;
    privateExports.add(name);
    functions.set(name, { signature, imported: index < signatures.imports.length });
    const text = encoder.encode(name);
    additions.push(u32(text.length), text, new Uint8Array([0]), u32(index));
  }
  const payload = concatenate([u32(exportCount + functions.size), entries, ...additions]);
  const replacement = concatenate([new Uint8Array([7]), u32(payload.length), payload]);
  return {
    bytes: concatenate([source.subarray(0, exportStart), replacement, source.subarray(exportEnd)]),
    functions,
    privateExports,
  };
}
