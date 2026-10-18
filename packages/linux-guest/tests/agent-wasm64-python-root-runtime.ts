// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { blockDevice } from "@lowland/kernel";
import { SystemError } from "../src/index.ts";
import { withPersistentRootMachine } from "./agent-wasm64-persistent-root-suite.ts";

test(
  "runs installed wasm64 Python applications across fresh ext4 roots",
  { timeout: 180_000 },
  async (t) => {
    const imagePath = process.env.AGENT_WASM64_BOOT_DISK;
    const rootPath = process.env.AGENT_WASM64_ROOTFS;
    const archivePath = process.env.AGENT_WASM64_APPLICATION;
    assert.ok(
      imagePath && rootPath && archivePath,
      "select boot disk, Python root and actual example archive",
    );
    const image = readFileSync(imagePath);
    const root = new Uint8Array(readFileSync(rootPath));
    const archive = new Uint8Array(readFileSync(archivePath));
    let closed = 0;
    let flushes = 0;
    for (const phase of ["write", "read"] as const) {
      await t.test(`Python application ${phase} through public SDK`, async () => {
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
            for (const path of [
              "/python-test.sh",
              "/python-pty-test.py",
              "/bin/agent-runtime-child",
              "/etc/agent-runtime-root",
            ]) {
              await assert.rejects(
                agent.fs.stat(path),
                (error) => error instanceof SystemError && error.code === "ENOENT",
              );
            }
            for (const name of ["python-LICENSE", "readline-COPYING", "ncurses-COPYING"]) {
              assert.ok((await agent.fs.readFile(`/share/licenses/python/${name}`)).byteLength > 0);
            }
            const abi = await agent.run([
              "python3",
              "-I",
              "-c",
              "import struct,sys,ssl,sqlite3,curses,bz2,lzma; assert struct.calcsize('P') == 8; assert sys.prefix == '/usr'; assert ssl.create_default_context().cert_store_stats()['x509_ca'] > 0; print('Python root ABI and dependencies OK')",
            ]);
            assert.deepEqual(abi.status, { success: true, code: 0, signal: null });
            assert.equal(
              new TextDecoder().decode(abi.stdout),
              "Python root ABI and dependencies OK\n",
            );
            assert.equal(abi.stderr.byteLength, 0);
            if (phase === "write") {
              await agent.fs.writeFile("/root/application.pyz", archive);
            } else {
              assert.deepEqual(await agent.fs.readFile("/root/application.pyz"), archive);
            }
            // Both streams are drained concurrently with stdin; binary bytes must
            // survive the SDK transport and the actual published application.
            const input = Uint8Array.from({ length: 65553 }, (_, i) => i & 255);
            await using child = await agent.exec(["python3", "-I", "/root/application.pyz"]);
            const output = new Response(child.stdout).arrayBuffer();
            const errors = new Response(child.stderr).arrayBuffer();
            const writer = child.stdin.getWriter();
            try {
              await writer.write(input);
              await writer.close();
            } finally {
              writer.releaseLock();
            }
            const [stdout, stderr, status] = await Promise.all([output, errors, child.status]);
            assert.deepEqual(status, { success: true, code: 0, signal: null });
            const prefix = new TextEncoder().encode("Linux/Wasm Python example — UTF-8 resource\n");
            const expected = new Uint8Array(prefix.byteLength + input.byteLength);
            expected.set(prefix);
            expected.set(input.slice().reverse(), prefix.byteLength);
            assert.deepEqual(new Uint8Array(stdout), expected);
            assert.equal(stderr.byteLength, 0);
            const sync = await agent.run(["/bin/sync"]);
            assert.deepEqual(sync.status, { success: true, code: 0, signal: null });
            assert.equal(sync.stdout.byteLength, 0);
            assert.equal(sync.stderr.byteLength, 0);
            if (phase === "write") assert.ok(flushes > previousFlushes);
          },
          (line) => process.stderr.write(line),
        );
        closed++;
      });
    }
    assert.equal(closed, 2);
  },
);
