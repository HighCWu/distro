// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const { read_wasm_dynamic_imports, read_wasm_dylink } = await import(
  pathToFileURL(process.argv[2]).href
);
const directory = process.argv[3];
for (const width of [32, 64]) {
  const word = (number) => (width === 64 ? BigInt(number) : number);
  const memory = new WebAssembly.Memory({
    initial: word(4),
    maximum: word(256),
    shared: true,
    address: width === 64 ? "i64" : "i32",
  });
  const main = new WebAssembly.Instance(
    new WebAssembly.Module(readFileSync(join(directory, `wasm${width}-main.wasm`))),
    { env: { memory } },
  );
  const table = main.exports.__indirect_function_table;
  const sideBytes = readFileSync(join(directory, `wasm${width}-side.wasm`));
  const sideModule = new WebAssembly.Module(sideBytes);
  assert.ok(read_wasm_dylink(sideModule));
  const imports = read_wasm_dynamic_imports(sideBytes);
  assert.ok(imports.some((entry) => entry.name === "shared_add" && entry.kind === "function"));
  assert.ok(imports.some((entry) => entry.name === "shared_value" && entry.module === "GOT.mem"));
  assert.ok(!WebAssembly.Module.exports(sideModule).some((entry) => entry.name === "_start"));
  // The main did not take shared_add's address; publish one canonical slot.
  const tableType = imports.find((entry) => entry.kind === "table");
  const tableBaseType = imports.find((entry) => entry.name === "__table_base").value;
  const index = table.grow(tableType.address === "i64" ? 1n : 1);
  table.set(index, main.exports.shared_add);
  const tableBase = Number(table.length);
  table.grow(tableType.address === "i64" ? 16n : 16);
  const bindings = {
    env: {
      memory,
      __indirect_function_table: table,
      __stack_pointer: main.exports.__stack_pointer,
      __memory_base: new WebAssembly.Global({ value: width === 64 ? "i64" : "i32" }, word(131072)),
      __table_base: new WebAssembly.Global(
        { value: tableBaseType },
        tableBaseType === "i64" ? BigInt(tableBase) : tableBase,
      ),
      __table_base32: new WebAssembly.Global({ value: "i32" }, tableBase),
      shared_add: main.exports.shared_add,
    },
    "GOT.mem": {
      shared_value: new WebAssembly.Global(
        { value: width === 64 ? "i64" : "i32", mutable: true },
        main.exports.shared_value.value,
      ),
    },
    "GOT.func": {
      shared_add: new WebAssembly.Global(
        { value: width === 64 ? "i64" : "i32", mutable: true },
        width === 64 ? BigInt(index) : Number(index),
      ),
    },
  };
  const side = new WebAssembly.Instance(sideModule, bindings);
  side.exports.__wasm_apply_data_relocs?.();
  side.exports.__wasm_call_ctors?.();
  assert.equal(side.exports.library_call(3), 15);
  assert.equal(side.exports.library_pointer(), word(Number(index)));
  console.log(
    `shared driver wasm${width}: engine calls, main data and function pointers pass; not Linux process acceptance`,
  );
}
