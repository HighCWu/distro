// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import {
  importNinepBrowserDirectorySnapshot,
  type NinepBrowserSnapshotDirectory,
  type NinepBrowserSnapshotEntry,
  type NinepBrowserSnapshotLimits,
} from "../src/virtio/ninep/directory-snapshot.ts";

// Type-only compatibility check; no browser API or picker is used in Node.
const nativeHandleImporter: (
  root: FileSystemDirectoryHandle,
  limits: NinepBrowserSnapshotLimits,
) => ReturnType<typeof importNinepBrowserDirectorySnapshot> = importNinepBrowserDirectorySnapshot;
void nativeHandleImporter;

function directory(
  children: [string, NinepBrowserSnapshotEntry][],
): NinepBrowserSnapshotDirectory & NinepBrowserSnapshotEntry {
  return {
    kind: "directory",
    async *entries() {
      for (const child of children) yield child;
    },
  };
}

function file(
  bytes: string | Uint8Array<ArrayBuffer>,
  counts = { captures: 0, reads: 0 },
): NinepBrowserSnapshotEntry {
  const captured = new File([bytes], "fixture");
  const read = captured.arrayBuffer.bind(captured);
  captured.arrayBuffer = async () => {
    counts.reads++;
    return read();
  };
  return {
    kind: "file",
    async getFile() {
      counts.captures++;
      return captured;
    },
  };
}

test("browser directory snapshot preserves nested UTF-8 names, binary files and empty directories", async () => {
  const counts = { captures: 0, reads: 0 };
  const payload = new TextEncoder().encode("UTF-8 ✓\0");
  const binarySource = file(Uint8Array.of(0, 255, 128, 10), counts);
  const root = directory([
    ["binary.bin", binarySource],
    ["层级", directory([["α.txt", file(payload, counts)]])],
    ["empty", directory([])],
    ["back\\slash", file("b", counts)],
    [".hidden", file("h", counts)],
  ]);
  const fs = await importNinepBrowserDirectorySnapshot(root, {
    maxEntries: 7,
    maxBytes: payload.length + 6,
  });
  assert.deepEqual(fs.readFile("/binary.bin"), Uint8Array.of(0, 255, 128, 10));
  assert.deepEqual(fs.readFile("/层级/α.txt"), payload);
  assert.equal(fs.getattr("/empty").type, "dir");
  assert.deepEqual(fs.readdir("/empty"), []);
  assert.deepEqual(fs.readFile("/back\\slash"), new TextEncoder().encode("b"));
  assert.deepEqual(fs.readFile("/.hidden"), new TextEncoder().encode("h"));
  assert.deepEqual(counts, { captures: 4, reads: 4 });
  fs.writeFile("/binary.bin", "local snapshot write");
  assert.deepEqual(
    new Uint8Array(await (await binarySource.getFile!()).arrayBuffer()),
    Uint8Array.of(0, 255, 128, 10),
    "snapshot mutations do not write back to the selected directory",
  );
});

test("snapshot captures File objects once and checks all byte quotas before payload reads", async () => {
  let current = new File(["original"], "file");
  let captures = 0;
  const root = directory([
    [
      "file",
      {
        kind: "file",
        async getFile() {
          captures++;
          return current;
        },
      },
    ],
    [
      "empty",
      {
        kind: "directory",
        async *entries() {
          current = new File(["changed"], "file");
        },
      },
    ],
  ]);
  const fs = await importNinepBrowserDirectorySnapshot(root, { maxEntries: 3, maxBytes: 8 });
  assert.equal(new TextDecoder().decode(fs.readFile("/file")), "original");
  assert.equal(captures, 1);
  const counts = { captures: 0, reads: 0 };
  await assert.rejects(
    importNinepBrowserDirectorySnapshot(
      directory([
        ["first", file("abc", counts)],
        ["second", file("def", counts)],
      ]),
      { maxEntries: 3, maxBytes: 5 },
    ),
    /byte limit/,
  );
  assert.deepEqual(counts, { captures: 2, reads: 0 });
});

test("positive safe quotas count the root and prevent extra payload allocation", async () => {
  for (const value of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      importNinepBrowserDirectorySnapshot(directory([]), { maxEntries: value, maxBytes: 1 }),
      /positive safe/,
    );
    await assert.rejects(
      importNinepBrowserDirectorySnapshot(directory([]), { maxEntries: 1, maxBytes: value }),
      /positive safe/,
    );
  }
  const empty = await importNinepBrowserDirectorySnapshot(directory([]), {
    maxEntries: 1,
    maxBytes: 1,
  });
  assert.deepEqual(empty.readdir("/"), []);
  const counts = { captures: 0, reads: 0 };
  await assert.rejects(
    importNinepBrowserDirectorySnapshot(
      directory([
        ["empty", directory([])],
        ["file", file("x", counts)],
      ]),
      { maxEntries: 2, maxBytes: 1 },
    ),
    /entry limit/,
  );
  assert.deepEqual(counts, { captures: 0, reads: 0 });
  let read = false;
  await assert.rejects(
    importNinepBrowserDirectorySnapshot(
      directory([
        [
          "large",
          {
            kind: "file",
            async getFile() {
              return {
                size: Number.MAX_SAFE_INTEGER,
                async arrayBuffer() {
                  read = true;
                  return new ArrayBuffer(0);
                },
              };
            },
          },
        ],
      ]),
      { maxEntries: 2, maxBytes: 1 },
    ),
    /byte limit/,
  );
  assert.equal(read, false);
});

test("invalid and duplicate components are rejected before reading or capturing files", async () => {
  for (const name of ["", ".", "..", "a/b", "nul\0", "\ud800", "é".repeat(128)]) {
    const counts = { captures: 0, reads: 0 };
    await assert.rejects(
      importNinepBrowserDirectorySnapshot(directory([[name, file("x", counts)]]), {
        maxEntries: 2,
        maxBytes: 1,
      }),
      /invalid Linux filename/,
    );
    assert.deepEqual(counts, { captures: 0, reads: 0 });
  }
  const counts = { captures: 0, reads: 0 };
  await assert.rejects(
    importNinepBrowserDirectorySnapshot(
      directory([
        ["duplicate", file("a", counts)],
        ["duplicate", file("b", counts)],
      ]),
      { maxEntries: 3, maxBytes: 2 },
    ),
    /duplicate entry/,
  );
  assert.deepEqual(counts, { captures: 1, reads: 0 });
});

test("a payload inconsistent with its captured metadata cannot produce a snapshot", async () => {
  await assert.rejects(
    importNinepBrowserDirectorySnapshot(
      directory([
        [
          "file",
          {
            kind: "file",
            async getFile() {
              return {
                size: 1,
                async arrayBuffer() {
                  return new ArrayBuffer(2);
                },
              };
            },
          },
        ],
      ]),
      { maxEntries: 2, maxBytes: 1 },
    ),
    /does not match captured size/,
  );
});
