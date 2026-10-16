// SPDX-License-Identifier: MIT
import { expect, test } from "@playwright/test";

test("runs native wasm64 agent sessions, files, processes and cleanup", async ({ page }) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));
  await page.goto("/");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await expect.poll(() => page.evaluate(() => typeof globalThis.runNativeAgent)).toBe("function");
  const result = await page.evaluate(() => globalThis.runNativeAgent());
  expect(result.passed).toEqual([
    "native executor rejects legacy v3 and explicit wasm32 identity",
    "native seek exceeds 4 GiB; truncate and stat round-trip file bytes",
    "unlink and recreate retain distinct open descriptor metadata and bytes",
    "native program receives argv, cwd, env and streams binary stdio",
    "native nonzero exit and SIGTERM have distinct wait statuses",
    "closing a native session kills and reaps its running program before reconnect",
  ]);
  expect(result.closed).toBe(true);
});
