// SPDX-License-Identifier: MIT
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("runs a Python zip application through standalone browser controls", async ({ page }) => {
  page.on("pageerror", (error) => console.error(error.stack ?? error));
  await page.goto("/");
  await expect(page.locator("#runtime-profile")).toContainText("Python root (256 MiB)");
  const state = page.locator("#state");
  await page.locator("#start").click();
  await expect(state).toHaveText("running", { timeout: 120000 });
  const application = await readFile(new URL("../upload-application.pyz", import.meta.url));
  await page.locator("#program").setInputFiles({
    name: "developer-application.pyz",
    mimeType: "application/zip",
    buffer: application,
  });
  // Selection is explicit: a ZIP must never be passed to the Wasm loader.
  await page.locator("#run-program").click();
  await expect(state).toContainText("not a WebAssembly version 1 binary");
  await page.locator("#program-kind").selectOption("python");
  await page.locator("#arguments").fill('["literal $HOME", "--uninterpreted"]');
  const prefix = "Linux/Wasm Python example — UTF-8 resource\n";
  await page.locator("#stdin").fill("abc\n");
  await page.locator("#run-program").click();
  await expect(state).toHaveText("running", { timeout: 60000 });
  await expect(page.locator("#result")).toHaveText(prefix + "\ncba");
  expect(await page.locator("#result").textContent()).toBe(prefix + "\ncba");
  // Stream a selected binary file through the same public process API. The
  // page is a UTF-8 preview, so compare its exact decoder result, not raw bytes.
  const binary = Buffer.from(Uint8Array.from({ length: 513 }, (_, i) => i & 255));
  await page.locator("#stdin-source").selectOption("file");
  await page.locator("#stdin-file").setInputFiles({
    name: "binary-input.bin",
    mimeType: "application/octet-stream",
    buffer: binary,
  });
  await page.locator("#run-program").click();
  await expect(state).toHaveText("running");
  const expected = prefix + new TextDecoder().decode(Uint8Array.from(binary).reverse());
  expect(await page.locator("#result").textContent()).toBe(expected);
  // A ZIP-looking invalid input must fail in the real installed interpreter;
  // a format hint alone is never accepted as successful application execution.
  await page.locator("#program").setInputFiles({
    name: "broken.pyz",
    mimeType: "application/zip",
    buffer: Buffer.from("PK\x03\x04not-a-zip"),
  });
  await page.locator("#stdin-source").selectOption("text");
  await page.locator("#stdin").fill("");
  await page.locator("#run-program").click();
  await expect(state).toContainText("application failed:");
  await expect(page.locator("#result")).toContainText("SyntaxError");
  const controls = await readFile(new URL("../python-controls.pyz", import.meta.url));
  await page.locator("#program").setInputFiles({
    name: "python-controls.pyz",
    mimeType: "application/zip",
    buffer: controls,
  });
  await page.locator("#arguments").fill('["status", "literal $HOME → Python"]');
  await page.locator("#run-program").click();
  await expect(state).toContainText('"code":37');
  await expect(page.locator("#result")).toContainText("literal $HOME → Python\n");
  await expect(page.locator("#result")).toContainText("Python application stderr\n");
  await page.locator("#arguments").fill('["wait"]');
  await page.locator("#run-program").click();
  await expect(page.locator("#result")).toHaveText("Python application ready\n");
  await page.locator("#cancel-program").click();
  await expect(state).toContainText("application cancelled");
  await expect(page.locator("#run-program")).toBeEnabled();
  await page.locator("#uname").click();
  await expect(state).toHaveText("running");
  await expect(page.locator("#result")).toContainText("Linux ");
  // Stop must not wait behind a Python process that has not exited.
  await page.locator("#run-program").click();
  await expect(page.locator("#result")).toHaveText("Python application ready\n");
  await page.locator("#stop").click();
  await expect(state).toHaveText("stopped");
  await page.locator("#start").click();
  await expect(state).toHaveText("running", { timeout: 120000 });
  await page.locator("#uname").click();
  await expect(state).toHaveText("running");
  await expect(page.locator("#result")).toContainText("Linux ");
  await page.locator("#stop").click();
  await expect(state).toHaveText("stopped");
});
