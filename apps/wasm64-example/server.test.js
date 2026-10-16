// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test(
  "example server supplies isolation and MIME headers without building missing assets",
  { timeout: 10000 },
  async () => {
    const temporary = mkdtempSync(join(tmpdir(), "wasm64-example-server-"));
    const root = join(temporary, "public");
    mkdirSync(root);
    copyFileSync(new URL("./server.mjs", import.meta.url), join(root, "server.mjs"));
    writeFileSync(join(root, "index.html"), "example page");
    writeFileSync(join(root, "module.wasm"), new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    writeFileSync(join(temporary, "outside"), "must not be served");
    symlinkSync(join(temporary, "outside"), join(root, "escape"));
    const child = spawn(process.execPath, [join(root, "server.mjs")], {
      env: { ...process.env, PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const base = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("server readiness timed out")), 5000);
        child.once("error", reject);
        let output = "";
        child.stdout.on("data", (chunk) => {
          output += chunk;
          const match = output.match(/Listening on (http:\/\/127\.0\.0\.1:\d+)/);
          if (match) {
            clearTimeout(timer);
            resolve(match[1]);
          }
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`server exited: ${code}`));
        });
      });
      const index = await fetch(base);
      assert.equal(index.status, 200);
      assert.equal(index.headers.get("cross-origin-opener-policy"), "same-origin");
      assert.equal(index.headers.get("cross-origin-embedder-policy"), "require-corp");
      assert.equal(index.headers.get("content-type"), "text/html; charset=utf-8");
      assert.equal(await index.text(), "example page");
      const head = await fetch(`${base}/module.wasm`, { method: "HEAD" });
      assert.equal(head.headers.get("content-type"), "application/wasm");
      assert.equal(head.headers.get("content-length"), "8");
      assert.equal((await head.arrayBuffer()).byteLength, 0);
      for (const [path, status] of [
        ["/root.ext4", 404],
        ["/node_modules/", 404],
        ["/%", 400],
        ["/..%2foutside", 403],
        ["/escape", 403],
      ]) {
        const result = await fetch(`${base}${path}`);
        assert.equal(result.status, status, path);
        await result.arrayBuffer();
      }
      const method = await fetch(base, { method: "POST" });
      assert.equal(method.status, 405);
      await method.arrayBuffer();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
      rmSync(temporary, { recursive: true, force: true });
    }
  },
);
