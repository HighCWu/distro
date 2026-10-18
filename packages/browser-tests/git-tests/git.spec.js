// SPDX-License-Identifier: MIT
import { test, expect } from "@playwright/test";

for (const [variant, title, stage] of [
  [
    "workflow",
    "runs installed Git commits, conflict merges, hooks and pager through Linux",
    "Git workflow: commit, conflict merge, object, hook and pager verified",
  ],
  [
    "packing",
    "runs installed Git threaded repack, fsck and gc through Linux",
    "Git packing: object roundtrip, threaded repack, strict fsck, gc and packed history verified",
  ],
  [
    "remote",
    "runs installed Git credential cache and loopback HTTP clone through Linux",
    "Git remote: credential cache and loopback HTTP discovery/clone verified",
  ],
]) {
  test(title, async ({ page }) => {
    test.setTimeout(300_000);
    page.on("console", (message) => console.log(`[browser] ${message.text()}`));
    page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));
    await page.goto("/");
    await expect.poll(() => page.evaluate(() => typeof globalThis.runGitRuntime)).toBe("function");
    const response = await page.request.get("/profile.json");
    expect(response.ok()).toBe(true);
    const profile = await response.json();
    expect([32, 64]).toContain(profile.addressBits);
    const output = await page.evaluate((name) => globalThis.runGitRuntime(name), variant);
    expect(output).toContain(`Git ABI: long and size_t match ${profile.addressBits} bits`);
    expect(output).toContain(
      "Git notices: selected installed originals and default patch checksums verified",
    );
    expect(output).toContain(stage);
    expect(output).toContain("::vm-test::pass");
    expect(output).not.toContain("::vm-test::fail");
  });
}
