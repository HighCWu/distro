// SPDX-License-Identifier: MIT

export async function compile_web_wasm(response: Response): Promise<{
  bytes: Uint8Array<ArrayBuffer>;
  module: WebAssembly.Module;
}> {
  if (!response.ok) {
    throw new Error(`kernel Wasm request failed: HTTP ${response.status} ${response.statusText}`);
  }
  if (response.headers.get("Content-Type") === "application/wasm") {
    // Consume both branches concurrently rather than buffering the unused tee
    // while compilation runs. Streaming preserves the browser's native cache.
    const [module, buffer] = await Promise.all([
      WebAssembly.compileStreaming(response.clone()),
      response.arrayBuffer(),
    ]);
    return { module, bytes: new Uint8Array(buffer) };
  }
  // Some otherwise usable static hosts cannot configure a Wasm MIME type.
  // Choose this path before compiling; never retry an actual compilation error.
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { bytes, module: await WebAssembly.compile(bytes) };
}
