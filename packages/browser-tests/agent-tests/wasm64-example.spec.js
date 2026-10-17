// SPDX-License-Identifier: MIT
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

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
  const savePreparedFile = async (name, bytes) => {
    const pending = page.waitForEvent("download");
    await page.locator("#download-link").click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe(name);
    expect(await download.failure()).toBeNull();
    expect(await readFile(await download.path())).toEqual(bytes);
  };
  await page.locator("#download").click();
  await expect(state).toHaveText("running");
  await expect(page.locator("#download-link")).toBeVisible();
  await savePreparedFile("example.txt", Buffer.from(text));
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
  const standardInput = "Text stdin → native wasm64 filter\nUTF-8: 中文 €\n";
  await page.locator("#stdin").fill(standardInput);
  await page.locator("#arguments").fill('["stdin"]');
  await page.locator("#run-program").click();
  await expect(state).toHaveText("running");
  await expect(page.locator("#result")).toHaveText(standardInput);
  expect(await page.locator("#result").textContent()).toBe(standardInput);
  // A filter reads only a prefix of substantial input and exits successfully.
  // Producer EPIPE, if observed, must not replace that real exit status.
  await page.locator("#stdin").fill("中".repeat(65536));
  await page.locator("#arguments").fill('["prefix"]');
  await page.locator("#run-program").click();
  await expect(state).toHaveText("running");
  await expect(page.locator("#result")).toHaveText("prefix byte: 228\n");
  await page.locator("#stdin-source").selectOption("file");
  await page.locator("#run-program").click();
  await expect(state).toContainText("select a standard-input file");
  const inputBytes = Buffer.from(
    Uint8Array.from({ length: 512 * 1024 + 17 }, (_, i) => (i * 37 + 11) & 255),
  );
  const sum = inputBytes.reduce((total, byte) => total + byte, 0);
  await page
    .locator("#stdin-file")
    .setInputFiles({ name: "input.bin", mimeType: "application/octet-stream", buffer: inputBytes });
  await page.locator("#arguments").fill('["pattern"]');
  await page.locator("#run-program").click();
  await expect(state).toHaveText("running");
  await expect(page.locator("#result")).toHaveText(
    `input bytes: ${inputBytes.length}, sum: ${sum}\n`,
  );
  // A prefix consumer must cancel the remaining file source, not fail launch.
  await page.locator("#arguments").fill('["prefix"]');
  await page.locator("#run-program").click();
  await expect(state).toHaveText("running");
  await expect(page.locator("#result")).toHaveText("prefix byte: 11\n");
  await page.locator("#stdin-file").setInputFiles({
    name: "empty.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(0),
  });
  await page.locator("#arguments").fill('["pattern"]');
  await page.locator("#run-program").click();
  await expect(state).toHaveText("running");
  await expect(page.locator("#result")).toHaveText("input bytes: 0, sum: 0\n");
  await page.locator("#stdin-source").selectOption("text");
  await page.locator("#stdin").fill("");
  await page.locator("#arguments").fill('["output"]');
  await page.locator("#run-program").click();
  await expect(state).toHaveText("running");
  await expect(page.locator("#result")).toHaveText("created /root/result.bin\n");
  await page.locator("#download-path").fill("/root/result.bin");
  await page.locator("#download").click();
  await expect(state).toHaveText("running");
  await savePreparedFile("result.bin", inputBytes.subarray(0, 65536 + 17));
  await page.locator("#download-path").fill("/root/missing.bin");
  await page.locator("#download").click();
  await expect(state).toContainText("error:");
  await expect(page.locator("#download-link")).toBeHidden();
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
  // Whole-machine Stop is an independent escape hatch, not another action
  // queued behind the application's status or pipe cleanup.
  await page.locator("#arguments").fill('["wait"]');
  await page.locator("#run-program").click();
  await expect(page.locator("#result")).toContainText("uploaded application waiting");
  await expect(page.locator("#stop")).toBeEnabled();
  await page.locator("#stop").click();
  await expect(state).toHaveText("stopped");
  await expect(page.locator("#download-link")).toBeHidden();
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
