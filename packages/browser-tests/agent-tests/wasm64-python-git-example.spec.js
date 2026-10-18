// SPDX-License-Identifier: MIT
import { expect, test } from "@playwright/test";

for (const persistent of [false, true])
  test(
    persistent
      ? "restores a Python Git SQLite workspace through standalone OPFS controls"
      : "runs a Python Git SQLite workspace through standalone browser controls",
    async ({ page }) => {
      page.on("pageerror", (error) => console.error(error.stack ?? error));
      await page.goto("/");
      await expect(page.locator("#runtime-profile")).toContainText("Python + Git root (512 MiB)");
      const state = page.locator("#state");
      const diskName = await page.evaluate(() => `controls-${crypto.randomUUID()}`);
      if (persistent) {
        await page.locator("#storage-mode").selectOption("create");
        await page.locator("#disk-name").fill(diskName);
      }
      try {
        await page.locator("#start").click();
        await expect(state).toHaveText("running", { timeout: 120000 });
        const application = await page.request.get("/git-workspace.pyz");
        expect(application.ok()).toBe(true);
        const applicationBytes = await application.body();
        const importApplication = async () => {
          await page.locator("#program").setInputFiles({
            name: "git-workspace.pyz",
            mimeType: "application/zip",
            buffer: applicationBytes,
          });
          await page.locator("#program-kind").selectOption("python");
          await page.locator("#stdin").fill("");
        };
        await importApplication();
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
        if (persistent) {
          // A second real page shares the origin's locks, not the Linux instance.
          // Both create and open must fail before fetching or replacing a template.
          const contender = await page.context().newPage();
          try {
            let contenderTemplates = 0;
            await contender.route("**/root.ext4", (route) => {
              contenderTemplates++;
              return route.abort();
            });
            await contender.goto("/");
            await contender.locator("#disk-name").fill(diskName);
            for (const mode of ["open", "create"]) {
              await contender.locator("#storage-mode").selectOption(mode);
              await contender.locator("#start").click();
              await expect(contender.locator("#state")).toContainText(
                "already open in another page",
              );
              await expect(contender.locator("#start")).toBeEnabled();
              await expect(contender.locator("#save-stop")).toBeDisabled();
              await expect(state).toHaveText("running");
            }
            expect(contenderTemplates).toBe(0);
          } finally {
            await contender.close();
          }
          await page.locator("#save-stop").click();
          await expect(state).toHaveText("stopped", { timeout: 60000 });
          let templateRequests = 0;
          await page.route("**/root.ext4", (route) => {
            templateRequests++;
            return route.abort();
          });
          // Existing creation must refuse replacement, including after successful use.
          await page.locator("#start").click();
          await expect(state).toContainText("Disk already exists");
          await page.reload();
          await page.locator("#storage-mode").selectOption("open");
          await page.locator("#disk-name").fill(diskName);
          await page.locator("#start").click();
          await expect(state).toHaveText("running", { timeout: 120000 });
          expect(templateRequests).toBe(0);
          await importApplication();
        }
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
        await page.locator(persistent ? "#save-stop" : "#stop").click();
        await expect(state).toHaveText("stopped", persistent ? { timeout: 60000 } : {});
      } finally {
        if (persistent) {
          // Navigation releases this page's workers even on failed assertions.
          // Delete only the unique disk created by this case, never a user disk.
          await page.goto("/");
          await expect
            .poll(() =>
              page.evaluate(async (name) => {
                try {
                  await (
                    await navigator.storage.getDirectory()
                  ).removeEntry(`linux-wasm64-${name}.ext4`);
                  return true;
                } catch (error) {
                  if (error.name === "NotFoundError") return true;
                  if (error.name === "NoModificationAllowedError") return false;
                  throw error;
                }
              }, diskName),
            )
            .toBe(true);
        }
      }
    },
  );
