// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

export async function browserBoot({ engine, caseId, prefix, origin, engines }) {
  let browser, timer, closeTimer;
  const errors = [],
    consoleErrors = [];
  let result;
  try {
    result = await Promise.race([
      (async () => {
        browser = await engines[engine].launch({ headless: true, timeout: 30000 });
        const browserVersion = browser.version();
        const page = await browser.newPage();
        page.on("pageerror", (error) => errors.push(error.stack ?? String(error)));
        page.on("crash", () => errors.push("renderer crashed"));
        page.on("console", (message) => {
          if (message.type() === "error") consoleErrors.push(message.text());
        });
        await page.goto(origin, { waitUntil: "load", timeout: 30000 });
        await page.waitForFunction(
          () => typeof globalThis.runForkLatency === "function",
          {},
          { timeout: 30000 },
        );
        const pageEnvironment = await page.evaluate(() => ({
          crossOriginIsolated,
          hardwareConcurrency: navigator.hardwareConcurrency,
          userAgent: navigator.userAgent,
        }));
        assert.equal(pageEnvironment.crossOriginIsolated, true);
        const b = await page.evaluate((caseId) => globalThis.runForkLatency(caseId), caseId);
        writeFileSync(
          prefix + ".partial.json",
          JSON.stringify({ ...b, browserVersion, pageEnvironment }) + "\n",
        );
        assert.deepEqual(errors, []);
        assert.deepEqual(consoleErrors, []);
        assert.equal(b.closed, true);
        return { ...b, browserVersion, pageEnvironment };
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error(`browser latency watchdog: ${engine} ${caseId}`)),
          150000,
        );
      }),
    ]);
  } catch (error) {
    errors.push(error.stack ?? String(error));
    throw error;
  } finally {
    clearTimeout(timer);
    try {
      if (browser)
        await Promise.race([
          browser.close(),
          new Promise((_, reject) => {
            closeTimer = setTimeout(() => reject(Error("browser close watchdog")), 15000);
          }),
        ]);
    } catch (error) {
      errors.push(error.stack ?? String(error));
      throw error;
    } finally {
      clearTimeout(closeTimer);
      writeFileSync(prefix + ".stderr", [...errors, ...consoleErrors].join("\n"));
    }
  }
  assert.ok(browser && !browser.isConnected(), "browser process did not close");
  assert.deepEqual(errors, []);
  assert.deepEqual(consoleErrors, []);
  const final = { ...result, browserClosed: true };
  writeFileSync(prefix + ".stdout", JSON.stringify(final) + "\n");
  return final;
}
