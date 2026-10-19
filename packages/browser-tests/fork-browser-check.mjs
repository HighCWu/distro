// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { chromium, firefox } from "playwright";
import { assertForkOutput } from "./fork-contract.js";

const project = process.argv[2];
const engines = { chromium, firefox };
assert.ok(Object.hasOwn(engines, project), "unsupported browser project");
const { addressBits } = JSON.parse(await readFile("profile.json", "utf8"));
assert.ok(addressBits === 32 || addressBits === 64, "invalid address width");

const server = spawn(process.execPath, ["server.js"], { stdio: ["ignore", "pipe", "inherit"] });
const lines = createInterface({ input: server.stdout });
let browser;
let timer;
let serverFailure;
const watchdog = new Promise((_, reject) => {
  timer = setTimeout(() => reject(new Error("fork browser check watchdog expired")), 300_000);
});
const serverDied = new Promise((_, reject) => {
  server.once("error", reject);
  server.once("exit", (code, signal) => {
    serverFailure = new Error(`browser server exited: ${code}, ${signal}`);
    reject(serverFailure);
  });
});
void serverDied.catch(() => {});
try {
  await Promise.race([
    (async () => {
      const origin = await new Promise((resolve) => {
        lines.on("line", (line) => {
          const match = /^Listening on (http:\/\/127\.0\.0\.1:\d+)$/.exec(line);
          if (match) resolve(match[1]);
        });
      });
      browser = await engines[project].launch({ headless: true });
      console.log(`fork browser: ${project} ${browser.version()}, wasm${addressBits}`);
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.stack ?? String(error)));
      page.on("console", (message) => console.log(`[browser] ${message.text()}`));
      await page.goto(origin);
      assert.equal(await page.evaluate(() => crossOriginIsolated), true);
      await page.waitForFunction(() => typeof globalThis.bootForkRuntimeSmoke === "function");
      // runRuntimeSmoke resolves only AFTER machine.closed and final console
      // callbacks. Repeating on the same page exercises fresh Worker lifetimes.
      for (const mode of ["normal", "faults"]) {
        for (let iteration = 1; iteration <= 2; iteration++) {
          const output = await page.evaluate((mode) => globalThis.bootForkRuntimeSmoke(mode), mode);
          console.log(output);
          assertForkOutput(output, mode);
          assert.deepEqual(errors, [], "browser page errors");
          console.log(
            `fork browser: wasm${addressBits} ${mode} iteration ${iteration} and shutdown pass`,
          );
        }
      }
      if (serverFailure) throw serverFailure;
    })(),
    watchdog,
    serverDied,
  ]);
} finally {
  clearTimeout(timer);
  try {
    await browser?.close();
  } finally {
    lines.close();
    server.kill();
  }
}
