// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../src/run.ts", import.meta.url));

async function run(args: string[], fault?: "terminate" | "kernel") {
  // Exiting a failed entry module alone does not prove Worker teardown. Record
  // the actual close message and Worker.terminate calls in the child process.
  const monitor = `
    import fs from "node:fs/promises";
    import { writeSync } from "node:fs";
    import { isMainThread, Worker } from "node:worker_threads";
    const fault = ${JSON.stringify(fault ?? null)};
    if (isMainThread) {
      const ids = new WeakMap();
      let next = 0;
      const mark = (worker, operation) => {
        if (!ids.has(worker)) ids.set(worker, ++next);
        writeSync(2, "disk startup: " + operation + ":" + ids.get(worker) + "\\n");
      };
      const postMessage = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (message, ...args) {
        if (message?.type === "close") mark(this, "close");
        return postMessage.call(this, message, ...args);
      };
      const terminate = Worker.prototype.terminate;
      Worker.prototype.terminate = async function (...args) {
        mark(this, "terminate");
        const result = await terminate.apply(this, args);
        if (fault === "terminate") throw new Error("injected termination failure");
        return result;
      };
      if (fault === "kernel") {
        const readFile = fs.readFile;
        fs.readFile = (path, ...args) =>
          path instanceof URL && path.pathname.endsWith("/vmlinux.wasm")
            ? Promise.reject(new Error("injected kernel load failure"))
            : readFile(path, ...args);
      }
    }
  `;
  const preload = `data:text/javascript;base64,${Buffer.from(monitor).toString("base64")}`;
  const child = spawn(process.execPath, ["--import", preload, runner, "--no-console", ...args], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    const [code, signal] = await once(child, "close");
    assert.equal(signal, null, stderr);
    assert.equal(code, 1, stderr);
    return {
      stderr,
      events: Array.from(stderr.matchAll(/^disk startup: (.+)$/gm), (match) => match[1]),
    };
  } finally {
    clearTimeout(watchdog);
  }
}

test("runner rolls back its disk Workers on startup failure", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "linux-runner-startup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const disk = join(directory, "valid.img");
  await writeFile(disk, new Uint8Array(512));

  await t.test(
    "a later HTTP disk failure closes the first Worker and preserves its own error",
    async (t) => {
      const server = createServer((_request, response) =>
        response.writeHead(200).end("not a range"),
      );
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      t.after(
        () =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      );
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const result = await run(
        ["--disk", disk, "--disk", `http://127.0.0.1:${address.port}/image`],
        "terminate",
      );
      assert.match(result.stderr, /HTTP disk expected status 206, received 200/);
      assert.doesNotMatch(result.stderr, /injected termination failure/);
      assert.deepEqual(result.events, ["terminate:1", "close:2", "terminate:2"]);
    },
  );

  await t.test("a boot rejection before device configuration leaves no disk Worker", async () => {
    const result = await run(["--disk", disk, "--cpus", "0"]);
    assert.match(result.stderr, /cpus must be an integer/);
    assert.deepEqual(result.events, ["close:1", "terminate:1"]);
  });

  await t.test("a boot rejection after configuration closes each disk once", async () => {
    const result = await run(["--disk", disk, "--cpus", "1"], "kernel");
    assert.match(result.stderr, /injected kernel load failure/);
    assert.deepEqual(result.events, ["close:1", "terminate:1"]);
  });
});
