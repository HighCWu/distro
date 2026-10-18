// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { blockDevice } from "@lowland/kernel";
import { SystemError } from "../src/index.ts";
import { withPersistentRootMachine } from "./agent-wasm64-persistent-root-suite.ts";

test(
  "runs Python Git SQLite collaboration across fresh wasm64 roots",
  { timeout: 180_000 },
  async (t) => {
    const bootPath = process.env.AGENT_WASM64_BOOT_DISK;
    const rootPath = process.env.AGENT_WASM64_ROOTFS;
    const examplePath = process.env.AGENT_WASM64_APPLICATION;
    assert.ok(bootPath && rootPath && examplePath);
    const boot = readFileSync(bootPath);
    const root = new Uint8Array(readFileSync(rootPath));
    const source = new Uint8Array(readFileSync(examplePath));
    const script = "/root/workspace-example.py";
    const directory = "/root/workspace ' $HOME → data";
    const payload = Uint8Array.from({ length: 65553 }, (_, index) => index & 255);
    const digest = createHash("sha256").update(payload).digest("hex");
    let head: string | undefined;
    let closed = 0,
      writes = 0,
      flushes = 0;
    for (const phase of ["write", "read"] as const) {
      await t.test(`Python Git workspace ${phase} through public SDK`, async () => {
        assert.equal(closed, phase === "write" ? 0 : 1);
        const previousWrites = writes,
          previousFlushes = flushes;
        await withPersistentRootMachine(
          boot,
          blockDevice({
            capacity: root.byteLength,
            read(offset, data) {
              const bytes = root.subarray(offset, offset + data.byteLength);
              data.set(bytes);
              return bytes.byteLength;
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
          assert,
          async (agent) => {
            for (const path of [
              "/python-test.sh",
              "/git-runtime-check.sh",
              "/git-notice-check.sh",
              "/bin/agent-runtime-child",
              "/etc/agent-runtime-root",
              script,
            ]) {
              if (path === script && phase === "read") continue;
              await assert.rejects(
                agent.fs.stat(path),
                (error) => error instanceof SystemError && error.code === "ENOENT",
              );
            }
            if (phase === "write") await agent.fs.writeFile(script, source);
            else assert.deepEqual(await agent.fs.readFile(script), source);
            const abi = await agent.run([
              "python3",
              "-I",
              "-c",
              "import struct,sys,ssl; assert struct.calcsize('P') == 8; assert sys.prefix == '/usr'; assert ssl.create_default_context().cert_store_stats()['x509_ca'] > 0; print('Python Git root ABI OK')",
            ]);
            assert.deepEqual(abi.status, { success: true, code: 0, signal: null });
            assert.equal(new TextDecoder().decode(abi.stdout), "Python Git root ABI OK\n");
            assert.equal(abi.stderr.byteLength, 0);
            const git = await agent.run(["git", "version", "--build-options"]);
            assert.deepEqual(git.status, { success: true, code: 0, signal: null });
            assert.equal(git.stderr.byteLength, 0);
            assert.match(new TextDecoder().decode(git.stdout), /^sizeof-long: 8$/m);
            assert.match(new TextDecoder().decode(git.stdout), /^sizeof-size_t: 8$/m);
            for (const path of [
              "/share/licenses/python/readline-COPYING",
              "/usr/share/licenses/git/git-COPYING",
              "/usr/share/licenses/git/linked/openssl-LICENSE.txt",
            ]) {
              assert.ok((await agent.fs.readFile(path)).byteLength > 0);
            }
            const notices = await agent.run(["sha256sum", "-c", "SHA256SUMS"], {
              cwd: "/usr/share/licenses/git",
            });
            assert.deepEqual(notices.status, { success: true, code: 0, signal: null });
            assert.equal(notices.stderr.byteLength, 0);
            const result = await agent.run([
              "python3",
              "-I",
              script,
              phase,
              directory,
              ...(head ? [head] : []),
            ]);
            assert.deepEqual(result.status, { success: true, code: 0, signal: null });
            assert.equal(result.stderr.byteLength, 0);
            const report = JSON.parse(new TextDecoder().decode(result.stdout));
            assert.match(report.head, /^[0-9a-f]{40}$/);
            if (phase === "read") assert.equal(report.head, head);
            head = report.head;
            assert.deepEqual(report, { head, sha256: digest, bytes: payload.byteLength, phase });
            const paths =
              phase === "write"
                ? ["project ' $HOME → repo"]
                : ["project ' $HOME → repo", "clone ' $HOME → repo"];
            for (const path of paths)
              assert.deepEqual(
                await agent.fs.readFile(`${directory}/${path}/payload ' $HOME → data.bin`),
                payload,
              );
            const synced = await agent.run(["/bin/sync"]);
            assert.deepEqual(synced.status, { success: true, code: 0, signal: null });
            assert.equal(synced.stdout.byteLength, 0);
            assert.equal(synced.stderr.byteLength, 0);
            assert.ok(writes > previousWrites && flushes > previousFlushes);
          },
          (line) => process.stderr.write(line),
        );
        closed++;
      });
    }
    assert.equal(closed, 2);
  },
);
