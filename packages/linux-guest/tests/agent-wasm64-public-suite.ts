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
  } finally {
    machine.close();
    await machine.closed;
    await bootOutput;
  }
  return { passed, closed: true };
}
