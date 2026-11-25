// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { chromium } from "playwright";
import { FAIL, PASS } from "./protocol.js";

assert.equal(process.argv[2], "chromium", "9P browser check requires Chromium");
const { addressBits, cpus } = JSON.parse(await readFile("profile.json", "utf8"));
assert.ok(addressBits === 32 || addressBits === 64, "invalid 9P address width");
assert.equal(cpus, 1, "invalid 9P CPU profile");

const stages = [
  "9p transport: mounted 9P2000.L over a vsock file descriptor",
  "9p transport: listed remote directory",
  "9p transport: read exact remote file bytes",
  "9p transport: created, wrote, appended and reopened exact remote file bytes",
  "9p transport: linked, shared writes and unlinked an exact alias",
  "9p transport: preserved signed seconds and nanosecond timestamps",
  "9p transport: preserved user extended attributes",
  "9p transport: created, used and removed a standard named pipe",
  "9p transport: unmounted remote filesystem",
  PASS,
];

const server = spawn(process.execPath, ["server.js"], { stdio: ["ignore", "pipe", "inherit"] });
const lines = createInterface({ input: server.stdout });
const serverDied = new Promise((_, reject) => {
  server.once("error", reject);
  server.once("exit", (code, signal) =>
    reject(new Error(`9P browser server exited: ${code}, ${signal}`)),
  );
});
const { promise: serverReady, resolve: listen } = Promise.withResolvers();
lines.on("line", (line) => {
  const address = /^Listening on (http:\/\/127\.0\.0\.1:\d+)$/.exec(line);
  if (address) listen(address[1]);
});
const deadline = AbortSignal.timeout(300_000);
const watchdog = new Promise((_, reject) => {
  deadline.addEventListener("abort", () => reject(new Error("9P browser watchdog expired")), {
    once: true,
  });
});
const errors = [];
let browser;
let stopping = false;
try {
  await Promise.race([
    (async () => {
      const origin = await serverReady;
      browser = await chromium.launch({ headless: true });
      if (stopping) {
        await browser.close();
        return;
      }
      console.log(`9p browser: Chromium ${browser.version()}, wasm${addressBits}, cpus=${cpus}`);
      const page = await browser.newPage();
      page.on("pageerror", (error) => errors.push(error.stack ?? String(error)));
      page.on("crash", () => errors.push("page crashed"));
      await page.goto(origin);
      assert.equal(await page.evaluate(() => crossOriginIsolated), true);
      await page.waitForFunction(() => typeof globalThis.bootNinepRuntimeSmoke === "function");
      for (let iteration = 1; iteration <= 2; ++iteration) {
        const { output, hostBytes } = await page.evaluate(() => globalThis.bootNinepRuntimeSmoke());
        console.log(output);
        const outputLines = output.split("\n");
        assert.deepEqual(
          outputLines.filter((line) => stages.includes(line)),
          stages,
        );
        assert.ok(!outputLines.some((line) => line.startsWith(FAIL)), "Linux reported 9P failure");
        assert.equal(hostBytes, 12546, "in-browser host write verification incomplete");
        assert.deepEqual(errors, [], "browser page errors");
        console.log(`9p browser: iteration ${iteration}, host write and machine shutdown pass`);
      }
    })(),
    serverDied,
    watchdog,
  ]);
} finally {
  stopping = true;
  try {
    if (browser) {
      await browser.close();
      assert.equal(browser.isConnected(), false);
      assert.deepEqual(errors, [], "late browser errors");
    }
  } finally {
    lines.close();
    server.kill();
  }
}
console.log("9p browser: both iterations and browser shutdown pass");
