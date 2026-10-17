// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { maximumDownloadBytes, prepareDownload } from "./download.js";

function harness({ bytes = new Uint8Array(), info, openedInfo, readError, closeError, read } = {}) {
  const calls = [];
  const metadata = info ?? { isFile: true, size: bytes.length };
  let offset = 0;
  const file = {
    async stat() {
      calls.push("fstat");
      return openedInfo ?? metadata;
    },
    async read(buffer) {
      calls.push("read");
      if (readError) throw readError;
      if (read) return read(buffer);
      if (offset === bytes.length) return null;
      const count = Math.min(buffer.length, bytes.length - offset);
      buffer.set(bytes.subarray(offset, offset + count));
      offset += count;
      return count;
    },
    async close() {
      calls.push("close");
      if (closeError) throw closeError;
    },
  };
  return {
    calls,
    fs: {
      async stat() {
        calls.push("stat");
        return metadata;
      },
      async open(path) {
        calls.push(["open", path]);
        return file;
      },
    },
  };
}

test("download preserves binary bytes across reused buffers and empty files", async () => {
  for (const length of [0, 65536 + 17, maximumDownloadBytes]) {
    const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + 11) & 255);
    const h = harness({ bytes });
    const result = await prepareDownload(h.fs, "/root/result.bin");
    assert.equal(result.name, "result.bin");
    assert.equal(result.blob.type, "application/octet-stream");
    assert.deepEqual(new Uint8Array(await result.blob.arrayBuffer()), bytes);
    assert.equal(h.calls.filter((call) => call === "close").length, 1);
  }
});

test("invalid paths and non-regular or oversized files reject before open", async () => {
  for (const path of ["relative", "", "/root/a\0b", null]) {
    const h = harness();
    await assert.rejects(prepareDownload(h.fs, path), /absolute/);
    assert.deepEqual(h.calls, []);
  }
  for (const info of [
    { isFile: false, size: 0 },
    { isFile: true, size: maximumDownloadBytes + 1 },
  ]) {
    const h = harness({ info });
    await assert.rejects(prepareDownload(h.fs, "/root/file"));
    assert.deepEqual(h.calls, ["stat"]);
  }
});

test("opened identity is checked and closed even after path metadata was acceptable", async () => {
  for (const openedInfo of [
    { isFile: false, size: 0 },
    { isFile: true, size: maximumDownloadBytes + 1 },
  ]) {
    const h = harness({ openedInfo });
    await assert.rejects(prepareDownload(h.fs, "/root/file"));
    assert.deepEqual(h.calls, ["stat", ["open", "/root/file"], "fstat", "close"]);
  }
});

test("growth past the cap rejects instead of producing a truncated download", async () => {
  const h = harness({
    read(buffer) {
      buffer.fill(3);
      return buffer.length;
    },
  });
  await assert.rejects(prepareDownload(h.fs, "/root/growing"), /16 MiB/);
  assert.equal(h.calls.at(-1), "close");
  assert.equal(h.calls.filter((call) => call === "read").length, maximumDownloadBytes / 32768 + 1);
});

test("read/close errors retain original failure and never return a partial blob", async () => {
  const readError = new Error("read failed"),
    closeError = new Error("close failed");
  const h = harness({ readError });
  await assert.rejects(prepareDownload(h.fs, "/root/file"), (error) => error === readError);
  assert.equal(h.calls.at(-1), "close");
  await assert.rejects(
    prepareDownload(harness({ closeError }).fs, "/root/file"),
    (error) => error === closeError,
  );
  await assert.rejects(
    prepareDownload(harness({ readError, closeError }).fs, "/root/file"),
    (error) => {
      assert.deepEqual(error.errors, [readError, closeError]);
      assert.equal(error.cause, readError);
      return true;
    },
  );
});
