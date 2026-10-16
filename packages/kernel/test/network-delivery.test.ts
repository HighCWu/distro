// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { ethernetNetwork } from "../src/virtio/net.ts";

for (const asynchronous of [false, true]) {
  test(`broadcast continues after a receiver ${asynchronous ? "rejects" : "throws"}`, async () => {
    const network = ethernetNetwork();
    const release = Promise.withResolvers<void>();
    const failure = new Error("receiver failed");
    const received: Uint8Array[] = [];
    const sender = network.addPort(() => assert.fail("sender must not receive its own frame"));
    network.addPort((frame) => {
      frame.fill(0);
      if (asynchronous) return Promise.reject(failure);
      throw failure;
    });
    network.addPort((frame) => {
      received.push(frame);
    });
    network.addPort(async (frame) => {
      await release.promise;
      received.push(frame);
    });
    const frame = Uint8Array.from([255, 255, 255, 255, 255, 255, 2, 0, 0, 0, 0, 1, 8, 0]);
    let settled = false;
    const checked = assert
      .rejects(sender.send(frame), (error) => error === failure)
      .then(() => {
        settled = true;
      });
    try {
      await setImmediate();
      assert.equal(received.length, 1, "other ports receive despite the failed receiver");
      assert.deepEqual(received[0], frame, "receivers cannot corrupt another port's copy");
      assert.equal(settled, false, "send waits for outstanding delivery");
    } finally {
      release.resolve();
      await checked;
      network.close();
    }
    assert.equal(received.length, 2);
    assert.deepEqual(received[1], frame);
    assert.notEqual(received[0], received[1]);
  });
}
