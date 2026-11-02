// SPDX-License-Identifier: MIT

/** A typed Wasm-to-Wasm forward call. JS wrappers cannot transport v128 values.
 * The target remains the null table slot until its provider is instantiated.
 * The process loader owns the shared table and the eventual canonical slot.
 */
export function create_dylink_forwarder(
  signature: string,
  table: WebAssembly.Table,
  address: "i32" | "i64",
) {
  const shape: unknown = JSON.parse(signature);
  const numeric = (value: unknown): value is number[] =>
    Array.isArray(value) &&
    value.every((type) => Number.isInteger(type) && type >= 0x7b && type <= 0x7f);
  if (!Array.isArray(shape) || shape.length !== 2 || !numeric(shape[0]) || !numeric(shape[1]))
    throw new TypeError("unsupported dynamic forwarding signature");
  const [parameters, results] = shape as [number[], number[]];
  const leb = (value: number) => {
    const bytes: number[] = [];
    do {
      let byte = value & 0x7f;
      value = Math.floor(value / 128);
      if (value) byte |= 0x80;
      bytes.push(byte);
    } while (value);
    return bytes;
  };
  const string = (value: string) => {
    const bytes = [...new TextEncoder().encode(value)];
    return [...leb(bytes.length), ...bytes];
  };
  const section = (id: number, bytes: number[]) => [id, ...leb(bytes.length), ...bytes];
  const body = [
    0, // No locals beyond the incoming parameters.
    ...parameters.flatMap((_, index) => [0x20, ...leb(index)]),
    0x23,
    0, // global.get target
    0x11,
    0,
    0, // call_indirect type 0, table 0
    0x0b,
  ];
  const bytes = new Uint8Array([
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    ...section(1, [
      1,
      0x60,
      ...leb(parameters.length),
      ...parameters,
      ...leb(results.length),
      ...results,
    ]),
    ...section(2, [
      2,
      ...string("env"),
      ...string("table"),
      1,
      0x70,
      address === "i64" ? 4 : 0,
      0,
      ...string("env"),
      ...string("target"),
      3,
      address === "i64" ? 0x7e : 0x7f,
      1,
    ]),
    ...section(3, [1, 0]),
    ...section(7, [1, ...string("call"), 0, 0]),
    ...section(10, [1, ...leb(body.length), ...body]),
  ]);
  const target = new WebAssembly.Global(
    { value: address, mutable: true },
    address === "i64" ? 0n : 0,
  );
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
    env: { table, target },
  });
  return { call: instance.exports.call as CallableFunction, target };
}
