// SPDX-License-Identifier: MIT
import { expect, test } from "@playwright/test";

test("runs installed wasm64 SQLite across fresh browser ext4 root instances", async ({ page }) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));
  await page.goto("/");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.runNativeSqliteRoot))
    .toBe("function");
  const result = await page.evaluate(() => globalThis.runNativeSqliteRoot());
  expect(result.passed).toEqual([
    "native wasm64 SQLite commits and rolls back on ext4",
    "fresh native wasm64 SQLite verifies persisted database integrity and fields",
  ]);
  expect(result.closed).toBe(true);
});
