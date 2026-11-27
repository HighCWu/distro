// SPDX-License-Identifier: MIT

import { getMachinePlugin, type MachinePlugin, type MachinePluginProvider } from "./plugin.ts";
import { assert } from "./util.ts";
import {
  ensure_memory_buffer,
  type Imports,
  type WasmAddress,
  wasm_address_to_number,
} from "./wasm.ts";

/** Geometry and linear-memory location registered by `fbdev_wasm`. */
export interface FramebufferInfo {
  fbAddr: number;
  width: number;
  height: number;
  stride: number;
  bpp: number;
  byteLength: number;
}

/** Dirty rectangle reported by `fb.flush`. */
export interface FramebufferRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Read-only host view over a registered guest/kernel framebuffer. */
export interface FramebufferState {
  readonly info: FramebufferInfo | undefined;
  /**
   * Returns a fresh copy of the linear-memory pixel buffer, refreshing the
   * shared `ArrayBuffer` view if `WebAssembly.Memory` has grown.
   */
  readPixels(): Uint8Array | undefined;
}

/** Callbacks for {@link framebufferPlugin} and {@link createFramebuffer}. */
export interface FramebufferOptions {
  onRegister?: (info: FramebufferInfo, state: FramebufferState) => void;
  onFlush?: (rect: FramebufferRect, state: FramebufferState) => void;
}

/** A {@link MachinePluginProvider} that exposes live framebuffer state. */
export interface FramebufferPlugin extends MachinePluginProvider, FramebufferState {}

const attachFramebuffer = Symbol("attachFramebuffer");

interface InternalFramebufferPlugin extends FramebufferPlugin {
  [attachFramebuffer](memory: WebAssembly.Memory): Imports["fb"];
}

/** Creates a standalone framebuffer state and `fb` Wasm import table for `memory`. */
export function createFramebuffer(
  memory: WebAssembly.Memory,
  options: FramebufferOptions = {},
): { state: FramebufferState; imports: Imports["fb"] } {
  let currentInfo: FramebufferInfo | undefined;

  const state: FramebufferState = {
    get info() {
      return currentInfo;
    },
    readPixels() {
      if (!currentInfo) return undefined;
      const end = currentInfo.fbAddr + currentInfo.byteLength;
      ensure_memory_buffer(memory, end);
      return new Uint8Array(memory.buffer, currentInfo.fbAddr, currentInfo.byteLength).slice();
    },
  };

  const imports: Imports["fb"] = {
    register(fb_addr: WasmAddress, width: number, height: number, stride: number, bpp: number) {
      const addr = wasm_address_to_number(fb_addr);
      const w = width >>> 0;
      const h = height >>> 0;
      const s = stride >>> 0;
      const b = bpp >>> 0;
      const byteLength = s * h;
      assert(Number.isSafeInteger(addr) && addr >= 0, "invalid framebuffer address");
      assert(Number.isSafeInteger(byteLength) && byteLength > 0, "invalid framebuffer size");
      ensure_memory_buffer(memory, addr + byteLength);
      currentInfo = {
        fbAddr: addr,
        width: w,
        height: h,
        stride: s,
        bpp: b,
        byteLength,
      };
      options.onRegister?.(currentInfo, state);
    },
    flush(x: number, y: number, width: number, height: number) {
      if (!currentInfo) return;
      options.onFlush?.(
        {
          x: x >>> 0,
          y: y >>> 0,
          width: width >>> 0,
          height: height >>> 0,
        },
        state,
      );
    },
  };

  return { state, imports };
}

/** Creates a machine plugin that receives `wasmfb` registration and flush events. */
export function framebufferPlugin(options: FramebufferOptions = {}): FramebufferPlugin {
  let bound: { state: FramebufferState; imports: Imports["fb"] } | undefined;
  const plugin: MachinePlugin = {
    configure() {},
  };
  const provider: InternalFramebufferPlugin = {
    [getMachinePlugin]() {
      return plugin;
    },
    [attachFramebuffer](memory: WebAssembly.Memory) {
      assert(!bound, "framebufferPlugin is already attached to a machine");
      bound = createFramebuffer(memory, options);
      return bound.imports;
    },
    get info() {
      return bound?.state.info;
    },
    readPixels() {
      return bound?.state.readPixels();
    },
  };
  return provider;
}

export function attach_framebuffer_plugins(
  memory: WebAssembly.Memory,
  plugins: readonly unknown[],
): Imports["fb"] {
  const fbPlugins = plugins.filter(
    (entry): entry is InternalFramebufferPlugin =>
      typeof entry === "object" && entry !== null && attachFramebuffer in entry,
  );
  assert(fbPlugins.length <= 1, "at most one framebufferPlugin may be attached per machine");
  if (fbPlugins.length === 1) {
    return fbPlugins[0]![attachFramebuffer](memory);
  }
  return createFramebuffer(memory).imports;
}
