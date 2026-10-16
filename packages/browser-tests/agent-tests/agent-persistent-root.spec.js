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

test("persists native wasm64 ext4 root through OPFS across page reload", async ({ page }) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));
  await page.goto("/");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  const name = await page.evaluate(() => `native-root-${crypto.randomUUID()}.img`);
  try {
    await expect
      .poll(() => page.evaluate(() => typeof globalThis.runOpfsNativeRoot))
      .toBe("function");
    expect(
      await page.evaluate((name) => globalThis.runOpfsNativeRoot("write", name), name),
    ).toEqual({
      phase: "write",
      closed: true,
    });
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => typeof globalThis.runOpfsNativeRoot))
      .toBe("function");
    // No root template fetch or replacement is allowed after the reload.
    await page.route("**/agent-root.ext4", (route) => route.abort());
    expect(await page.evaluate((name) => globalThis.runOpfsNativeRoot("read", name), name)).toEqual(
      {
        phase: "read",
        closed: true,
      },
    );
  } finally {
    await page.evaluate(async (name) => {
      const directory = await navigator.storage.getDirectory();
      await directory.removeEntry(name).catch((error) => {
        if (error.name !== "NotFoundError") throw error;
      });
    }, name);
  }
});
