// SPDX-License-Identifier: MIT
import { expect, test } from "@playwright/test";

test("persists native wasm64 ext4 root data across fresh browser machines", async ({ page }) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));
  await page.goto("/");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.runPersistentNativeRoot))
    .toBe("function");
  const result = await page.evaluate(() => globalThis.runPersistentNativeRoot());
  expect(result.passed).toEqual([
    "native ext4 root writes and flushes binary data through public APIs",
    "fresh native Linux instance reads persisted ext4 bytes and metadata",
  ]);
  expect(result.closed).toBe(true);
});
