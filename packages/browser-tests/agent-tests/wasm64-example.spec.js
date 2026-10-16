// SPDX-License-Identifier: MIT
import { expect, test } from "@playwright/test";

test("embeds native wasm64 Linux using the standalone example controls", async ({ page }) => {
  page.on("pageerror", (error) => console.error(error.stack ?? error));
  await page.goto("/");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  const state = page.locator("#state");
  await page.locator("#start").click();
  await expect(state).toHaveText("running", { timeout: 120000 });
  await page.locator("#uname").click();
  await expect(state).toHaveText("running");
  await expect(page.locator("#result")).toContainText("Linux ");
  const text = "Native wasm64 file API → BusyBox cat\nexact UTF-8 content\n";
  await page.locator("#contents").fill(text);
  await page.locator("#file").click();
  await expect(state).toHaveText("running");
  await expect(page.locator("#result")).toHaveText(text);
  expect(await page.locator("#result").textContent()).toBe(text);
  await page.locator("#stop").click();
  await expect(state).toHaveText("stopped");
  await expect(page.locator("#uname")).toBeDisabled();
  await page.locator("#start").click();
  await expect(state).toHaveText("running", { timeout: 120000 });
  // A new start really uses a fresh disk, not just an empty output panel.
  await page.locator("#read").click();
  await expect(state).toContainText("error: native command failed");
  await expect(page.locator("#result")).toContainText("No such file or directory");
  await page.locator("#uname").click();
  await expect(state).toHaveText("running");
  await expect(page.locator("#result")).toContainText("Linux ");
  await page.locator("#stop").click();
  await expect(state).toHaveText("stopped");
});
