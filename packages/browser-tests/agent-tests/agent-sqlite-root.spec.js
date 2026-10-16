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

test("persists installed wasm64 SQLite through OPFS across page reload", async ({ page }) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));
  await page.goto("/");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  const name = await page.evaluate(() => `sqlite-root-${crypto.randomUUID()}.img`);
  try {
    await expect
      .poll(() => page.evaluate(() => typeof globalThis.runOpfsSqliteRoot))
      .toBe("function");
    expect(
      await page.evaluate((name) => globalThis.runOpfsSqliteRoot("write", name), name),
    ).toEqual({ phase: "write", closed: true });
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => typeof globalThis.runOpfsSqliteRoot))
      .toBe("function");
    // A successful readonly query cannot be substituted with a fresh template.
    await page.route("**/agent-root.ext4", (route) => route.abort());
    expect(await page.evaluate((name) => globalThis.runOpfsSqliteRoot("read", name), name)).toEqual(
      { phase: "read", closed: true },
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
