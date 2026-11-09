// SPDX-License-Identifier: MIT

const compiledWrappers = new WeakMap<WebAssembly.Global, Map<string, WebAssembly.Module>>();

/** Preserve native Wasm arguments/results while installing the calling DSO.
 * EH restores the previous owner before propagating an exception unchanged.
 * Engine traps belong to the host's fatal-execution boundary.
 */
export function create_dylink_call_wrapper(
  signature: string,
  target: CallableFunction,
  context: WebAssembly.Global,
  owner: number,
): CallableFunction {
  const shape: unknown = JSON.parse(signature);
  const numeric = (value: unknown): value is number[] =>
    Array.isArray(value) &&
    value.every((type) => Number.isInteger(type) && type >= 0x7b && type <= 0x7f);
  if (!Array.isArray(shape) || shape.length !== 2 || !numeric(shape[0]) || !numeric(shape[1]))
    throw new TypeError("unsupported dynamic calling signature");
  if (!Number.isInteger(owner) || owner < 0 || owner > 0xffffffff)
    throw new TypeError("dynamic caller owner exceeds i32");
  const key = `${owner}:${signature}`;
  let cache = compiledWrappers.get(context);
  let compiled = cache?.get(key);
  if (!compiled) {
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
    const signed = (value: number) => {
      const bytes: number[] = [];
      for (;;) {
        const byte = value & 0x7f;
        value >>= 7;
        const done = (value === 0 && !(byte & 0x40)) || (value === -1 && !!(byte & 0x40));
        bytes.push(byte | (done ? 0 : 0x80));
        if (done) return bytes;
      }
    };
    const string = (value: string) => {
      const bytes = [...new TextEncoder().encode(value)];
      return [...leb(bytes.length), ...bytes];
    };
    const section = (id: number, bytes: number[]) => [id, ...leb(bytes.length), ...bytes];
    const restore = [0x20, ...leb(parameters.length), 0x24, 0];
    const body = [
      1,
      1,
      0x7f, // One i32 local preserves the previous owner.
      0x23,
      0, // global.get context
      0x21,
      ...leb(parameters.length),
      0x41,
      ...signed(owner | 0),
      0x24,
      0, // global.set context
      0x06,
      1, // try with type 1: no block parameters, original results
      ...parameters.flatMap((_, index) => [0x20, ...leb(index)]),
      0x10,
      0, // call target
      ...restore,
      0x19, // catch_all
      ...restore,
      0x09,
      0, // rethrow the caught exception
      0x0b,
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
        2,
        0x60,
        ...leb(parameters.length),
        ...parameters,
        ...leb(results.length),
        ...results,
        0x60,
        0,
        ...leb(results.length),
        ...results,
      ]),
      ...section(2, [
        2,
        ...string("env"),
        ...string("target"),
        0,
        0,
        ...string("env"),
        ...string("context"),
        3,
        0x7f,
        1,
      ]),
      ...section(3, [1, 0]),
      ...section(7, [1, ...string("call"), 0, 1]),
      ...section(10, [1, ...leb(body.length), ...body]),
    ]);
    compiled = new WebAssembly.Module(bytes);
    if (!cache) {
      cache = new Map();
      compiledWrappers.set(context, cache);
    }
    cache.set(key, compiled);
  }
  const instance = new WebAssembly.Instance(compiled, {
    env: { target, context },
  });
  return instance.exports.call as CallableFunction;
}
