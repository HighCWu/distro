// SPDX-License-Identifier: MIT
import { expect, test } from "@playwright/test";

test("boots the fixture-free native wasm64 minimal system root", async ({ page }) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));
  await page.goto("/");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.runMinimalNativeRoot))
    .toBe("function");
  const result = await page.evaluate(() => globalThis.runMinimalNativeRoot());
  expect(result.passed).toEqual([
    "minimal root provides native identity and live mount metadata",
    "minimal root contains license texts but no runtime fixtures",
    "minimal root runs native BusyBox with exact binary file output",
    "minimal root runs its installed native shell in the default cwd",
  ]);
  expect(result.closed).toBe(true);
});
