// SPDX-License-Identifier: MIT
import { expect, test } from "@playwright/test";

test("embeds native wasm64 Linux using the standalone example controls", async ({ page }) => {
  page.on("pageerror", (error) => console.error(error.stack ?? error));
  // A missing hosting prerequisite is reported before downloading either disk.
  const diskRequests = [];
  const observeDisk = (request) => {
    if (/\/(agent-boot\.img|root\.ext4)$/.test(new URL(request.url()).pathname))
      diskRequests.push(request.url());
  };
  const withoutIsolation = async (route) => {
    const response = await route.fetch();
    const headers = response.headers();
    delete headers["cross-origin-embedder-policy"];
    await route.fulfill({ response, headers });
  };
  page.on("request", observeDisk);
  await page.route("**/", withoutIsolation);
  await page.goto("/");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);
  await page.locator("#start").click();
  await expect(page.locator("#state")).toContainText(
    "COOP/COEP cross-origin isolation is required",
  );
  await expect(page.locator("#start")).toBeEnabled();
  expect(diskRequests).toEqual([]);
  await page.unroute("**/", withoutIsolation);
  page.off("request", observeDisk);
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
  // Import a separately SDK-built executable through the actual file picker,
  // not a program installed into the default root or a JavaScript callback.
  const binary = await page.request.get("/upload-program.wasm");
  expect(binary.ok()).toBe(true);
  await page.locator("#program").setInputFiles({
    name: "developer-program.wasm",
    mimeType: "application/wasm",
    buffer: await binary.body(),
  });
  await page.locator("#arguments").fill('["literal $HOME → wasm64"]');
  await page.locator("#run-program").click();
  await expect(state).toHaveText("running");
  await expect(page.locator("#result")).toContainText(
    "uploaded application: literal $HOME → wasm64\n",
  );
  await expect(page.locator("#result")).toContainText("uploaded application stderr\n");
  await page.locator("#arguments").fill('["fail"]');
  await page.locator("#run-program").click();
  await expect(state).toContainText('"code":37');
  await expect(page.locator("#result")).toContainText("uploaded application expected failure");
  await page.locator("#arguments").fill('["wait"]');
  await page.locator("#run-program").click();
  await expect(page.locator("#result")).toContainText("uploaded application waiting");
  await page.locator("#cancel-program").click();
  await expect(state).toContainText("application cancelled");
  await expect(page.locator("#cancel-program")).toBeDisabled();
  await page.locator("#uname").click();
  await expect(state).toHaveText("running");
  await expect(page.locator("#result")).toContainText("Linux ");
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
