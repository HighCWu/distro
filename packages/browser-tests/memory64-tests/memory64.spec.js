import { expect, test } from "@playwright/test";

test("boots the Memory64 kernel", async ({ page }) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));

  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.bootMemory64Smoke))
    .toBe("function");
  const output = await page.evaluate(() => globalThis.bootMemory64Smoke());

  expect(output).toContain("Linux version");
});
