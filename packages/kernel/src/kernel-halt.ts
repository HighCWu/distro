// SPDX-License-Identifier: MIT

export function create_wasm_halt(): WebAssembly.RuntimeError {
  // (module (func (export "stop") unreachable))
  const module = new WebAssembly.Module(
    new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00, 0x00, 0x03,
      0x02, 0x01, 0x00, 0x07, 0x08, 0x01, 0x04, 0x73, 0x74, 0x6f, 0x70, 0x00, 0x00, 0x0a, 0x05,
      0x01, 0x03, 0x00, 0x00, 0x0b,
    ]),
  );
  const stop = new WebAssembly.Instance(module).exports.stop as () => never;
  try {
    stop();
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) return error;
    throw error;
  }
  throw new Error("kernel halt instruction returned");
}

// A plain JS exception can enter application catch/cleanup handlers. Preserve
// an actual engine trap so task exit skips user unwinding, including in a
// browser Worker where close() lets the current synchronous call continue.
export const HALT_KERNEL = create_wasm_halt();
