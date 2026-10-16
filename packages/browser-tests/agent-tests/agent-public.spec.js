// SPDX-License-Identifier: MIT
import { expect, test } from "@playwright/test";

test("boots native wasm64 through public guestAgent image selection", async ({ page }) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));
  await page.goto("/");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.runPublicNativeAgent))
    .toBe("function");
  const result = await page.evaluate(() => globalThis.runPublicNativeAgent());
  expect(result.passed).toEqual([
    "public plugin completes root pivot before exposing capabilities",
    "public file API retains native seek, metadata and truncate behavior",
    "public run collects native status and forwards process options",
  ]);
  expect(result.closed).toBe(true);
});
