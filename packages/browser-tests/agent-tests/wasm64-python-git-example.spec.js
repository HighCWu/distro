// SPDX-License-Identifier: MIT
import { expect, test } from "@playwright/test";

test("runs a Python Git SQLite workspace through standalone browser controls", async ({ page }) => {
  page.on("pageerror", (error) => console.error(error.stack ?? error));
  await page.goto("/");
  await expect(page.locator("#runtime-profile")).toContainText("Python + Git root (512 MiB)");
  const state = page.locator("#state");
  await page.locator("#start").click();
  await expect(state).toHaveText("running", { timeout: 120000 });
  const application = await page.request.get("/git-workspace.pyz");
  expect(application.ok()).toBe(true);
  await page.locator("#program").setInputFiles({
    name: "git-workspace.pyz",
    mimeType: "application/zip",
    buffer: await application.body(),
  });
  await page.locator("#program-kind").selectOption("python");
  await page.locator("#stdin").fill("");
  const directory = "/root/workspace ' $HOME → data";
  await page.locator("#arguments").fill(JSON.stringify(["write", directory]));
  await page.locator("#run-program").click();
  await expect(state).toHaveText("running", { timeout: 60000 });
  const written = JSON.parse(await page.locator("#result").textContent());
  expect(written).toEqual({
    phase: "write",
    head: expect.stringMatching(/^[0-9a-f]{40}$/),
    bytes: 65553,
    sha256: "4de6ff0a51a4cd16f2bb867a3f3ff954ee6509504b64ba03c20eb4b34adf2b81",
  });
  await page.locator("#arguments").fill(JSON.stringify(["read", directory, written.head]));
  await page.locator("#run-program").click();
  await expect(state).toHaveText("running", { timeout: 60000 });
  expect(JSON.parse(await page.locator("#result").textContent())).toEqual({
    ...written,
    phase: "read",
  });
  // SDK-backed download must return actual repository bytes, not the UI text preview.
  await page
    .locator("#download-path")
    .fill(`${directory}/clone ' $HOME → repo/payload ' $HOME → data.bin`);
  await page.locator("#download").click();
  await expect(state).toHaveText("running");
  await expect(page.locator("#download-link")).toBeVisible();
  const bytes = await page
    .locator("#download-link")
    .evaluate(async (link) =>
      Array.from(new Uint8Array(await (await fetch(link.href)).arrayBuffer())),
    );
  expect(bytes).toEqual(Array.from({ length: 65553 }, (_, i) => i & 255));
  await page.locator("#stop").click();
  await expect(state).toHaveText("stopped");
});
