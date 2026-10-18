// SPDX-License-Identifier: MIT
import { test, expect } from "@playwright/test";

for (const [variant, title, stages] of [
  [
    "interpreter",
    "runs installed full Python and relocated applications through Linux",
    [
      "Python application: relocated compressed archive, metadata, resources and binary pipes verified",
      "Python application: published MIT zipapp, resources, metadata and binary pipes verified",
      "Python spawn: PATH error precedence and original str/bytes executable verified",
      "Python spawn: repeated failed launches preserve parent fds, CLOEXEC and child cleanup",
      "Python spawn: descriptor exhaustion preserves parent fds and child cleanup",
      "Python process: timeout recovery, binary pipes, terminate, kill and reaping verified",
      "Python process: large duplex binary pipes preserve backpressure, bytes and child cleanup",
      "Python PTY: character devices, CLOEXEC, canonical/raw binary I/O and window size verified",
      "Python PTY session: controlling terminal, foreground group, binary I/O and reaping verified",
    ],
  ],
  [
    "mmap",
    "runs installed Python private anonymous mmap boundaries through Linux",
    [
      "Python mmap: private anonymous bytes, buffer lifetime and close verified",
      "Python mmap: flush explicitly reports unsupported msync",
      "Python mmap: default shared and file mappings rejected by default kernel",
    ],
  ],
]) {
  test(title, async ({ page }) => {
    test.setTimeout(300_000);
    page.on("console", (message) => console.log(`[browser] ${message.text()}`));
    page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));
    await page.goto("/");
    await expect
      .poll(() => page.evaluate(() => typeof globalThis.runPythonRuntime))
      .toBe("function");
    const profile = await (await page.request.get("/profile.json")).json();
    expect([32, 64]).toContain(profile.addressBits);
    const output = await page.evaluate((name) => globalThis.runPythonRuntime(name), variant);
    expect(output).toContain(`sysconfig match ${profile.addressBits} bits`);
    expect(output).toContain(
      "Python layout: installed paths and operational flags exclude build-store paths",
    );
    for (const stage of stages) expect(output).toContain(stage);
    expect(output).toContain("::vm-test::pass");
    expect(output).not.toContain("::vm-test::fail");
  });
}
