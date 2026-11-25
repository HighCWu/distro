// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import fs, { mkdtempSync, writeFileSync, readFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installDiskStorage } from "../src/disk-storage.ts";
import type { BlockDeviceStorage } from "@lowland/kernel";

function fake(overrides = {}) {
  const calls: unknown[] = [];
  return {
    calls,
    operations: {
      openSync(_path: string, flags: string) {
        calls.push(flags);
        return 7;
      },
      fstatSync() {
        return { size: 512 };
      },
      readSync(
        _file: number,
        _target: Uint8Array,
        offset: number,
        length: number,
        position: number,
      ) {
        calls.push(["read", offset, length, position]);
        return Math.min(2, length);
      },
      writeSync(
        _file: number,
        _data: Uint8Array,
        offset: number,
        length: number,
        position: number,
      ) {
        calls.push(["write", offset, length, position]);
        return Math.min(2, length);
      },
      fsyncSync(file: number) {
        calls.push(["sync", file]);
      },
      closeSync(file: number) {
        calls.push(["close", file]);
      },
      ...overrides,
    },
  };
}

test("disk storage releases its descriptor when stat or installation fails", () => {
  for (const statFails of [false, true]) {
    const reason = new Error("initialization failed");
    const { operations, calls } = fake(
      statFails
        ? {
            fstatSync() {
              throw reason;
            },
          }
        : {},
    );
    assert.throws(
      () =>
        installDiskStorage(
          "disk",
          () => {
            throw reason;
          },
          false,
          operations,
        ),
      (error) => error === reason,
    );
    assert.deepEqual(calls, ["r+", ["close", 7]]);
  }
});

test("disk initialization preserves the primary failure if close also fails", () => {
  const reason = new Error("invalid capacity");
  let closed = 0;
  const { operations } = fake({
    closeSync() {
      closed++;
      throw new Error("close failed");
    },
  });
  assert.throws(
    () =>
      installDiskStorage(
        "disk",
        () => {
          throw reason;
        },
        false,
        operations,
      ),
    (error) => error === reason,
  );
  assert.equal(closed, 1);
});

test("disk storage completes short host I/O and stops at zero progress", () => {
  const { operations, calls } = fake();
  let storage!: BlockDeviceStorage;
  installDiskStorage(
    "disk",
    (value) => {
      storage = value;
    },
    false,
    operations,
  );
  assert.equal(storage.read(100, new Uint8Array(5)), 5);
  assert.equal(storage.write!(200, new Uint8Array(3)), 3);
  assert.deepEqual(calls, [
    "r+",
    ["read", 0, 5, 100],
    ["read", 2, 3, 102],
    ["read", 4, 1, 104],
    ["write", 0, 3, 200],
    ["write", 2, 1, 202],
  ]);
  operations.readSync = () => 0;
  operations.writeSync = () => 0;
  assert.equal(storage.read(0, new Uint8Array(1)), 0);
  assert.equal(storage.write!(0, new Uint8Array(1)), 0);
  storage.close!();
});

test("disk zeroing completes partial writes and rejects short completion", () => {
  const { operations, calls } = fake();
  let storage!: BlockDeviceStorage;
  installDiskStorage(
    "disk",
    (value) => {
      storage = value;
    },
    false,
    operations,
  );
  assert.equal(storage.writeZeroes!(100, 5), undefined);
  assert.deepEqual(calls, ["r+", ["write", 0, 5, 100], ["write", 2, 3, 102], ["write", 4, 1, 104]]);

  assert.throws(() => storage.writeZeroes!(510, 5), /exceeds capacity/);
  assert.equal(calls.length, 4, "out-of-range zeroing must not write to the file");
  operations.writeSync = () => 0;
  assert.throws(() => storage.writeZeroes!(100, 5), /could not write the complete/);
  storage.close!();
});

test("read-only disk fallback omits write, zeroing and flush and closes without fsync", () => {
  const { operations, calls } = fake();
  operations.openSync = (_path, flags) => {
    calls.push(flags);
    if (flags === "r+") throw new Error("read-only");
    return 7;
  };
  installDiskStorage(
    "disk",
    (storage) => {
      assert.equal(storage.write, undefined);
      assert.equal(storage.writeZeroes, undefined);
      assert.equal(storage.flush, undefined);
      storage.close!();
    },
    false,
    operations,
  );
  assert.deepEqual(calls, ["r+", "r", ["close", 7]]);
});

test("explicit read-only opens a writable file without write access", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "linux-wasm-disk-ro-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "writable.img");
  const original = new Uint8Array(512).fill(0x5a);
  writeFileSync(path, original);
  const writable = fs.openSync(path, "r+");
  fs.closeSync(writable);

  const opens: string[] = [];
  let descriptor!: number;
  let closes = 0;
  let storage!: BlockDeviceStorage;
  installDiskStorage(
    path,
    (value) => {
      storage = value;
    },
    true,
    {
      ...fs,
      openSync(path, flags) {
        opens.push(flags);
        descriptor = fs.openSync(path, flags);
        return descriptor;
      },
      fsyncSync() {
        assert.fail("read-only disk must not sync");
      },
      closeSync(file) {
        closes++;
        fs.closeSync(file);
      },
    },
  );
  try {
    assert.deepEqual(opens, ["r"]);
    const bytes = new Uint8Array(512);
    assert.equal(await storage.read(0, bytes), bytes.length);
    assert.deepEqual(bytes, original);
    assert.equal(storage.write, undefined);
    assert.equal(storage.writeZeroes, undefined);
    assert.equal(storage.flush, undefined);
    assert.throws(() => fs.writeSync(descriptor, Uint8Array.of(0), 0, 1, 0), { code: "EBADF" });
  } finally {
    await storage.close!();
  }
  assert.equal(closes, 1);
  assert.deepEqual(new Uint8Array(readFileSync(path)), original);
});

test("disk close always releases the descriptor and preserves a failed fsync", () => {
  const reason = new Error("sync failed");
  let closed = 0;
  const { operations } = fake({
    fsyncSync() {
      throw reason;
    },
    closeSync() {
      closed++;
      throw new Error("close failed");
    },
  });
  let storage!: BlockDeviceStorage;
  installDiskStorage(
    "disk",
    (value) => {
      storage = value;
    },
    false,
    operations,
  );
  assert.throws(
    () => storage.flush!(),
    (error) => error === reason,
  );
  assert.throws(
    () => storage.close!(),
    (error) => error === reason,
  );
  assert.equal(closed, 1);
});

test("disk zeroing preserves bytes before and after a multi-chunk range", async () => {
  const directory = mkdtempSync(join(tmpdir(), "linux-wasm-disk-zero-"));
  const path = join(directory, "root.img");
  const original = new Uint8Array(160 * 1024).fill(0x7b);
  const expected = original.slice();
  const offset = 512;
  const length = 130 * 1024;
  expected.fill(0, offset, offset + length);
  let storage: BlockDeviceStorage | undefined;
  try {
    writeFileSync(path, original);
    installDiskStorage(path, (value) => {
      storage = value;
    });
    await storage!.writeZeroes!(offset, length);
    await storage!.close!();
    storage = undefined;
    assert.deepEqual(new Uint8Array(readFileSync(path)), expected);
  } finally {
    await storage?.close?.();
    unlinkSync(path);
    rmdirSync(directory);
  }
});

test("disk storage persists actual file bytes across descriptor reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "linux-wasm-disk-"));
  const path = join(directory, "root.img");
  let storage: BlockDeviceStorage | undefined;
  try {
    writeFileSync(path, new Uint8Array(1024));
    installDiskStorage(path, (value) => {
      storage = value;
    });
    assert.equal(storage!.capacity, 1024);
    assert.equal(await storage!.write!(512, Uint8Array.of(7, 8, 9)), 3);
    await storage!.flush!();
    await storage!.close!();
    storage = undefined;
    assert.deepEqual(new Uint8Array(readFileSync(path).subarray(512, 515)), Uint8Array.of(7, 8, 9));
    installDiskStorage(path, (value) => {
      storage = value;
    });
    const target = new Uint8Array(3);
    assert.equal(await storage!.read(512, target), 3);
    assert.deepEqual(target, Uint8Array.of(7, 8, 9));
  } finally {
    await storage?.close?.();
    unlinkSync(path);
    rmdirSync(directory);
  }
});
