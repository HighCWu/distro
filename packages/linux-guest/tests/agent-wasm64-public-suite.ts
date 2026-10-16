// SPDX-License-Identifier: MIT
import { blockDevice, bootMachine, consoleDevice, entropyDevice } from "@lowland/kernel";
import { guestAgent, SeekMode, SystemError } from "../src/index.ts";
import { closed_input, console_line_output } from "./helpers.ts";
import type { RuntimeAssertions } from "./agent-wasm64-suite.ts";

// Identical public API corpus in Node and browsers. No initcpio or manual
// boot arguments: the plugin selects its disk, transport and readiness ABI.
export async function runPublicAgentWasm64Suite(
  image: Uint8Array,
  root: Uint8Array,
  assert: RuntimeAssertions,
  runCase: (name: string, body: () => Promise<void>) => Promise<void>,
  writeLine: (line: string) => void,
  options: { userland?: boolean } = {},
) {
  const passed: string[] = [];
  const check = (name: string, body: () => Promise<void>) =>
    runCase(name, async () => {
      writeLine(`public agent starting: ${name}\n`);
      await body();
      passed.push(name);
    });
  const agent = guestAgent({ abi: "wasm64", image });
  // No initcpio and no manual boot arguments: the public plugin owns the
  // GPT boot disk, transport and readiness handshake just as in wasm32.
  const machine = await bootMachine({
    cpus: 1,
    plugins: [
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
    });
    await check("public run collects native status and forwards process options", async () => {
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
        const shell = await agent.run(
          [
            "/bin/sh",
            "-c",
            `
set -eu
[ "$PWD" = /tmp ]
[ "$1" = 'public shell arg' ]
[ "$AGENT_RUNTIME_VALUE" = 'public shell env' ]
printf '%s\\n' "$1" | grep -qx 'public shell arg'
root=$(cat /etc/agent-runtime-root)
[ "$root" = native-wasm64-root ]
printf '%s\\n' "$AGENT_RUNTIME_VALUE" > /tmp/public-shell-source
cp /tmp/public-shell-source /tmp/public-shell-copy
[ "$(cat /tmp/public-shell-copy)" = 'public shell env' ]
if /bin/sh -c 'exit 7'; then exit 90; else status=$?; fi
[ "$status" -eq 7 ]
sleep 0.01 &
child=$!
wait "$child"
rm /tmp/public-shell-source /tmp/public-shell-copy
printf '%s\\n' 'native shell passed'
`,
            "agent-shell",
            "public shell arg",
          ],
          { cwd: "/tmp", env: { AGENT_RUNTIME_VALUE: "public shell env" } },
        );
        if (!shell.status.success) {
          writeLine(`public shell failure: ${JSON.stringify(shell.status)}\n`);
          writeLine(new TextDecoder().decode(shell.stderr));
        }
        assert.deepEqual(shell.status, { success: true, code: 0, signal: null });
        assert.equal(new TextDecoder().decode(shell.stdout), "native shell passed\n");
        assert.equal(shell.stderr.byteLength, 0);
      });
      await check("public exec streams binary data through native shell pipelines", async () => {
        // Cross injected I/O chunks and Linux pipe capacity, including NULs.
        const payload = Uint8Array.from({ length: 256 * 1024 + 17 }, (_, i) => (i * 37 + 11) & 255);
        const child = await agent.exec([
          "/bin/sh",
          "-c",
          "set -eu; tee /tmp/public-stream-copy | cat; cat /tmp/public-stream-copy >&2; rm /tmp/public-stream-copy",
        ]);
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
            agent.fs.stat("/tmp/public-stream-copy"),
            (error) => error instanceof SystemError && error.code === "ENOENT",
          );
        } finally {
          await child.close();
        }
      });
    }
  } finally {
    machine.close();
    await machine.closed;
    await bootOutput;
  }
  return { passed, closed: true };
}
