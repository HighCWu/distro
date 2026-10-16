// SPDX-License-Identifier: MIT
// Explicitly selected by the wasm64 heavy check, not the default wasm32 suite.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { bootMachine, consoleDevice, entropyDevice, vsockDevice } from "@lowland/kernel";
import { O, ProtocolError, SystemError } from "../src/abi.ts";
import { GuestSession } from "../src/conn.ts";
import { statToInfo } from "../src/file.ts";
import { ChildProcess } from "../src/process.ts";
import {
  fstat64,
  fstatat64,
  ftruncate64,
  kill,
  llseek,
  openat,
  read,
  spawn,
  unlinkat,
  write,
} from "../src/syscalls.ts";
import {
  closed_input,
  collect,
  console_line_output,
  expect_ready_message,
  pattern_bytes,
} from "./helpers.ts";

test(
  "native wasm64 agent sessions, files and processes on real Linux",
  { timeout: 120_000 },
  async (t) => {
    const path = process.env.AGENT_WASM64_INITRAMFS;
    assert.ok(path, "AGENT_WASM64_INITRAMFS must select the wasm64 fixture");
    const vsock = vsockDevice();
    const ready = Promise.withResolvers<void>();
    const output = () =>
      console_line_output((line) => {
        if (line === "agent-wasm64-runtime: ready") ready.resolve();
        if (line.includes("Kernel panic - not syncing")) ready.reject(new Error(line));
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

      await t.test("native program receives argv, cwd, env and streams binary stdio", async () => {
        let releases = 0;
        await using child = new ChildProcess({
          session: active,
          ...(await spawn(active, ["agent-runtime-child", "echo", "argument with spaces"], "/tmp", [
            "PATH=/bin",
            "AGENT_RUNTIME_VALUE=value with spaces",
          ])),
          release() {
            releases++;
          },
        });
        // Larger than one injected I/O chunk and the usual Linux pipe capacity.
        // Drain both outputs while feeding stdin, including binary NUL bytes.
        const payload = pattern_bytes(128 * 1024 + 17);
        const writer = child.stdin.getWriter();
        const input = (async () => {
          try {
            await writer.write(payload);
            await writer.close();
          } finally {
            writer.releaseLock();
          }
        })();
        const [, stdout, stderr, status] = await Promise.all([
          input,
          collect(child.stdout),
          collect(child.stderr),
          child.status,
        ]);
        assert.deepEqual(stdout, payload);
        assert.equal(
          new TextDecoder().decode(stderr),
          "abi=64 cwd=/tmp arg=argument with spaces env=value with spaces\n",
        );
        assert.deepEqual(status, { success: true, code: 0, signal: null });
        assert.equal(releases, 1);
      });

      await t.test("native nonzero exit and SIGTERM have distinct wait statuses", async () => {
        let releases = 0;
        const start = async (mode: string) =>
          new ChildProcess({
            session: active,
            ...(await spawn(active, ["/bin/agent-runtime-child", mode], "/tmp", [])),
            release() {
              releases++;
            },
          });
        {
          await using child = await start("exit");
          await child.stdin.close();
          const [stdout, stderr, status] = await Promise.all([
            collect(child.stdout),
            collect(child.stderr),
            child.status,
          ]);
          assert.equal(stdout.byteLength, 0);
          assert.equal(stderr.byteLength, 0);
          assert.deepEqual(status, { success: false, code: 23, signal: null });
        }
        {
          await using child = await start("wait");
          await child.stdin.close();
          await expect_ready_message(child.stdout, "ready\n");
          const stdout = collect(child.stdout);
          const stderr = collect(child.stderr);
          await child.kill();
          const [out, err, status] = await Promise.all([stdout, stderr, child.status]);
          assert.equal(out.byteLength, 0);
          assert.equal(err.byteLength, 0);
          assert.deepEqual(status, { success: false, code: 0, signal: "SIGTERM" });
        }
        assert.equal(releases, 2);
      });

      await t.test(
        "closing a native session kills and reaps its running program before reconnect",
        async () => {
          const child = await spawn(active, ["/bin/agent-runtime-child", "wait"], "/tmp", []);
          assert.equal(new TextDecoder().decode(await read(child.stdout, 6)), "ready\n");
          active.close();
          session = undefined;
          // PID 1 accepts the next session only after the shared production
          // cleanup helper has killed and reaped the previous process group.
          session = await GuestSession.connect(vsock, { abi: "wasm64", timeoutMs: 3000 });
          await assert.rejects(
            kill(session, child.pid, 0),
            (e) => e instanceof SystemError && e.code === "ESRCH",
          );
          assert.equal(
            (await fstatat64(session, "/bin/agent-runtime-child", 0)).st_mode & 0o111,
            0o111,
          );
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
