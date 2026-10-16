// SPDX-License-Identifier: MIT
// Explicit heavy check of the developer root, not the fixture root.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { blockDevice, bootMachine, consoleDevice, entropyDevice } from "@lowland/kernel";
import { guestAgent, SystemError } from "../src/index.ts";
import { closed_input, console_output } from "./helpers.ts";

test(
  "boots the native wasm64 minimal system root through the public API",
  { timeout: 120_000 },
  async () => {
    const imagePath = process.env.AGENT_WASM64_BOOT_DISK;
    const rootPath = process.env.AGENT_WASM64_ROOTFS;
    assert.ok(imagePath && rootPath, "select matching native boot and minimal system disks");
    const root = readFileSync(rootPath);
    const agent = guestAgent({ abi: "wasm64", image: readFileSync(imagePath) });
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
        consoleDevice(closed_input(), console_output()),
        entropyDevice(),
      ],
    });
    const output = machine.bootConsole.pipeTo(console_output());
    void output.catch(() => {});
    try {
      assert.equal(await agent.fs.readTextFile("/etc/resolv.conf"), "nameserver 192.0.2.1\n");
      assert.equal(await agent.fs.readTextFile("/etc/passwd"), "root:x:0:0:root:/root:/bin/sh\n");
      assert.equal(await agent.fs.readTextFile("/etc/group"), "root:x:0:\n");
      // Read through the link, and compare while the mount set is unchanged.
      const mounts = await agent.fs.readTextFile("/proc/mounts");
      assert.ok(mounts.length > 0);
      assert.equal(await agent.fs.readTextFile("/etc/mtab"), mounts);
      const identity = await agent.run(["/bin/busybox", "id", "-un"]);
      assert.deepEqual(identity.status, { success: true, code: 0, signal: null });
      assert.equal(new TextDecoder().decode(identity.stdout), "root\n");
      assert.equal(identity.stderr.byteLength, 0);
      for (const path of ["/etc/agent-runtime-root", "/bin/agent-runtime-child"]) {
        await assert.rejects(
          agent.fs.stat(path),
          (error) => error instanceof SystemError && error.code === "ENOENT",
        );
      }
      for (const notice of ["LICENSE", "musl-COPYRIGHT", "compiler-rt-LICENSE.TXT", "README.md"]) {
        assert.ok((await agent.fs.readFile(`/share/licenses/busybox/${notice}`)).byteLength > 0);
      }
      const data = Uint8Array.of(0, 1, 255, 0, 42);
      await agent.fs.writeFile("/tmp/minimal-probe", data);
      const cat = await agent.run(["/bin/busybox", "cat", "/tmp/minimal-probe"]);
      assert.deepEqual(cat.status, { success: true, code: 0, signal: null });
      assert.deepEqual(cat.stdout, data);
      assert.equal(cat.stderr.byteLength, 0);
      const shell = await agent.run(["/bin/sh", "-c", "pwd"]);
      assert.deepEqual(shell.status, { success: true, code: 0, signal: null });
      assert.equal(new TextDecoder().decode(shell.stdout), "/tmp\n");
      assert.equal(shell.stderr.byteLength, 0);
      await agent.fs.remove("/tmp/minimal-probe");
      console.log("native wasm64 minimal system root passed");
    } finally {
      machine.close();
      await machine.closed;
      await output;
    }
  },
);
