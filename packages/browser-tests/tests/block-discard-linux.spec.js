// SPDX-License-Identifier: MIT

import { expect, test } from "@playwright/test";

for (const backend of ["persistent HTTP", "zero-backed persistent"]) {
  test(`Linux discards and reopens a ${backend} disk`, async ({ page, baseURL }) => {
    const capacity = 512 * 1024;
    const base = backend === "persistent HTTP" ? new URL("/discard-base.img", baseURL).href : null;
    if (base)
      await page.route(base, (route) => {
        const [, first, last] =
          /^bytes=(\d+)-(\d+)$/.exec(route.request().headers().range ?? "") ?? [];
        const start = Number(first);
        const end = Number(last);
        if (!(start >= 0 && end >= start && end < capacity)) return route.fulfill({ status: 416 });
        return route.fulfill({
          status: 206,
          headers: {
            etag: '"discard-test-v1"',
            "content-range": "bytes " + start + "-" + end + "/" + capacity,
            "content-encoding": "identity",
          },
          body: Buffer.alloc(end - start + 1, 0xa5),
        });
      });
    await page.goto("/");
    const runs = await page.evaluate(
      async ({ baseUrl, capacity }) => {
        const kernel = await import("/node_modules/@lowland/kernel/dist/index.js");
        const { runRuntimeSmoke } = await import("/runtime-smoke.js");
        const response = await fetch("/block-discard.cpio");
        if (!response.ok) throw new Error("cannot load discard initramfs");
        const image = new Uint8Array(await response.arrayBuffer());
        const name = "discard-" + crypto.randomUUID();
        const records = [];
        for (const first of [true, false]) {
          const storage = baseUrl
            ? await kernel.openIndexedDbHttpBlockStorage(baseUrl, name)
            : await kernel.openIndexedDbBlockStorage(name, capacity);
          const requests = [];
          let device;
          let attached = false;
          try {
            if (first) {
              if (!baseUrl) {
                const neighbors = new Uint8Array(4096).fill(0xa5);
                for (const offset of [0, 12288])
                  if ((await storage.write(offset, neighbors)) !== neighbors.length)
                    throw new Error("short neighboring disk seed");
              }
              const input = new Uint8Array(8192).fill(0x6b);
              if ((await storage.write(4096, input)) !== input.length)
                throw new Error("short disk seed");
            }
            device = kernel.blockDevice({
              ...storage,
              async discard(offset, length) {
                await storage.discard(offset, length);
                requests.push({ offset, length });
              },
            });
            const output = await runRuntimeSmoke({
              cpus: 1,
              bootMachine(options) {
                attached = true;
                return kernel.bootMachine({ ...options, plugins: [...options.plugins, device] });
              },
              consoleDevice: kernel.consoleDevice,
              entropyDevice: kernel.entropyDevice,
              loadInitramfs: () => image,
            });
            records.push({ output, requests });
          } finally {
            if (device && !attached) await kernel.closeDevice(device);
            else if (!device) await storage.close();
          }
        }
        return records;
      },
      { baseUrl: base, capacity },
    );
    const expected = [
      "block discard: issued BLKDISCARD and verified bytes",
      "block discard: reopened disk retains discarded bytes",
    ];
    for (const [index, { output }] of runs.entries()) {
      const lines = output.split("\n");
      expect(lines.filter((line) => line.startsWith("block discard:"))).toEqual([expected[index]]);
      expect(lines.filter((line) => line === "::vm-test::pass")).toHaveLength(1);
      console.log(expected[index]);
      console.log("block discard: machine and devices closed for boot " + (index + 1));
    }
    expect(runs[0].requests).toEqual([{ offset: 4096, length: 8192 }]);
    expect(runs[1].requests).toEqual([]);
  });
}
