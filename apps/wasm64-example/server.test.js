// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { bundleManifest } from "./integrity.mjs";

for (const externalLauncher of [false, true])
  test(
    `example server verifies the bundle before supplying isolation and MIME headers (${externalLauncher ? "external test launcher" : "direct"})`,
    { timeout: 10000 },
    async () => {
      const temporary = mkdtempSync(join(tmpdir(), "wasm64-example-server-"));
      const root = join(temporary, "public");
      mkdirSync(root);
      copyFileSync(new URL("./server.mjs", import.meta.url), join(root, "server.mjs"));
      copyFileSync(new URL("./integrity.mjs", import.meta.url), join(root, "integrity.mjs"));
      writeFileSync(join(root, "index.html"), "example page");
      writeFileSync(join(root, "module.wasm"), new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
      writeFileSync(join(temporary, "outside"), "must not be served");
      writeFileSync(join(root, "checksums.json"), JSON.stringify(await bundleManifest(root)));
      const suite = join(temporary, "suite");
      mkdirSync(suite);
      // Match the Nix suite: the launcher and test-only links must not be served
      // or included in the installed application's integrity inventory.
      symlinkSync(join(temporary, "outside"), join(suite, "test-only-link"));
      const launcher = join(suite, "server.mjs");
      writeFileSync(
        launcher,
        `import ${JSON.stringify(pathToFileURL(join(root, "server.mjs")).href)};\n`,
      );
      const child = spawn(
        process.execPath,
        [externalLauncher ? launcher : join(root, "server.mjs")],
        {
          cwd: suite,
          env: { ...process.env, PORT: "0" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
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
              if (!/Verified \d+ bundle files \(SHA-256\)/.test(output)) {
                reject(new Error("server listened without bundle verification"));
                return;
              }
              resolve(match[1]);
            }
          });
          child.once("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`server exited: ${code}`));
          });
        });
        // Startup validation is not a filesystem snapshot or ongoing attestation.
        // The HTTP path guard must also reject a link added after verification.
        symlinkSync(join(temporary, "outside"), join(root, "escape"));
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
          ["/test-only-link", 404],
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

for (const fault of ["no-manifest", "modified", "missing", "extra", "invalid-manifest", "symlink"])
  test(`example server refuses ${fault} bundles before listening`, { timeout: 10000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "wasm64-example-invalid-"));
    let child;
    try {
      for (const name of ["server.mjs", "integrity.mjs"])
        copyFileSync(new URL(`./${name}`, import.meta.url), join(root, name));
      writeFileSync(join(root, "index.html"), "original page");
      if (fault !== "no-manifest")
        writeFileSync(join(root, "checksums.json"), JSON.stringify(await bundleManifest(root)));
      if (fault === "modified") writeFileSync(join(root, "index.html"), "modified page");
      if (fault === "missing") rmSync(join(root, "index.html"));
      if (fault === "extra") writeFileSync(join(root, "extra"), "unexpected file");
      if (fault === "invalid-manifest") writeFileSync(join(root, "checksums.json"), "{}");
      if (fault === "symlink") symlinkSync("index.html", join(root, "alias.html"));
      child = spawn(process.execPath, [join(root, "server.mjs")], {
        env: { ...process.env, PORT: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (data) => {
        stdout += data;
      });
      child.stderr.on("data", (data) => {
        stderr += data;
      });
      const [code, signal] = await once(child, "close", { signal: AbortSignal.timeout(5000) });
      assert.equal(code, 1);
      assert.equal(signal, null);
      assert.doesNotMatch(stdout, /Listening on/);
      assert.match(stderr, /Bundle verification failed:/);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
