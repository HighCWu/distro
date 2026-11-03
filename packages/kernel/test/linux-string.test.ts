// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { decode_linux_bytes, encode_linux_string } from "../src/linux-string.ts";

test("Linux strings retain Unicode, leading BOMs and complete surrogate pairs", () => {
  for (const text of ["", "plain/path", "中文/é/😀", "\ufeffname.so", "😀\udcff🦀"]) {
    assert.equal(decode_linux_bytes(encode_linux_string(text)), text);
  }
  assert.deepEqual(encode_linux_string("\ufeffname"), new TextEncoder().encode("\ufeffname"));
  assert.equal(decode_linux_bytes(Uint8Array.of(0xef, 0xbb, 0xbf)), "\ufeff");
});

test("all byte pairs round trip without replacement aliases, including malformed UTF-8", () => {
  for (let first = 0; first < 256; first++) {
    for (let second = 0; second < 256; second++) {
      const bytes = Uint8Array.of(first, second);
      assert.deepEqual(encode_linux_string(decode_linux_bytes(bytes)), bytes);
    }
  }
  for (const bytes of [
    [0xe0, 0x80, 0x80],
    [0xed, 0xa0, 0x80],
    [0xf0, 0x80, 0x80, 0x80],
    [0xf4, 0x90, 0x80, 0x80],
    [0xef, 0xbb, 0xbf, 0xff],
    [0xf0, 0x9f, 0x98],
  ]) {
    const input = new Uint8Array(bytes);
    assert.deepEqual(encode_linux_string(decode_linux_bytes(input)), input);
  }
  assert.notEqual(decode_linux_bytes(Uint8Array.of(0xff)), "\ufffd");
  assert.notEqual(decode_linux_bytes(Uint8Array.of(0xff)), decode_linux_bytes(Uint8Array.of(0xfe)));
});

test("Linux byte decoding snapshots shared views before reaching a browser decoder", () => {
  const NativeDecoder = globalThis.TextDecoder;
  class BrowserDecoder extends NativeDecoder {
    override decode(input?: AllowSharedBufferSource, options?: TextDecodeOptions): string {
      assert(!(input instanceof SharedArrayBuffer));
      if (ArrayBuffer.isView(input)) assert(!(input.buffer instanceof SharedArrayBuffer));
      return super.decode(input, options);
    }
  }
  globalThis.TextDecoder = BrowserDecoder;
  try {
    const shared = new Uint8Array(new SharedArrayBuffer(5));
    shared.set([0xef, 0xbb, 0xbf, 0xff, 0x61]);
    const value = decode_linux_bytes(shared);
    shared.fill(0);
    assert.deepEqual(encode_linux_string(value), Uint8Array.of(0xef, 0xbb, 0xbf, 0xff, 0x61));
  } finally {
    globalThis.TextDecoder = NativeDecoder;
  }
});
