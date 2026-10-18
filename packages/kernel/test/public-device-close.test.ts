// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { blockDevice, closeDevice, serveDevice, workerDevice } from "../src/index.ts";

for (const failure of [false, true]) {
  test(`public closeDevice releases an unattached block device once, failure=${failure}`, async () => {
    const completion = Promise.withResolvers<void>();
    const reason = new Error("disk flush failed");
    let closes = 0;
    const device = blockDevice({
      capacity: 512,
      read() {
        return 0;
      },
      write() {
        return 0;
      },
      async close() {
        closes++;
        await completion.promise;
      },
    });
    assert.equal("close" in device, false, "the opaque public device has no close method");
    const first = closeDevice(device);
    const second = closeDevice(device);
    let finished = false;
    void first.then(
      () => {
        finished = true;
      },
      () => {
        finished = true;
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(finished, false);
    assert.equal(closes, 1);
    if (failure) {
      completion.reject(reason);
      await assert.rejects(first, (error) => error === reason);
      await assert.rejects(second, (error) => error === reason);
      await assert.rejects(device.closed, (error) => error === reason);
    } else {
      completion.resolve();
      await Promise.all([first, second, device.closed]);
    }
    assert.equal(closes, 1);
  });
}

test("public closeDevice closes a real remote backend before machine attachment", async () => {
  const channel = new MessageChannel();
  let closes = 0;
  const local = blockDevice({
    capacity: 512,
    read() {
      return 0;
    },
    write() {
      return 0;
    },
    close() {
      closes++;
    },
  });
  try {
    const pending = workerDevice(channel.port1);
    serveDevice(channel.port2, local);
    const remote = await pending;
    await closeDevice(remote);
    await remote.closed;
    await closeDevice(remote);
    await local.closed;
    assert.equal(closes, 1);
  } finally {
    await closeDevice(local);
    channel.port1.close();
    channel.port2.close();
  }
});
