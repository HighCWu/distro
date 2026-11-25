// SPDX-License-Identifier: MIT
import { expect } from "@playwright/test";

export async function checkPublicAgent(page, userland = false, networking = false, wisp = false) {
  const logConsole = (message) => console.log(`[browser] ${message.text()}`);
  const logError = (error) => console.error(`[browser] ${error.stack ?? error}`);
  page.on("console", logConsole);
  page.on("pageerror", logError);
  let result;
  try {
    await page.goto("/");
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    await expect
      .poll(() => page.evaluate(() => typeof globalThis.runPublicNativeAgent))
      .toBe("function");
    result = await page.evaluate((options) => globalThis.runPublicNativeAgent(options), {
      userland,
      networking,
      wisp,
    });
  } finally {
    page.off("console", logConsole);
    page.off("pageerror", logError);
  }
  expect(result.passed).toEqual([
    "public plugin completes root pivot before exposing capabilities",
    "public file API retains native seek, metadata and truncate behavior",
    "public run collects native status and forwards process options",
    ...(userland
      ? [
          "public run executes native shell pipelines and child lifecycle",
          "public exec streams binary data through native shell pipelines",
          "public exec rejects stdin after process disposal",
        ]
      : []),
    ...(networking ? ["public network reaches a native HTTP server over the attached NIC"] : []),
    ...(wisp ? ["native wget resolves a name and receives exact bytes over Wisp"] : []),
  ]);
  expect(result.closed).toBe(true);
  console.log("public agent machine and devices closed");
}
