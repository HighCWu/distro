// SPDX-License-Identifier: MIT
import { expect, test } from "@playwright/test";

test("runs Python Git SQLite collaboration across fresh browser wasm64 roots", async ({ page }) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));
  await page.goto("/");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.runNativePythonGitRoot))
    .toBe("function");
  const result = await page.evaluate(() => globalThis.runNativePythonGitRoot());
  expect(result).toEqual({
    passed: [
      "Python Git workspace write through public SDK",
      "Python Git workspace read through public SDK",
    ],
    closed: true,
  });
});
