// SPDX-License-Identifier: MIT
import { expect, test } from "@playwright/test";

test("EROFS copies survive clone, exit, concurrent reads and source unmount", async ({ page, browser }) => {
  test.setTimeout(300_000);
  console.log(`browser version: ${browser.version()}`);
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));
  await page.goto("/");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await expect.poll(() => page.evaluate(() => typeof globalThis.runErofsCopies)).toBe("function");
  const result = await page.evaluate(() => globalThis.runErofsCopies());
  expect(result.passed).toBe(true);
  expect(result.output).toContain("::vm-test::pass");
  expect(result.output).not.toContain("::vm-test::fail");
  expect(result.machineClosed).toBe(true);
});
