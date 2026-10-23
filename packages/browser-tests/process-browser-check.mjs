// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { chromium, firefox } from "playwright";
import { assertProcessOutput, processStages } from "./process-contract.js";

const engines = { chromium, firefox };
const project = process.argv[2];
assert.ok(Object.hasOwn(engines, project), "unknown browser engine");
const { addressBits, corpus, cpus = 2 } = JSON.parse(await readFile("profile.json", "utf8"));
assert.ok(addressBits === 32 || addressBits === 64, "invalid address width");
assert.ok(Object.hasOwn(processStages, corpus), "unknown process corpus");
assert.equal(
  cpus,
  ["useraccess", "upper32", "altstack", "stacklegacy"].includes(corpus) ? 1 : 2,
  "CPU profile mismatch",
);
if (corpus === "upper32") assert.equal(addressBits, 32, "upper-half profile requires wasm32");
const server = spawn(process.execPath, ["server.js"], { stdio: ["ignore", "pipe", "inherit"] });
const lines = createInterface({ input: server.stdout });
let browser, timer;
const errors = [];
const serverDied = new Promise((_, reject) => {
  server.once("error", reject);
  server.once("exit", () => reject(new Error("process browser server exited")));
});
void serverDied.catch(() => {});
const watchdog = new Promise((_, reject) => {
  timer = setTimeout(() => reject(new Error("process browser watchdog expired")), 300000);
});
const bounded = async (promise, label) => {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out`)), 15000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
};
try {
  await Promise.race([
    (async () => {
      const origin = await new Promise((resolve) =>
        lines.on("line", (line) => {
          const match = /^Listening on (http:\/\/127\.0\.0\.1:\d+)$/.exec(line);
          if (match) resolve(match[1]);
        }),
      );
      browser = await engines[project].launch({ headless: true });
      console.log(
        `process browser: ${corpus} wasm${addressBits} ${project} ${browser.version()} cpus=${cpus}`,
      );
      const page = await browser.newPage();
      page.on("pageerror", (error) => errors.push(String(error)));
      page.on("crash", () => errors.push("page crashed"));
      await page.goto(origin);
      assert.equal(await page.evaluate(() => crossOriginIsolated), true);
      await page.waitForFunction(() => typeof globalThis.bootProcessRuntimeSmoke === "function");
      for (let iteration = 1; iteration <= 2; iteration++) {
        const output = await page.evaluate(() => globalThis.bootProcessRuntimeSmoke());
        console.log(output);
        assertProcessOutput(output, corpus);
        assert.deepEqual(errors, []);
        // runRuntimeSmoke resolves only after machine.closed and drained consoles.
        console.log(`process browser: ${corpus} iteration ${iteration} and machine shutdown pass`);
      }
    })(),
    serverDied,
    watchdog,
  ]);
} finally {
  clearTimeout(timer);
  try {
    if (browser) {
      await bounded(browser.close(), "browser close");
      assert.equal(browser.isConnected(), false);
      assert.deepEqual(errors, [], "late browser errors");
    }
  } finally {
    lines.close();
    const exited = new Promise((resolve) => server.once("exit", resolve));
    if (server.exitCode === null && server.signalCode === null) {
      server.kill();
      try {
        await bounded(exited, "server close");
      } catch (error) {
        server.kill("SIGKILL");
        throw error;
      }
    }
  }
}
console.log(`process browser: ${corpus} both iterations and browser shutdown pass`);
