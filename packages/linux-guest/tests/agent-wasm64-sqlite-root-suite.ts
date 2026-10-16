// SPDX-License-Identifier: MIT
import { blockDevice } from "@lowland/kernel";
import { withPersistentRootMachine } from "./agent-wasm64-persistent-root-suite.ts";
import { sqliteWrite, sqliteRead, sqliteExpected } from "./agent-wasm64-sqlite-commands.ts";
import type { RuntimeAssertions } from "./agent-wasm64-suite.ts";
import type { guestAgent } from "../src/index.ts";
export { withPersistentRootMachine };

export async function verifySqliteRoot(
  agent: ReturnType<typeof guestAgent>,
  phase: "write" | "read",
  assert: RuntimeAssertions,
) {
  // No shell status tricks: run the installed upstream CLI directly.
  const args = ["/bin/sqlite3", "-batch", "-bail"];
  if (phase === "read") args.push("-readonly");
  args.push("/root/application.sqlite", phase === "write" ? sqliteWrite : sqliteRead);
  const result = await agent.run(args);
  assert.deepEqual(result.status, { success: true, code: 0, signal: null });
  assert.equal(
    new TextDecoder().decode(result.stdout),
    phase === "write" ? "delete\n" : sqliteExpected,
  );
  assert.equal(result.stderr.byteLength, 0);
  if (phase === "write") {
    const sync = await agent.run(["/bin/sync"]);
    assert.deepEqual(sync.status, { success: true, code: 0, signal: null });
    assert.equal(sync.stdout.byteLength, 0);
    assert.equal(sync.stderr.byteLength, 0);
  }
}

export async function runSqliteRootWasm64Suite(
  image: Uint8Array,
  originalRoot: Uint8Array,
  assert: RuntimeAssertions,
  runCase: (name: string, body: () => Promise<void>) => Promise<void>,
  writeLine: (line: string) => void,
) {
  const root = originalRoot.slice();
  const passed: string[] = [];
  let closed = 0;
  let flushes = 0;
  for (const phase of ["write", "read"] as const) {
    const name =
      phase === "write"
        ? "native wasm64 SQLite commits and rolls back on ext4"
        : "fresh native wasm64 SQLite verifies persisted database integrity and fields";
    await runCase(name, async () => {
      assert.equal(closed, phase === "write" ? 0 : 1);
      const previousFlushes = flushes;
      await withPersistentRootMachine(
        image,
        blockDevice({
          capacity: root.byteLength,
          read(offset, target) {
            target.set(root.subarray(offset, offset + target.byteLength));
            return target.byteLength;
          },
          write(offset, data) {
            root.set(data, offset);
            return data.byteLength;
          },
          flush() {
            flushes++;
          },
        }),
        assert,
        async (agent) => {
          await verifySqliteRoot(agent, phase, assert);
          if (phase === "write") {
            assert.equal(flushes > previousFlushes, true);
          }
        },
        writeLine,
      );
      closed++;
      passed.push(name);
    });
  }
  assert.equal(closed, 2);
  return { passed, closed: true };
}
