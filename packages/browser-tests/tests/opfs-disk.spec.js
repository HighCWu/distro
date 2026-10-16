import { expect, test } from "@playwright/test";

test("flushes virtio writes through the real OPFS worker", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const directory = await navigator.storage.getDirectory();
    const name = `virtio-flush-${crypto.randomUUID()}.img`;
    const handle = await directory.getFileHandle(name, { create: true });
    let worker = new Worker("/opfs-disk-worker.js", { type: "module" });
    function exchange(type, send) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error(`timed out waiting for ${type}`)), 10000);
        function finish(error, value) {
          clearTimeout(timer);
          worker.removeEventListener("message", message);
          worker.removeEventListener("error", failed);
          if (error) reject(error);
          else resolve(value);
        }
        function failed(event) {
          event.preventDefault();
          finish(new Error(event.message));
        }
        function message({ data }) {
          if (data.type === "error" || data.error) finish(new Error(data.error?.message));
          else if (data.type === type) finish(null, data);
        }
        worker.addEventListener("message", message);
        worker.addEventListener("error", failed);
        send();
      });
    }
    try {
      await exchange("ready", () => worker.postMessage({ handle, capacity: 512 }));
      const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
      const view = new DataView(memory.buffer);
      const control = new Int32Array(new SharedArrayBuffer(8));
      worker.postMessage({ type: "bind", memory, control: control.buffer });
      const descriptor = (ring, index, address, length, flags) => {
        const offset = ring + index * 16;
        view.setBigUint64(offset, BigInt(address), true);
        view.setUint32(offset + 8, length, true);
        view.setUint16(offset + 14, flags, true);
      };
      async function request(operation, ring) {
        view.setUint32(128, operation, true);
        descriptor(ring, 0, 128, 16, 128 | 1);
        if (operation === 1 || operation === 0) {
          descriptor(ring, 1, 256, 512, 128 | 1 | (operation === 0 ? 2 : 0));
          descriptor(ring, 2, 1024, 1, 128 | 2);
        } else descriptor(ring, 1, 1024, 1, 128 | 2);
        view.setUint8(1024, 255);
        worker.postMessage({
          type: "enable",
          vq: 0,
          size: 4,
          descriptor_address: ring,
          irq: 1,
          device_epoch: 0,
          queue_epoch: 0,
        });
        const response = await exchange("complete", () =>
          worker.postMessage({ type: "notify", vq: 0 }),
        );
        const status = response.completion.outputs.find((output) => output.address === 1024);
        if (operation === 0) {
          const data = response.completion.outputs.find((output) => output.address === 256)?.data;
          return {
            status: status?.data[0],
            written: response.completion.written,
            matches: data?.length === 512 && data.every((byte) => byte === 0x6b),
          };
        }
        return { status: status?.data[0], written: response.completion.written };
      }
      new Uint8Array(memory.buffer, 256, 512).fill(0x6b);
      const write = await request(1, 0);
      const flush = await request(4, 2048);
      await exchange("closed", () => worker.postMessage({ type: "close" }));
      // Reopen before terminating the Worker: normal device close owns lock release.
      const reopened = await handle.createWritable({ keepExistingData: true });
      await reopened.close();
      const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
      worker.terminate();
      worker = new Worker("/opfs-disk-worker.js", { type: "module" });
      // Omit capacity: reopening must not truncate or reinitialize stored data.
      await exchange("ready", () => worker.postMessage({ handle }));
      new Uint8Array(memory.buffer, 256, 512).fill(0);
      worker.postMessage({ type: "bind", memory, control: control.buffer });
      const read = await request(0, 4096);
      await exchange("closed", () => worker.postMessage({ type: "close" }));
      return {
        write,
        flush,
        read,
        size: bytes.length,
        matches: bytes.every((byte) => byte === 0x6b),
      };
    } finally {
      worker.terminate();
      await directory.removeEntry(name);
    }
  });
  expect(result.write).toEqual({ status: 0, written: 1 });
  expect(result.flush).toEqual({ status: 0, written: 1 });
  expect(result.read).toEqual({ status: 0, written: 513, matches: true });
  expect(result.size).toBe(512);
  expect(result.matches).toBe(true);
});

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
