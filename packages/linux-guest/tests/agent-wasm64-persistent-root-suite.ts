// SPDX-License-Identifier: MIT
import { blockDevice, bootMachine, consoleDevice, entropyDevice } from "@lowland/kernel";
import { guestAgent, SystemError } from "../src/index.ts";
import { closed_input, console_line_output } from "./helpers.ts";
import type { RuntimeAssertions } from "./agent-wasm64-suite.ts";

// Preserve only block bytes between fresh machines. No shared Linux linear memory,
// executor session, external initramfs, overlay or runtime fixture is reused.
export async function runPersistentRootWasm64Suite(
  image: Uint8Array,
  originalRoot: Uint8Array,
  assert: RuntimeAssertions,
  runCase: (name: string, body: () => Promise<void>) => Promise<void>,
  writeLine: (line: string) => void,
) {
  const root = originalRoot.slice();
  const payload = Uint8Array.from({ length: 65553 }, (_, i) => (i * 37 + 11) & 255);
  const passed: string[] = [];
  const path = "/root/persistent-payload";
  let writes = 0;
  let flushes = 0;
  let closed = 0;
  async function boot(verify: (agent: ReturnType<typeof guestAgent>) => Promise<void>) {
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
          write(offset, data) {
            root.set(data, offset);
            writes++;
            return data.byteLength;
          },
          flush() {
            flushes++;
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
      const mounts = await agent.fs.readTextFile("/proc/mounts");
      assert.equal(
        mounts.split("\n").some((line) => {
          const fields = line.split(" ");
          return fields[1] === "/" && fields[2] === "ext4" && fields[3]?.split(",").includes("rw");
        }),
        true,
      );
      await verify(agent);
    } finally {
      machine.close();
      await machine.closed;
      await bootOutput;
      closed++;
    }
  }
  await runCase("native ext4 root writes and flushes binary data through public APIs", async () => {
    await boot(async (agent) => {
      await assert.rejects(
        agent.fs.stat(path),
        (error) => error instanceof SystemError && error.code === "ENOENT",
      );
      const previousWrites = writes;
      const previousFlushes = flushes;
      await agent.fs.writeFile(`${path}.new`, payload);
      const file = await agent.fs.open(`${path}.new`, { read: true, write: true });
      try {
        await file.sync();
      } finally {
        await file.close();
      }
      await agent.fs.rename(`${path}.new`, path);
      await agent.fs.chmod(path, 0o640);
      const synced = await agent.run(["/bin/sync"]);
      assert.deepEqual(synced.status, { success: true, code: 0, signal: null });
      assert.equal(synced.stdout.byteLength, 0);
      assert.equal(synced.stderr.byteLength, 0);
      assert.equal(writes > previousWrites, true);
      assert.equal(flushes > previousFlushes, true);
    });
    passed.push("native ext4 root writes and flushes binary data through public APIs");
  });
  await runCase("fresh native Linux instance reads persisted ext4 bytes and metadata", async () => {
    assert.equal(closed, 1);
    await boot(async (agent) => {
      assert.deepEqual(await agent.fs.readFile(path), payload);
      const info = await agent.fs.stat(path);
      assert.equal(info.size, payload.byteLength);
      assert.equal(info.mode & 0o777, 0o640);
      await assert.rejects(
        agent.fs.stat(`${path}.new`),
        (error) => error instanceof SystemError && error.code === "ENOENT",
      );
      const cat = await agent.run(["/bin/busybox", "cat", path]);
      assert.deepEqual(cat.status, { success: true, code: 0, signal: null });
      assert.deepEqual(cat.stdout, payload);
      assert.equal(cat.stderr.byteLength, 0);
    });
    passed.push("fresh native Linux instance reads persisted ext4 bytes and metadata");
  });
  assert.equal(closed, 2);
  return { passed, closed: true };
}
