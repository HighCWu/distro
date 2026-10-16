// SPDX-License-Identifier: MIT
import { expect } from "@playwright/test";

export async function checkPublicAgent(page, userland = false, networking = false) {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));
  await page.goto("/");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.runPublicNativeAgent))
    .toBe("function");
  const result = await page.evaluate((options) => globalThis.runPublicNativeAgent(options), {
    userland,
    networking,
  });
  expect(result.passed).toEqual([
    "public plugin completes root pivot before exposing capabilities",
    "public file API retains native seek, metadata and truncate behavior",
    "public run collects native status and forwards process options",
    ...(userland
      ? [
          "public run executes native shell pipelines and child lifecycle",
          "public exec streams binary data through native shell pipelines",
        ]
      : []),
    ...(networking ? ["public network reaches a native HTTP server over the attached NIC"] : []),
  ]);
  expect(result.closed).toBe(true);
}
