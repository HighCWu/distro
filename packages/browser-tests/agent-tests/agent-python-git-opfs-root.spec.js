// SPDX-License-Identifier: MIT
import { expect, test } from "@playwright/test";

test("persists Python Git SQLite workspace through OPFS across page reload", async ({ page }) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));
  await page.goto("/");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  const name = await page.evaluate(() => `python-git-root-${crypto.randomUUID()}.img`);
  try {
    await expect
      .poll(() => page.evaluate(() => typeof globalThis.runOpfsPythonGitRoot))
      .toBe("function");
    const written = await page.evaluate(
      (name) => globalThis.runOpfsPythonGitRoot("write", name),
      name,
    );
    expect(written.phase).toBe("write");
    expect(written.head).toMatch(/^[0-9a-f]{40}$/);
    expect(written.closed).toBe(true);
    await page.reload();
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    await expect
      .poll(() => page.evaluate(() => typeof globalThis.runOpfsPythonGitRoot))
      .toBe("function");
    // Recovery must succeed with the old disk, not a freshly fetched template.
    await page.route("**/agent-root.ext4", (route) => route.abort());
    expect(
      await page.evaluate(({ name, head }) => globalThis.runOpfsPythonGitRoot("read", name, head), {
        name,
        head: written.head,
      }),
    ).toEqual({
      phase: "read",
      head: written.head,
      closed: true,
    });
  } finally {
    await page.evaluate(async (name) => {
      const directory = await navigator.storage.getDirectory();
      await directory.removeEntry(name).catch((error) => {
        if (error.name !== "NotFoundError") throw error;
      });
    }, name);
  }
});
