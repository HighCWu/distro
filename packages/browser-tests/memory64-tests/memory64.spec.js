import { expect, test } from "@playwright/test";

test("runs Memory64 musl allocation, mmap, threads, TLS and signals", async ({ page }) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));

  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.bootMemory64Smoke))
    .toBe("function");
  const output = await page.evaluate(() => globalThis.bootMemory64Smoke());

  expect(output).toContain("::vm-test::pass");
  expect(output).not.toContain("::vm-test::fail");
});
