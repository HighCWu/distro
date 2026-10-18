// SPDX-License-Identifier: MIT
// The same application and byte-level checks run under Node and browsers.
import { blockDevice } from "@lowland/kernel";
import { SystemError } from "../src/index.ts";
import { withPersistentRootMachine } from "./agent-wasm64-persistent-root-suite.ts";
import type { RuntimeAssertions } from "./agent-wasm64-suite.ts";

export async function runPythonGitRootWasm64Suite(
  boot: Uint8Array,
  root: Uint8Array,
  source: Uint8Array,
  assert: RuntimeAssertions,
  runCase: (name: string, body: () => Promise<void>) => Promise<void>,
  writeLine: (line: string) => void,
) {
  const script = "/root/workspace-example.py";
  const directory = "/root/workspace ' $HOME → data";
  const payload = Uint8Array.from({ length: 65553 }, (_, index) => index & 255);
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", payload)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const passed: string[] = [];
  let head: string | undefined;
  let closed = 0,
    writes = 0,
    flushes = 0;
  for (const phase of ["write", "read"] as const) {
    const title = `Python Git workspace ${phase} through public SDK`;
    await runCase(title, async () => {
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
          assert.equal(/^sizeof-long: 8$/m.test(new TextDecoder().decode(git.stdout)), true);
          assert.equal(/^sizeof-size_t: 8$/m.test(new TextDecoder().decode(git.stdout)), true);
          for (const path of [
            "/share/licenses/python/readline-COPYING",
            "/usr/share/licenses/git/git-COPYING",
            "/usr/share/licenses/git/linked/openssl-LICENSE.txt",
          ]) {
            assert.equal((await agent.fs.readFile(path)).byteLength > 0, true);
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
          assert.equal(typeof report.head === "string" && /^[0-9a-f]{40}$/.test(report.head), true);
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
          assert.equal(writes > previousWrites && flushes > previousFlushes, true);
        },
        writeLine,
      );
      closed++;
    });
    passed.push(title);
  }
  assert.equal(closed, 2);
  return { passed, closed: true };
}
