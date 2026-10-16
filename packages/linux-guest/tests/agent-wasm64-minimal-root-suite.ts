// SPDX-License-Identifier: MIT
// Shared Node/browser check of the developer root, not the fixture root.
import { blockDevice, bootMachine, consoleDevice, entropyDevice } from "@lowland/kernel";
import { guestAgent, SystemError } from "../src/index.ts";
import { closed_input, console_line_output } from "./helpers.ts";
import type { RuntimeAssertions } from "./agent-wasm64-suite.ts";

export async function runMinimalRootWasm64Suite(
  image: Uint8Array,
  root: Uint8Array,
  assert: RuntimeAssertions,
  runCase: (name: string, body: () => Promise<void>) => Promise<void>,
  writeLine: (line: string) => void,
) {
  const passed: string[] = [];
  const check = (name: string, body: () => Promise<void>) =>
    runCase(name, async () => {
      writeLine(`minimal root starting: ${name}\n`);
      await body();
      passed.push(name);
    });
  const agent = guestAgent({ abi: "wasm64", image });
  const output = () => console_line_output(() => {}, { write: writeLine });
  const machine = await bootMachine({
    cpus: 1,
    plugins: [
      blockDevice({
        capacity: root.byteLength,
        read(offset, target) {
          const source = root.subarray(offset, offset + target.byteLength);
          target.set(source);
          return source.byteLength;
        },
      }),
      agent,
      consoleDevice(closed_input(), output()),
      entropyDevice(),
    ],
  });
  const bootOutput = machine.bootConsole.pipeTo(output());
  void bootOutput.catch(() => {});
  try {
    await check("minimal root provides native identity and live mount metadata", async () => {
      assert.equal(await agent.fs.readTextFile("/etc/resolv.conf"), "nameserver 192.0.2.1\n");
      assert.equal(await agent.fs.readTextFile("/etc/passwd"), "root:x:0:0:root:/root:/bin/sh\n");
      assert.equal(await agent.fs.readTextFile("/etc/group"), "root:x:0:\n");
      assert.equal(await agent.fs.readLink("/etc/mtab"), "/proc/mounts");
      const mounts = await agent.fs.readTextFile("/proc/mounts");
      assert.equal(mounts.length > 0, true);
      assert.equal(await agent.fs.readTextFile("/etc/mtab"), mounts);
      const identity = await agent.run(["/bin/busybox", "id", "-un"]);
      assert.deepEqual(identity.status, { success: true, code: 0, signal: null });
      assert.equal(new TextDecoder().decode(identity.stdout), "root\n");
      assert.equal(identity.stderr.byteLength, 0);
    });
    await check("minimal root contains license texts but no runtime fixtures", async () => {
      for (const path of ["/etc/agent-runtime-root", "/bin/agent-runtime-child"]) {
        await assert.rejects(
          agent.fs.stat(path),
          (error) => error instanceof SystemError && error.code === "ENOENT",
        );
      }
      for (const notice of ["LICENSE", "musl-COPYRIGHT", "compiler-rt-LICENSE.TXT", "README.md"]) {
        assert.equal(
          (await agent.fs.readFile(`/share/licenses/busybox/${notice}`)).byteLength > 0,
          true,
        );
      }
    });
    await check("minimal root runs native BusyBox with exact binary file output", async () => {
      const data = Uint8Array.of(0, 1, 255, 0, 42);
      await agent.fs.writeFile("/tmp/minimal-probe", data);
      const cat = await agent.run(["/bin/busybox", "cat", "/tmp/minimal-probe"]);
      assert.deepEqual(cat.status, { success: true, code: 0, signal: null });
      assert.deepEqual(cat.stdout, data);
      assert.equal(cat.stderr.byteLength, 0);
      await agent.fs.remove("/tmp/minimal-probe");
    });
    await check("minimal root runs its installed native shell in the default cwd", async () => {
      const shell = await agent.run(["/bin/sh", "-c", "pwd"]);
      assert.deepEqual(shell.status, { success: true, code: 0, signal: null });
      assert.equal(new TextDecoder().decode(shell.stdout), "/tmp\n");
      assert.equal(shell.stderr.byteLength, 0);
    });
  } finally {
    machine.close();
    await machine.closed;
    await bootOutput;
  }
  return { passed, closed: true };
}
