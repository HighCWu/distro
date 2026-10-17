// SPDX-License-Identifier: MIT
import { blockDevice, bootMachine, consoleDevice, entropyDevice } from "@lowland/kernel";
import { createNetwork, guestAgent, SeekMode, SystemError } from "../src/index.ts";
import { closed_input, console_line_output } from "./helpers.ts";
import type { RuntimeAssertions } from "./agent-wasm64-suite.ts";
import {
  publicAbortScript,
  publicShellScript,
  publicStreamScript,
} from "./agent-wasm64-userland-commands.ts";
import { checkPublicNetwork } from "./agent-wasm64-public-network.ts";
import { checkQueuedExecAbort } from "./process-queue-runtime.ts";
import { checkExecFileDescriptors } from "./exec-file-descriptors-runtime.ts";
import { checkLockedWriteInput } from "./write-file-runtime.ts";
import { checkFileStreamErrors } from "./file-stream-runtime.ts";

// Identical public API corpus in Node and browsers. No initcpio or manual
// boot arguments: the plugin selects its disk, transport and readiness ABI.
export async function runPublicAgentWasm64Suite(
  image: Uint8Array,
  root: Uint8Array,
  assert: RuntimeAssertions,
  runCase: (name: string, body: () => Promise<void>) => Promise<void>,
  writeLine: (line: string) => void,
  options: { userland?: boolean; networking?: boolean } = {},
) {
  if (options.networking && !options.userland)
    throw new Error("networking requires native userland");
  const passed: string[] = [];
  const check = (name: string, body: () => Promise<void>) =>
    runCase(name, async () => {
      writeLine(`public agent starting: ${name}\n`);
      await body();
      passed.push(name);
    });
  const agent = guestAgent({ abi: "wasm64", image });
  let outbound = 0;
  const network = options.networking
    ? createNetwork({
        connectTcp() {
          outbound++;
          throw new Error("this suite must not use an outbound network adapter");
        },
        async resolveDns() {
          throw new Error("this suite must not use DNS");
        },
      })
    : undefined;
  const attachment = network?.attach(agent);
  // No initcpio and no manual boot arguments: the public plugin owns the
  // GPT boot disk, transport and readiness handshake just as in wasm32.
  const machine = await bootMachine({
    cpus: 1,
    plugins: [
      // Exercise readiness dependency ordering: network before the agent.
      ...(attachment ? [attachment] : []),
      blockDevice({
        capacity: root.byteLength,
        read(offset, target) {
          const bytes = root.subarray(offset, offset + target.byteLength);
          target.set(bytes);
          return bytes.byteLength;
        },
      }),
      agent,
      consoleDevice(
        closed_input(),
        console_line_output(() => {}, { write: writeLine }),
      ),
      entropyDevice(),
    ],
  }).catch((error) => {
    network?.close();
    throw error;
  });
  const bootOutput = machine.bootConsole.pipeTo(
    console_line_output(() => {}, { write: writeLine }),
  );
  void bootOutput.catch(() => {});
  try {
    await check("public plugin completes root pivot before exposing capabilities", async () => {
      assert.equal(await agent.fs.readTextFile("/etc/agent-runtime-root"), "native-wasm64-root\n");
      assert.equal(await agent.fs.readLink("/proc/self/root"), "/");
      await assert.rejects(
        agent.fs.stat("/mnt/init"),
        (error) => error instanceof SystemError && error.code === "ENOENT",
      );
      await assert.rejects(
        agent.fs.writeTextFile("/bin/readonly-probe", "no"),
        (error) => error instanceof SystemError && error.code === "EROFS",
      );
    });
    await check("public file API retains native seek, metadata and truncate behavior", async () => {
      await checkLockedWriteInput(agent.fs, assert, "/tmp/public-locked-input");
      await checkFileStreamErrors(agent.fs, assert, "/tmp/public-stream-errors");
      const path = "/tmp/public-native";
      const data = new TextEncoder().encode("public-native-data");
      await agent.fs.writeFile(path, data);
      assert.deepEqual(await agent.fs.readFile(path), data);
      const file = await agent.fs.open(path, { read: true, write: true });
      try {
        assert.equal((await file.stat()).size, data.byteLength);
        assert.equal(await file.seek((1n << 32n) + 11n, SeekMode.Start), 2 ** 32 + 11);
        assert.equal(await file.seek(-11, SeekMode.Current), 2 ** 32);
        await file.truncate(6);
        assert.equal((await agent.fs.stat(path)).size, 6);
        assert.equal(await agent.fs.readTextFile(path), "public");
      } finally {
        await file.close();
      }
      const copy = "/tmp/public-native-copy";
      const alias = "/tmp/public-native-alias";
      try {
        await agent.fs.copyFile(path, copy);
        assert.equal(await agent.fs.readTextFile(copy), "public");
        await assert.rejects(
          agent.fs.writeTextFile(path + "\0suffix", "must not truncate"),
          (error) => error instanceof TypeError,
        );
        await assert.rejects(
          agent.fs.remove(path + "\0suffix"),
          (error) => error instanceof TypeError,
        );
        await assert.rejects(
          agent.fs.rename(path, copy + "\0suffix"),
          (error) => error instanceof TypeError,
        );
        assert.equal(await agent.fs.readTextFile(path), "public");
        assert.equal(await agent.fs.readTextFile(copy), "public");
        await agent.fs.symlink(path, alias);
        await assert.rejects(
          agent.fs.copyFile(path, alias),
          (error) => error instanceof SystemError && error.code === "EINVAL",
        );
        assert.equal(await agent.fs.readTextFile(path), "public");
        assert.equal(await agent.fs.readLink(alias), path);
      } finally {
        await agent.fs.remove(alias).catch(() => {});
        await agent.fs.remove(copy).catch(() => {});
      }
    });
    await check("public run collects native status and forwards process options", async () => {
      for (const argv of [
        ["agent-runtime-child", "x".repeat(4 * 1024 * 1024 + 1)],
        ["agent-runtime-child", "中".repeat(1366)],
        ["agent-runtime-child", ...Array(256).fill("x")],
      ]) {
        await assert.rejects(
          agent.exec(argv),
          (error) => error instanceof SystemError && error.code === "EINVAL",
        );
      }
      const exited = await agent.run(["agent-runtime-child", "exit"]);
      assert.deepEqual(exited.status, { success: false, code: 23, signal: null });
      assert.equal(exited.stdout.byteLength, 0);
      assert.equal(exited.stderr.byteLength, 0);
      const echoed = await agent.run(["agent-runtime-child", "echo", "public arg"], {
        cwd: "/tmp",
        env: { AGENT_RUNTIME_VALUE: "public env" },
      });
      assert.deepEqual(echoed.status, { success: true, code: 0, signal: null });
      assert.equal(echoed.stdout.byteLength, 0);
      assert.equal(
        new TextDecoder().decode(echoed.stderr),
        "abi=64 cwd=/tmp arg=public arg env=public env\n",
      );
    });
    if (options.userland) {
      await check("public run executes native shell pipelines and child lifecycle", async () => {
        await checkExecFileDescriptors(agent, assert, "/tmp/public-exec-fds");
        const shell = await agent.run(
          ["/bin/sh", "-c", publicShellScript, "agent-shell", "public shell arg"],
          { cwd: "/tmp", env: { AGENT_RUNTIME_VALUE: "public shell env" } },
        );
        if (!shell.status.success) {
          writeLine(`public shell failure: ${JSON.stringify(shell.status)}\n`);
          writeLine(new TextDecoder().decode(shell.stderr));
        }
        assert.deepEqual(shell.status, { success: true, code: 0, signal: null });
        assert.equal(new TextDecoder().decode(shell.stdout), "native shell passed\n");
        assert.equal(shell.stderr.byteLength, 0);

        // Wait for a real running command before aborting: an already-aborted
        // signal would only test rejection before spawn, not run() cleanup.
        const controller = new AbortController();
        const reason = new Error("cancel public native shell run");
        const cancelled = agent.run(["/bin/sh", "-c", publicAbortScript], {
          signal: controller.signal,
        });
        void cancelled.catch(() => {});
        try {
          const deadline = performance.now() + 10_000;
          for (;;) {
            try {
              assert.equal(await agent.fs.readTextFile("/tmp/public-run-ready"), "ready");
              break;
            } catch (error) {
              if (!(error instanceof SystemError && error.code === "ENOENT")) throw error;
              if (performance.now() >= deadline) throw new Error("public run did not start");
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }
        } finally {
          controller.abort(reason);
        }
        await assert.rejects(cancelled, (error) => error === reason);
        await agent.fs.remove("/tmp/public-run-ready");
        const next = await agent.run(["/bin/true"]);
        assert.deepEqual(next.status, { success: true, code: 0, signal: null });
        assert.equal(next.stdout.byteLength, 0);
        assert.equal(next.stderr.byteLength, 0);
        await checkQueuedExecAbort(agent, assert);
      });
      await check("public exec streams binary data through native shell pipelines", async () => {
        // Cross injected I/O chunks and Linux pipe capacity, including NULs.
        const payload = Uint8Array.from({ length: 256 * 1024 + 17 }, (_, i) => (i * 37 + 11) & 255);
        for (const stdinMode of ["buffered", "streaming"] as const) {
          const child = await agent.exec(["/bin/sh", "-c", publicStreamScript], { stdinMode });
          try {
            const input = (async () => {
              const writer = child.stdin.getWriter();
              try {
                for (let offset = 0; offset < payload.byteLength; offset += 8191) {
                  await writer.write(payload.subarray(offset, offset + 8191));
                }
                await writer.close();
              } finally {
                writer.releaseLock();
              }
            })();
            // Drain both pipes while feeding stdin: never serialize collection
            // behind a write/close that may require the program to drain output.
            const [, stdout, stderr, status] = await Promise.all([
              input,
              new Response(child.stdout).arrayBuffer(),
              new Response(child.stderr).arrayBuffer(),
              child.status,
            ]);
            assert.deepEqual(new Uint8Array(stdout), payload);
            assert.deepEqual(new Uint8Array(stderr), payload);
            assert.deepEqual(status, { success: true, code: 0, signal: null });
            await assert.rejects(
              child.kill("SIGTERM"),
              (error) => error instanceof SystemError && error.code === "ESRCH",
            );
            await assert.rejects(
              agent.fs.stat("/tmp/public-stream-copy"),
              (error) => error instanceof SystemError && error.code === "ENOENT",
            );
          } finally {
            await child.close();
          }
        }
      });
      await check("public exec rejects stdin after process disposal", async () => {
        const child = await agent.exec(["/bin/cat"]);
        const writer = child.stdin.getWriter();
        try {
          await child.close();
          await assert.rejects(
            writer.write(Uint8Array.of(0, 255)),
            (error) => error instanceof SystemError && error.code === "EPIPE",
          );
          await assert.rejects(
            writer.closed,
            (error) => error instanceof SystemError && error.code === "EPIPE",
          );
        } finally {
          writer.releaseLock();
          await child.close();
        }
        const next = await agent.run(["/bin/true"]);
        assert.equal(next.status.success, true);
      });
    }
    if (attachment) {
      await check("public network reaches a native HTTP server over the attached NIC", async () => {
        await checkPublicNetwork(agent, attachment, assert);
        assert.equal(outbound, 0);
      });
    }
  } finally {
    machine.close();
    network?.close();
    await machine.closed;
    await bootOutput;
  }
  return { passed, closed: true };
}
