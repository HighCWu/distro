// SPDX-License-Identifier: MIT
import { expect, test } from "@playwright/test";

for (const [scenario, title] of [
  ["copies", "EROFS copies survive clone, exit, concurrent reads and source unmount"],
  ["errors", "EROFS real EIO and valid-prefix errors roll back without publishing a partial copy"],
]) {
  test(title, async ({ page, browser }) => {
    test.setTimeout(300_000);
    console.log(`browser version: ${browser.version()}, scenario: ${scenario}`);
    page.on("console", (message) => console.log(`[browser] ${message.text()}`));
    page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));
    await page.goto("/");
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    await expect.poll(() => page.evaluate(() => typeof globalThis.runErofsCopies)).toBe("function");
    const result = await page.evaluate((name) => globalThis.runErofsCopies(name), scenario);
    expect(result.scenario).toBe(scenario);
    expect(result.passed).toBe(true);
    expect(result.output).toContain("::vm-test::pass");
    expect(result.output).not.toContain("::vm-test::fail");
    expect(result.machineClosed).toBe(true);
  });
}
