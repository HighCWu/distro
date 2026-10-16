// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import type { GuestSession, Lane } from "../src/conn.ts";
import {
  fstat64,
  fstatat64,
  ftruncate64,
  fsync,
  GuestFd,
  llseek,
  openat,
  mkdirat,
  unlinkat,
  renameat,
  symlinkat,
  readlinkat,
  fchmodat,
  fchownat,
  mount,
  umount2,
  read,
  write,
} from "../src/syscalls.ts";
import { Stat as Stat32 } from "../src/abi.ts";
import { Stat as Stat64 } from "../src/abi-wasm64.ts";
import { FsFile, statToInfo } from "../src/file.ts";

function fixture(abi: "wasm32" | "wasm64", ret = 0n, payload = new Uint8Array(), errno = 0) {
  const requests: Uint8Array[] = [];
  const session = {
    abi,
    async exchange<T>(operation: (lane: Lane) => Promise<T>): Promise<T> {
      let reads = 0;
      return operation({
        async write(bytes) {
          requests.push(bytes.slice());
        },
        async read(length) {
          if (reads++ === 0) {
            assert.equal(length, 12);
            const bytes = new Uint8Array(12);
            const view = new DataView(bytes.buffer);
            view.setBigInt64(0, ret, true);
            view.setUint32(8, errno, true);
            return bytes;
          }
          assert.equal(length, payload.byteLength);
          return payload;
        },
      });
    },
  } as GuestSession;
  return { session, requests, fd: new GuestFd(session, 42) };
}

function request(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    nr: view.getUint32(1, true),
    kinds: Array.from(bytes.subarray(5, 11)),
    values: Array.from({ length: 6 }, (_, i) => view.getBigUint64(11 + i * 8, true)),
  };
}

for (const abi of ["wasm32", "wasm64"] as const) {
  test(`${abi} embedded NUL never dispatches a C-string syscall or poisons later requests`, async () => {
    const f = fixture(abi);
    for (const path of ["\0suffix", "/tmp/keep\0suffix", "/tmp/keep\0"]) {
      const operations = {
        open: () => openat(f.session, path, 0, 0),
        stat: () => fstatat64(f.session, path, 0),
        mkdir: () => mkdirat(f.session, path, 0o700),
        unlink: () => unlinkat(f.session, path, 0),
        renameSource: () => renameat(f.session, path, "/destination"),
        renameDestination: () => renameat(f.session, "/source", path),
        symlinkTarget: () => symlinkat(f.session, path, "/link"),
        symlinkPath: () => symlinkat(f.session, "/target", path),
        readlink: () => readlinkat(f.session, path, 1),
        chmod: () => fchmodat(f.session, path, 0o600),
        chown: () => fchownat(f.session, path, 0, 0),
        mountSource: () => mount(f.session, path, "/mnt", "ext4", 0, null),
        mountTarget: () => mount(f.session, null, path, "tmpfs", 0, null),
        mountType: () => mount(f.session, null, "/mnt", path, 0, null),
        mountData: () => mount(f.session, null, "/mnt", "tmpfs", 0, path),
        unmount: () => umount2(f.session, path, 0),
      };
      for (const [name, operation] of Object.entries(operations)) {
        await assert.rejects(operation(), TypeError, name);
        assert.equal(f.requests.length, 0, name);
      }
    }
    const valid = "/tmp/中文 $HOME\n😀";
    const fd = await openat(f.session, valid, 0, 0);
    assert.equal(new TextDecoder().decode(f.requests[0]!.subarray(59)), valid + "\0");
    await fd.close();
    assert.equal(f.requests.length, 2);
  });

  for (const closeErrno of [0, 5]) {
    test(`${abi} closed fd never dispatches again, including failed close (${closeErrno})`, async () => {
      const f = fixture(abi, closeErrno ? -1n : 0n, new Uint8Array(), closeErrno);
      const closing = f.fd.close();
      const closed = closeErrno ? assert.rejects(closing, { code: "EIO" }) : closing;
      assert.equal(f.fd.close(), closing);
      for (const operation of [
        () => read(f.fd, 1),
        () => write(f.fd, Uint8Array.of(1)),
        () => fsync(f.fd),
        () => fstat64(f.fd),
        () => ftruncate64(f.fd, 1n),
        () => llseek(f.fd, 0n, 0),
      ])
        await assert.rejects(operation(), { code: "EBADF" });
      await closed;
      assert.equal(f.requests.length, 1);
      assert.equal(request(f.requests[0]!).nr, 57);
    });
  }
  const native = abi === "wasm64";
  test(`${abi} seek uses its native calling convention and preserves the full result`, async () => {
    const result = 9007199254740993n;
    const body = new Uint8Array(8);
    new DataView(body.buffer).setBigInt64(0, result, true);
    const f = fixture(abi, native ? result : 0n, native ? new Uint8Array() : body);
    assert.equal(await llseek(f.fd, -4294967298n, 2), result);
    const wire = request(f.requests[0]!);
    assert.equal(wire.nr, 62);
    assert.deepEqual(wire.kinds, native ? [0, 0, 0, 0, 0, 0] : [0, 0, 0, 2, 0, 0]);
    assert.deepEqual(
      wire.values,
      native
        ? [42n, 0xfffffffefffffffen, 2n, 0n, 0n, 0n]
        : [42n, 0xfffffffen, 0xfffffffen, 8n, 2n, 0n],
    );
  });

  test(`${abi} truncate preserves the length without using the other ABI's register pairing`, async () => {
    const f = fixture(abi);
    await ftruncate64(f.fd, 0x123456789abcdefn);
    const wire = request(f.requests[0]!);
    assert.equal(wire.nr, 46);
    assert.deepEqual(
      wire.values,
      native
        ? [42n, 0x123456789abcdefn, 0n, 0n, 0n, 0n]
        : [42n, 0x89abcdefn, 0x1234567n, 0n, 0n, 0n],
    );
  });

  for (const operation of ["descriptor", "path"] as const) {
    test(`${abi} ${operation} stat selects the correct buffer and signed time fields`, async () => {
      const storage = new Uint8Array(native ? 144 : 120);
      const payload = storage.subarray(8, storage.length - 8);
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      view.setBigUint64(8, 9007199254740993n, true);
      view.setBigInt64(48, 7n, true);
      if (native) {
        view.setBigInt64(88, 3000000000n, true);
        view.setBigUint64(96, 123456789n, true);
      } else {
        view.setInt32(80, -7, true);
        view.setUint32(84, 123456789, true);
      }
      const f = fixture(abi, 0n, payload);
      const stat =
        operation === "descriptor"
          ? await fstat64(f.fd)
          : await fstatat64(f.session, "/file", 0x100);
      assert.equal(stat.st_ino, 9007199254740993n);
      assert.equal(stat.st_mtime, native ? 3000000000n : -7);
      assert.equal(stat.st_mtime_nsec, native ? 123456789n : 123456789);
      const wire = request(f.requests[0]!);
      assert.equal(wire.nr, operation === "descriptor" ? 80 : 79);
      const size = native ? 128n : 104n;
      if (operation === "descriptor") {
        assert.deepEqual(wire.kinds, [0, 2, 0, 0, 0, 0]);
        assert.deepEqual(wire.values, [42n, size, 0n, 0n, 0n, 0n]);
      } else {
        assert.deepEqual(wire.kinds, [0, 1, 2, 0, 0, 0]);
        assert.deepEqual(wire.values, [0xffffffffffffff9cn, 6n, size, 0x100n, 0n, 0n]);
        assert.equal(new TextDecoder().decode(f.requests[0]!.subarray(59)), "/file\0");
      }
    });
  }

  test(`${abi} errors propagate and out-of-range offsets never wrap into a request`, async () => {
    const f = fixture(abi, -1n, new Uint8Array(), 22);
    await assert.rejects(llseek(f.fd, -1n, 0), { code: "EINVAL" });
    await assert.rejects(ftruncate64(f.fd, -1n), { code: "EINVAL" });
    await assert.rejects(fstat64(f.fd), { code: "EINVAL" });
    const before = f.requests.length;
    for (const value of [1n << 63n, -(1n << 63n) - 1n]) {
      await assert.rejects(llseek(f.fd, value, 0), RangeError);
      await assert.rejects(ftruncate64(f.fd, value), RangeError);
    }
    assert.equal(f.requests.length, before);
  });
}

test("FileInfo presents both stat layouts and handles pre-epoch and Date-range limits", () => {
  const legacy = new Stat32(new Uint8Array(104));
  legacy.st_mtime = -1;
  legacy.st_mtime_nsec = 999500000;
  assert.equal(statToInfo(legacy).mtime!.getTime(), 0);
  const native = new Stat64(new Uint8Array(128));
  native.st_mtime = 3000000000n;
  native.st_mtime_nsec = 123456789n;
  assert.equal(statToInfo(native).mtime!.getTime(), 3000000000123);
  native.st_mtime = 8640000000000n;
  native.st_mtime_nsec = 0n;
  assert.equal(statToInfo(native).mtime!.getTime(), 8640000000000000);
  native.st_mtime_nsec = 1n;
  assert.equal(statToInfo(native).mtime, null);
  native.st_atime = -8640000000001n;
  native.st_atime_nsec = 999999999n;
  assert.equal(statToInfo(native).atime, null);
  native.st_mtime_nsec = 1000000000n;
  assert.throws(() => statToInfo(native), /invalid stat nanoseconds/);
});

test("number-valued metadata never silently rounds a 64-bit field", () => {
  for (const stat of [new Stat32(new Uint8Array(104)), new Stat64(new Uint8Array(128))]) {
    for (const key of ["st_ino", "st_size", "st_dev", "st_blocks"] as const) {
      stat[key] = 9007199254740993n;
      assert.throws(() => statToInfo(stat), RangeError);
      stat[key] = 0n;
    }
  }
});

test("public file offsets reject unsafe number inputs and an unrepresentable seek result", async () => {
  const f = fixture("wasm64", 9007199254740993n);
  const file = new FsFile(f.fd);
  try {
    await assert.rejects(file.seek(Number.MAX_SAFE_INTEGER + 1, 0), RangeError);
    await assert.rejects(file.truncate(Number.MAX_SAFE_INTEGER + 1), RangeError);
    assert.equal(f.requests.length, 0);
    await assert.rejects(file.seek(0, 0), /seek result/);
    assert.equal(
      f.requests.length,
      1,
      "the kernel offset has changed before presentation rejects it",
    );
  } finally {
    await file.close();
  }
});
