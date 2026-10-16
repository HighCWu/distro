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

test("retries a failed kernel download in the same page with a generic MIME type", async ({
  page,
}) => {
  let requests = 0;
  await page.route("**/vmlinux.wasm", async (route) => {
    requests++;
    if (requests === 1) {
      await route.fulfill({ status: 503, contentType: "text/plain", body: "temporary failure" });
      return;
    }
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    await route.fulfill({
      response,
      headers: { ...response.headers(), "content-type": "application/octet-stream" },
    });
  });
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.bootMemory64Smoke))
    .toBe("function");
  const failure = await page.evaluate(async () => {
    try {
      await globalThis.bootMemory64Smoke();
      return "unexpected success";
    } catch (error) {
      return String(error);
    }
  });
  expect(failure).toContain("HTTP 503");
  expect(requests).toBe(1);
  // Do not reload: this must use the same imported kernel module and its cache.
  const output = await page.evaluate(() => globalThis.bootMemory64Smoke());
  expect(requests).toBe(2);
  expect(output).toContain("::vm-test::pass");
  expect(output).not.toContain("::vm-test::fail");
});
