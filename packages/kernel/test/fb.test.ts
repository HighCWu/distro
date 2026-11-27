// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import {
  attach_framebuffer_plugins,
  createFramebuffer,
  framebufferPlugin,
  type FramebufferInfo,
  type FramebufferRect,
} from "../src/framebuffer.ts";

test("createFramebuffer registers geometry, invokes flush, and refreshes after memory.grow", () => {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 8, shared: true });
  let registered: FramebufferInfo | undefined;
  const flushes: FramebufferRect[] = [];

  const { state, imports } = createFramebuffer(memory, {
    onRegister(info) {
      registered = info;
    },
    onFlush(rect) {
      flushes.push(rect);
    },
  });

  // Allocate a 4x2 XRGB8888 framebuffer starting in page 2 (after memory.grow).
  const fbAddr = 2 * 65536;
  const width = 4;
  const height = 2;
  const stride = width * 4;
  const oldBuffer = memory.buffer;

  memory.grow(2);
  // Simulate a stale detached-length SharedArrayBuffer view held before grow().
  assert.equal(oldBuffer.byteLength, 2 * 65536);

  imports.register(fbAddr, width, height, stride, 32);
  assert.deepEqual(registered, {
    fbAddr,
    width,
    height,
    stride,
    bpp: 32,
    byteLength: stride * height,
  });
  assert.deepEqual(state.info, registered);

  const liveBytes = new Uint8Array(memory.buffer, fbAddr, stride * height);
  liveBytes.set([
    0x11, 0x22, 0x33, 0xff, 0x44, 0x55, 0x66, 0xff, 0x77, 0x88, 0x99, 0xff, 0xaa, 0xbb, 0xcc, 0xff,
    0x01, 0x02, 0x03, 0xff, 0x04, 0x05, 0x06, 0xff, 0x07, 0x08, 0x09, 0xff, 0x0a, 0x0b, 0x0c, 0xff,
  ]);

  imports.flush(0, 0, width, height);
  assert.deepEqual(flushes, [{ x: 0, y: 0, width, height }]);

  const pixels = state.readPixels();
  assert.ok(pixels);
  assert.equal(pixels.byteLength, stride * height);
  assert.equal(pixels[0], 0x11);
  assert.equal(pixels[31], 0xff);

  // Grow again after registration and verify readPixels still refreshes cleanly.
  memory.grow(1);
  new Uint8Array(memory.buffer, fbAddr, 4).set([0xde, 0xad, 0xbe, 0xef]);
  const refreshed = state.readPixels();
  assert.ok(refreshed);
  assert.deepEqual(Array.from(refreshed.subarray(0, 4)), [0xde, 0xad, 0xbe, 0xef]);
});

test("framebufferPlugin attaches to a machine memory and exposes live pixels", () => {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 4, shared: true });
  const events: string[] = [];
  const fb = framebufferPlugin({
    onRegister(info) {
      events.push(`register:${info.width}x${info.height}x${info.bpp}`);
    },
    onFlush(rect, state) {
      const pixels = state.readPixels();
      events.push(`flush:${rect.x},${rect.y},${rect.width}x${rect.height}:${pixels?.[0]}`);
    },
  });

  const readInfo = () => fb.info;
  assert.equal(fb.readPixels(), undefined);
  assert.equal(readInfo(), undefined);

  const imports = attach_framebuffer_plugins(memory, [fb]);
  const fbAddr = 4096;
  new Uint8Array(memory.buffer, fbAddr, 16).fill(0x5a);
  imports.register(fbAddr, 2, 2, 8, 32);
  imports.flush(0, 0, 2, 2);

  assert.deepEqual(events, ["register:2x2x32", "flush:0,0,2x2:90"]);
  assert.equal(readInfo()?.fbAddr, fbAddr);
  assert.equal(fb.readPixels()?.[15], 0x5a);
});

test("framebufferPlugin enforces single attachment and ignores flush before register", () => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
  let flushCount = 0;
  const { imports } = createFramebuffer(memory, {
    onFlush() {
      flushCount++;
    },
  });

  imports.flush(0, 0, 10, 10);
  assert.equal(flushCount, 0);
  assert.throws(() => imports.register(0, 10, 0, 40, 32), /invalid framebuffer size/);

  const fb1 = framebufferPlugin();
  const fb2 = framebufferPlugin();
  assert.throws(
    () => attach_framebuffer_plugins(memory, [fb1, fb2]),
    /at most one framebufferPlugin/,
  );

  attach_framebuffer_plugins(memory, [fb1]);
  assert.throws(() => attach_framebuffer_plugins(memory, [fb1]), /already attached/);
});
