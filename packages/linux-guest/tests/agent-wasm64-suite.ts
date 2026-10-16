// SPDX-License-Identifier: MIT
// Shared by Node and browser bring-up checks; no Node-only runtime imports.
import {
  bootMachine,
  consoleDevice,
  entropyDevice,
  vsockDevice,
  type BootMachineOptions,
} from "@lowland/kernel";
import { O, ProtocolError, S_IF, SystemError } from "../src/abi.ts";
import { GuestSession } from "../src/conn.ts";
import { create_guest_client } from "../src/client.ts";
import { SeekMode } from "../src/file.ts";
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
  readlinkat,
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

export interface RuntimeAssertions {
  equal(actual: unknown, expected: unknown): void;
  notEqual(actual: unknown, expected: unknown): void;
  deepEqual(actual: unknown, expected: unknown): void;
  rejects(promise: Promise<unknown>, predicate: (error: unknown) => boolean): Promise<unknown>;
}

async function with_close<T extends { close(): Promise<void> }>(
  resource: T,
  body: (resource: T) => Promise<void>,
): Promise<void> {
  try {
    await body(resource);
  } finally {
    await resource.close();
  }
}

export async function runAgentWasm64Suite(
  initcpio: Uint8Array<ArrayBuffer>,
  assert: RuntimeAssertions,
  runCase: (name: string, body: () => Promise<void>) => Promise<void>,
  writeLine: (text: string) => void,
  options: Pick<BootMachineOptions, "plugins"> & { productionRoot?: boolean } = {},
) {
  const passed: string[] = [];
  const t = {
    test(name: string, body: () => Promise<void>) {
      return runCase(name, async () => {
        writeLine(`native agent starting: ${name}\n`);
        await body();
        passed.push(name);
      });
    },
  };
  const vsock = vsockDevice();
  const ready = Promise.withResolvers<void>();
  const output = (userConsole: boolean) =>
    console_line_output(
      (line) => {
        const readyLine = options.productionRoot
          ? "linux-guest-agent: ready on vsock port 1024"
          : "agent-wasm64-runtime: ready";
        if (userConsole && line === readyLine) ready.resolve();
        if (line.includes("Kernel panic - not syncing")) ready.reject(new Error(line));
      },
      { write: writeLine },
    );
  const machine = await bootMachine({
    cpus: 1,
    initcpio,
    plugins: [
      vsock,
      consoleDevice(closed_input(), output(true)),
      entropyDevice(),
      ...(options.plugins ?? []),
    ],
  });
  const bootOutput = machine.bootConsole.pipeTo(output(false));
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
      writeLine("native agent handshake: reject legacy v3\n");
      await assert.rejects(
        GuestSession.connect(vsock, { timeoutMs: 3000 }),
        (error) => error instanceof ProtocolError,
      );
      writeLine("native agent handshake: reject explicit wasm32\n");
      await assert.rejects(
        GuestSession.connect(vsock, { abi: "wasm32", timeoutMs: 3000 }),
        (error) => error instanceof ProtocolError,
      );
    });
    writeLine("native agent handshake: accept explicit wasm64\n");
    session = await GuestSession.connect(vsock, { abi: "wasm64", timeoutMs: 3000 });
    assert.equal(session.abi, "wasm64");
    assert.equal(session.protocolVersion, 4);
    const active = session;

    if (options.productionRoot) {
      await t.test(
        "production agent pivots into the labeled root and detaches its initramfs",
        async () => {
          await with_close(
            await openat(active, "/etc/agent-runtime-root", O.RDONLY, 0),
            async (fd) => {
              assert.equal(new TextDecoder().decode(await read(fd, 128)), "native-wasm64-root\n");
            },
          );
          assert.equal(
            new TextDecoder().decode(await readlinkat(active, "/proc/self/root", 128)),
            "/",
          );
          for (const path of ["/dev/pts", "/proc/self/fd", "/sys/class/block"]) {
            assert.equal((await fstatat64(active, path, 0)).st_mode & S_IF.MT, S_IF.DIR);
          }
          await assert.rejects(
            fstatat64(active, "/mnt/init", 0),
            (error) => error instanceof SystemError && error.code === "ENOENT",
          );
          await with_close(await openat(active, "/proc/mounts", O.RDONLY, 0), async (fd) => {
            const mounts = new TextDecoder().decode(await read(fd, 32768));
            assert.equal(
              mounts.split("\n").some((line) => {
                const fields = line.split(" ");
                return (
                  fields[1] === "/" && fields[2] === "erofs" && fields[3]?.split(",").includes("ro")
                );
              }),
              true,
            );
          });
        },
      );
    }

    await t.test("native seek exceeds 4 GiB; truncate and stat round-trip file bytes", async () => {
      await with_close(
        await openat(active, "/tmp/native-offset", O.CREAT | O.RDWR, 0o600),
        async (fd) => {
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
    });

    await t.test(
      "unlink and recreate retain distinct open descriptor metadata and bytes",
      async () => {
        const path = "/tmp/native-detached";
        await with_close(await openat(active, path, O.CREAT | O.RDWR, 0o600), async (original) => {
          await write(original, new TextEncoder().encode("original"));
          const before = await fstat64(original);
          await unlinkat(active, path, 0);
          await assert.rejects(
            fstatat64(active, path, 0),
            (e) => e instanceof SystemError && e.code === "ENOENT",
          );
          await with_close(
            await openat(active, path, O.CREAT | O.RDWR, 0o600),
            async (replacement) => {
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
        });
      },
    );

    await t.test("native program receives argv, cwd, env and streams binary stdio", async () => {
      let releases = 0;
      await with_close(
        new ChildProcess({
          session: active,
          ...(await spawn(active, ["agent-runtime-child", "echo", "argument with spaces"], "/tmp", [
            "PATH=/bin",
            "AGENT_RUNTIME_VALUE=value with spaces",
          ])),
          release() {
            releases++;
          },
        }),
        async (child) => {
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
        },
      );
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
        await with_close(await start("exit"), async (child) => {
          await child.stdin.close();
          const [stdout, stderr, status] = await Promise.all([
            collect(child.stdout),
            collect(child.stderr),
            child.status,
          ]);
          assert.equal(stdout.byteLength, 0);
          assert.equal(stderr.byteLength, 0);
          assert.deepEqual(status, { success: false, code: 23, signal: null });
        });
      }
      {
        await with_close(await start("wait"), async (child) => {
          await child.stdin.close();
          await expect_ready_message(child.stdout, "ready\n");
          const stdout = collect(child.stdout);
          const stderr = collect(child.stderr);
          await child.kill();
          const [out, err, status] = await Promise.all([stdout, stderr, child.status]);
          assert.equal(out.byteLength, 0);
          assert.equal(err.byteLength, 0);
          assert.deepEqual(status, { success: false, code: 0, signal: "SIGTERM" });
        });
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
    await t.test(
      "native high-level client preserves file offsets, metadata and process status",
      async () => {
        // The executor admits one session at a time. Transfer ownership rather
        // than opening a second session alongside the raw protocol checks.
        session?.close();
        session = undefined;
        const client = create_guest_client(vsock, { abi: "wasm64" });
        await client.ping(3000);
        const path = "/tmp/native-client";
        await client.fs.writeTextFile(path, "native-client-data");
        assert.equal(await client.fs.readTextFile(path), "native-client-data");
        assert.equal((await client.fs.stat(path)).size, 18);
        await with_close(await client.fs.open(path, { read: true, write: true }), async (file) => {
          assert.equal(await file.seek((1n << 32n) + 9n, SeekMode.Start), 2 ** 32 + 9);
          assert.equal(await file.seek(-9, SeekMode.Current), 2 ** 32);
        });
        await client.fs.truncate(path, 6);
        assert.equal(await client.fs.readTextFile(path), "native");
        await with_close(await client.exec(["agent-runtime-child", "exit"]), async (child) => {
          await child.stdin.close();
          const [stdout, stderr, status] = await Promise.all([
            collect(child.stdout),
            collect(child.stderr),
            child.status,
          ]);
          assert.equal(stdout.byteLength, 0);
          assert.equal(stderr.byteLength, 0);
          assert.deepEqual(status, { success: false, code: 23, signal: null });
        });
        await client.fs.remove(path);
        await assert.rejects(
          client.fs.stat(path),
          (error) => error instanceof SystemError && error.code === "ENOENT",
        );
      },
    );
  } finally {
    clearTimeout(timer);
    session?.close();
    writeLine("native agent cleanup: closing machine\n");
    machine.close();
    await machine.closed;
    await bootOutput;
    writeLine("native agent cleanup: machine closed\n");
  }
  return { passed, closed: true };
}
