// SPDX-License-Identifier: MIT
import { expect, test } from "@playwright/test";

for (const [scenario, title] of [
  ["standard", "standard immutable file mmap preserves content, offsets and refusal semantics"],
  ["zstd", "Zstandard forces immutable dictionary mmap and rejects unsupported sources"],
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
        "file mmap: immutable RO/RW copies, offset, EOF tail and independence verified",
      );
    } else {
      const sizes = [
        ...result.output.matchAll(/immutable forced mapping boundary (\d+) verified/g),
      ].map((match) => Number(match[1]));
      expect(sizes).toEqual([65535, 65536, 65537, 131071, 131072]);
      expect(result.output).toContain("zstd: immutable mapping ceiling 131073 rejected");
      expect(result.output).toContain(
        "zstd: immutable mapping and mutable/ordinary source refusals verified",
      );
    }
    expect(result.machineClosed).toBe(true);
    expect(errors).toEqual([]);
  });
}
