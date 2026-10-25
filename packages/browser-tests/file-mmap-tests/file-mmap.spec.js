// SPDX-License-Identifier: MIT
import { expect, test } from "@playwright/test";

for (const [scenario, title] of [
  ["standard", "standard private file mmap preserves content, EOF and lifetimes"],
  ["zstd", "Zstandard forces snapshot and ordinary dictionary mmap within capacity"],
]) {
  test(title, async ({ page, browser }) => {
    test.setTimeout(300_000);
    console.log(`browser version: ${browser.version()}, scenario: ${scenario}`);
    page.on("console", (message) => console.log(`[browser] ${message.text()}`));
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.stack ?? String(error)));
    await page.goto("/");
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    await expect.poll(() => page.evaluate(() => typeof globalThis.runErofsCopies)).toBe("function");
    const result = await page.evaluate((name) => globalThis.runErofsCopies(name), scenario);
    expect(result.scenario).toBe(scenario);
    expect(result.passed).toBe(true);
    expect(result.output).toContain("::vm-test::pass");
    expect(result.output).not.toContain("::vm-test::fail");
    if (scenario === "standard") {
      expect(result.output).toContain(
        "file mmap: WRITE-only requests preserve private content, source and cleanup",
      );
      expect(result.output).toContain(
        "file mmap: mutable file writes, truncate, EOF, unlink and private lifetime verified",
      );
      expect(result.output).toContain(
        "file mmap: immutable RO/RW copies, offset, EOF tail and independence verified",
      );
    } else {
      const sizes = [
        ...result.output.matchAll(/immutable forced mapping boundary (\d+) verified/g),
      ].map((match) => Number(match[1]));
      expect(sizes).toEqual([65535, 65536, 65537, 131071, 131072]);
      expect(
        [...result.output.matchAll(/regular forced mapping boundary (\d+) verified/g)].map(
          (match) => Number(match[1]),
        ),
      ).toEqual([65535, 65536, 65537, 131071, 131072]);
      expect(result.output).toContain("zstd: immutable mapping ceiling 131073 rejected");
      expect(result.output).toContain(
        "zstd: snapshot ordinary and mutable private copies verified",
      );
    }
    expect(result.machineClosed).toBe(true);
    expect(errors).toEqual([]);
  });
}
