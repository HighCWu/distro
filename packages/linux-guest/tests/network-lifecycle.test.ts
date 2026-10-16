// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { guestAgent } from "../src/agent.ts";
import { createNetwork } from "../src/network.ts";

const isolatedNetwork = () =>
  createNetwork({
    connectTcp() {
      assert.fail("UDP lifecycle test must not open external TCP");
    },
    async resolveDns() {
      assert.fail("UDP lifecycle test must not resolve external names");
    },
  });

for (const length of [0, 65507]) {
  test(`UDP stream accepts the IPv4 payload boundary without a Linux instance: ${length}`, async () => {
    const network = isolatedNetwork();
    const attachment = network.attach(guestAgent());
    const connection = await attachment.connect({ port: 12345, transport: "udp" });
    const writer = connection.writable.getWriter();
    const reader = connection.readable.getReader();
    try {
      await writer.write(new Uint8Array(length));
      await writer.close();
      assert.deepEqual(await reader.read(), { done: true, value: undefined });
    } finally {
      connection.close();
      reader.releaseLock();
      writer.releaseLock();
      network.close();
    }
  });
}

for (const length of [65508, 131072]) {
  test(`oversized UDP write closes its flow without leaving a pending receiver: ${length}`, async () => {
    const network = isolatedNetwork();
    const attachment = network.attach(guestAgent());
    const connection = await attachment.connect({ port: 12345, transport: "udp" });
    const writer = connection.writable.getWriter();
    const reader = connection.readable.getReader();
    const pending = reader.read();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await assert.rejects(writer.write(new Uint8Array(length)), RangeError);
      await assert.rejects(writer.closed, RangeError);
      assert.deepEqual(
        await Promise.race([
          pending,
          new Promise((resolve) => {
            timer = setTimeout(() => resolve("pending"), 100);
          }),
        ]),
        { done: true, value: undefined },
        "an errored writer must not leave its receiver or flow alive",
      );
      connection.close();
      connection.close();
    } finally {
      clearTimeout(timer);
      connection.close();
      await pending;
      reader.releaseLock();
      writer.releaseLock();
      network.close();
    }
  });
}
