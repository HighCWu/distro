// SPDX-License-Identifier: MIT
// A standard shared memory64 module with one page and a one-page maximum.
// Instantiation checks the engine, not a user-agent string or an ignored JS option.
const probe = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x05, 0x04, 0x01, 0x07, 0x01, 0x01, 0x07, 0x0a,
  0x01, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00,
]);

export function assertBrowserSupport({
  isolated = globalThis.crossOriginIsolated,
  wasm = globalThis.WebAssembly,
  sharedArrayBuffer = globalThis.SharedArrayBuffer,
} = {}) {
  if (!isolated) throw new Error("COOP/COEP cross-origin isolation is required");
  if (typeof sharedArrayBuffer !== "function")
    throw new Error("SharedArrayBuffer is required for shared Linux memory");
  if (!wasm || !wasm.validate(probe))
    throw new Error("WebAssembly shared memory64 support is required; no wasm32 fallback is used");
  try {
    const memory = new wasm.Instance(new wasm.Module(probe)).exports.memory;
    if (!(memory.buffer instanceof sharedArrayBuffer) || memory.grow(0n) !== 1n)
      throw new Error("engine did not provide shared memory64");
  } catch (cause) {
    throw new Error("Unable to allocate the shared memory64 capability probe", { cause });
  }
  // This proves only a 64 KiB allocation, not enough resources for Linux boot.
}
