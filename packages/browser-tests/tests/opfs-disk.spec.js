import { expect, test } from "@playwright/test";

test("invalid disk capacity preserves OPFS data and releases its lock", async ({ page }) => {
  await page.goto("/");
  test.skip(
    !(await page.evaluate(() => "storage" in navigator && "getDirectory" in navigator.storage)),
    "browser does not expose OPFS",
  );
  const result = await page.evaluate(async () => {
    const directory = await navigator.storage.getDirectory();
    const name = `invalid-capacity-${crypto.randomUUID()}.img`;
    const handle = await directory.getFileHandle(name, { create: true });
    const original = new Uint8Array(512).fill(0x5a);
    const writer = await handle.createWritable();
    await writer.write(original);
    await writer.close();
    const worker = new Worker("/opfs-disk-worker.js", { type: "module" });
    try {
      const failure = await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("disk initialization did not fail")),
          10000,
        );
        worker.addEventListener(
          "error",
          (event) => {
            event.preventDefault();
            clearTimeout(timer);
            resolve(event.message);
          },
          { once: true },
        );
        worker.postMessage({ handle, capacity: 1 });
      });
      // Do not terminate the failed worker first: that would conceal a leaked
      // synchronous access handle by letting browser teardown release its lock.
      const reopened = await handle.createWritable({ keepExistingData: true });
      await reopened.close();
      const contents = new Uint8Array(await (await handle.getFile()).arrayBuffer());
      return {
        failure,
        size: contents.length,
        unchanged: contents.length === original.length && contents.every((byte) => byte === 0x5a),
      };
    } finally {
      worker.terminate();
      await directory.removeEntry(name);
    }
  });
  expect(result.failure).toContain("block capacity");
  expect(result.size).toBe(512);
  expect(result.unchanged).toBe(true);
});

test("persists a virtio block device through an OPFS worker", async ({ page }) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));

  await page.goto("/");
  test.skip(
    !(await page.evaluate(() => "storage" in navigator && "getDirectory" in navigator.storage)),
    "browser does not expose OPFS",
  );
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.opfsWorkerDiskRoundTrip))
    .toBe("function");
  const result = await page.evaluate(() => globalThis.opfsWorkerDiskRoundTrip());

  expect(result.write.status).toEqual({ code: 0, signal: null, success: true });
  expect(result.write.stderr).toBe("");
  expect(result.read.status).toEqual({ code: 0, signal: null, success: true });
  expect(result.read.stderr).toBe("");
  expect(result.read.stdout).toContain(result.marker);
});
