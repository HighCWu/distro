// SPDX-License-Identifier: MIT
// Explicitly selected by the wasm64 heavy check, not the default wasm32 suite.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { bootMachine, consoleDevice, entropyDevice, vsockDevice } from "@lowland/kernel";
import { O, ProtocolError, SystemError } from "../src/abi.ts";
import { GuestSession } from "../src/conn.ts";
import { statToInfo } from "../src/file.ts";
import {
  fstat64,
  fstatat64,
  ftruncate64,
  llseek,
  openat,
  read,
  unlinkat,
  write,
} from "../src/syscalls.ts";
import { closed_input } from "./helpers.ts";

test(
  "native wasm64 agent session and file syscalls on real Linux",
  { timeout: 120_000 },
  async (t) => {
    const path = process.env.AGENT_WASM64_INITRAMFS;
    assert.ok(path, "AGENT_WASM64_INITRAMFS must select the wasm64 fixture");
    const vsock = vsockDevice();
    const ready = Promise.withResolvers<void>();
    let consoleText = "";
    const decoder = new TextDecoder();
    const output = () =>
      new WritableStream<Uint8Array>({
        write(chunk) {
          process.stderr.write(chunk);
          consoleText += decoder.decode(chunk, { stream: true });
          if (consoleText.includes("agent-wasm64-runtime: ready\n")) ready.resolve();
          if (consoleText.includes("Kernel panic - not syncing"))
            ready.reject(new Error(consoleText));
        },
      });
    const machine = await bootMachine({
      cpus: 1,
      initcpio: readFileSync(path),
      plugins: [vsock, consoleDevice(closed_input(), output()), entropyDevice()],
    });
    const bootOutput = machine.bootConsole.pipeTo(output());
    // Observe failures immediately, including a machine that stops before ready.
    const ended = machine.closed.then(() => {
      throw new Error("machine closed during agent test");
    });
    void ended.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    let session: GuestSession | undefined;
    try {
      await Promise.race([
        ready.promise,
        ended,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("wasm64 agent readiness timed out")), 30_000);
        }),
      ]);
      clearTimeout(timer);

      await t.test("native executor rejects legacy v3 and explicit wasm32 identity", async () => {
        await assert.rejects(GuestSession.connect(vsock, { timeoutMs: 3000 }), ProtocolError);
        await assert.rejects(
          GuestSession.connect(vsock, { abi: "wasm32", timeoutMs: 3000 }),
          ProtocolError,
        );
      });
      session = await GuestSession.connect(vsock, { abi: "wasm64", timeoutMs: 3000 });
      assert.equal(session.abi, "wasm64");
      assert.equal(session.protocolVersion, 4);
      const active = session;

      await t.test(
        "native seek exceeds 4 GiB; truncate and stat round-trip file bytes",
        async () => {
          await using fd = await openat(active, "/tmp/native-offset", O.CREAT | O.RDWR, 0o600);
          assert.equal(await write(fd, new TextEncoder().encode("abcdef")), 6);
          const large = (1n << 32n) + 3n;
          assert.equal(await llseek(fd, large, 0), large);
          assert.equal(await llseek(fd, -2n, 1), large - 2n);
          await assert.rejects(
            llseek(fd, -1n, 0),
            (e) => e instanceof SystemError && e.code === "EINVAL",
          );
          await ftruncate64(fd, 3n);
          const descriptor = await fstat64(fd);
          const named = await fstatat64(active, "/tmp/native-offset", 0);
          assert.equal(descriptor.st_size, 3n);
          assert.equal(named.st_ino, descriptor.st_ino);
          assert.equal(typeof descriptor.st_mtime, "bigint");
          assert.equal(statToInfo(descriptor).size, 3);
          assert.equal(await llseek(fd, 0n, 0), 0n);
          assert.equal(new TextDecoder().decode(await read(fd, 10)), "abc");
        },
      );

      await t.test(
        "unlink and recreate retain distinct open descriptor metadata and bytes",
        async () => {
          const path = "/tmp/native-detached";
          await using original = await openat(active, path, O.CREAT | O.RDWR, 0o600);
          await write(original, new TextEncoder().encode("original"));
          const before = await fstat64(original);
          await unlinkat(active, path, 0);
          await assert.rejects(
            fstatat64(active, path, 0),
            (e) => e instanceof SystemError && e.code === "ENOENT",
          );
          await using replacement = await openat(active, path, O.CREAT | O.RDWR, 0o600);
          await write(replacement, new TextEncoder().encode("new"));
          const [detached, current] = await Promise.all([
            fstat64(original),
            fstatat64(active, path, 0),
          ]);
          assert.equal(detached.st_ino, before.st_ino);
          assert.notEqual(current.st_ino, before.st_ino);
          assert.equal(detached.st_size, 8n);
          assert.equal(current.st_size, 3n);
          await llseek(original, 0n, 0);
          assert.equal(new TextDecoder().decode(await read(original, 20)), "original");
        },
      );
    } finally {
      clearTimeout(timer);
      session?.close();
      machine.close();
      await machine.closed;
      await bootOutput;
    }
  },
);
