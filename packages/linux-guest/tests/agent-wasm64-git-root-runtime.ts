// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { blockDevice } from "@lowland/kernel";
import { SystemError } from "../src/index.ts";
import { withPersistentRootMachine } from "./agent-wasm64-persistent-root-suite.ts";
import { verifyGitApplication } from "./agent-wasm64-git-commands.ts";

test(
  "runs installed wasm64 Git across fresh ext4 root instances",
  { timeout: 180_000 },
  async (t) => {
    const imagePath = process.env.AGENT_WASM64_BOOT_DISK;
    const rootPath = process.env.AGENT_WASM64_ROOTFS;
    assert.ok(imagePath && rootPath, "select native boot and optional Git ext4 root");
    const image = readFileSync(imagePath);
    const root = new Uint8Array(readFileSync(rootPath));
    let closed = 0;
    let writes = 0;
    let flushes = 0;
    let head: string | undefined;
    for (const phase of ["write", "read"] as const) {
      await t.test(`Git application ${phase} through public SDK`, async () => {
        assert.equal(closed, phase === "write" ? 0 : 1);
        const previousWrites = writes;
        const previousFlushes = flushes;
        await withPersistentRootMachine(
          image,
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
          assert,
          async (agent) => {
            for (const path of [
              "/git-runtime-check.sh",
              "/git-notice-check.sh",
              "/git-address-bits",
              "/vm-test-setup-dev-fd",
              "/bin/agent-runtime-child",
              "/etc/agent-runtime-root",
            ]) {
              await assert.rejects(
                agent.fs.stat(path),
                (error) => error instanceof SystemError && error.code === "ENOENT",
              );
            }
            const options = await agent.run(["git", "version", "--build-options"]);
            assert.deepEqual(options.status, { success: true, code: 0, signal: null });
            assert.equal(options.stderr.byteLength, 0);
            const text = new TextDecoder().decode(options.stdout);
            assert.match(text, /^git version 2\.55\.0$/m);
            assert.match(text, /^sizeof-long: 8$/m);
            assert.match(text, /^sizeof-size_t: 8$/m);
            assert.doesNotMatch(text, /\/nix\/store\//);
            for (const name of [
              "git-COPYING",
              "sha1dc-LICENSE.txt",
              "reftable-LICENSE",
              "linked/openssl-LICENSE.txt",
              "linked/musl-COPYRIGHT",
              "linked/compiler-rt-LICENSE.TXT",
            ]) {
              assert.ok(
                (await agent.fs.readFile(`/usr/share/licenses/git/${name}`)).byteLength > 0,
              );
            }
            const notices = await agent.run(["sha256sum", "-c", "SHA256SUMS"], {
              cwd: "/usr/share/licenses/git",
            });
            assert.deepEqual(notices.status, { success: true, code: 0, signal: null });
            assert.equal(notices.stderr.byteLength, 0);
            assert.ok((await agent.fs.readFile("/etc/ssl/cert.pem")).byteLength > 0);
            head = await verifyGitApplication(agent, "/root", phase, head, assert);
            const sync = await agent.run(["/bin/sync"]);
            assert.deepEqual(sync.status, { success: true, code: 0, signal: null });
            assert.equal(sync.stdout.byteLength, 0);
            assert.equal(sync.stderr.byteLength, 0);
            assert.ok(writes > previousWrites);
            assert.ok(flushes > previousFlushes);
          },
          (line) => process.stderr.write(line),
        );
        closed++;
      });
    }
    assert.equal(closed, 2);
  },
);
