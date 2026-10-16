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
      await writer.closed;
      assert.deepEqual(await reader.read(), { done: true, value: undefined });
    } finally {
      connection.close();
      reader.releaseLock();
      writer.releaseLock();
      network.close();
    }
  });
}

test("UDP writer abort preserves its reason and ends the receiving side", async () => {
  const network = isolatedNetwork();
  const attachment = network.attach(guestAgent());
  const connection = await attachment.connect({ port: 12345, transport: "udp" });
  const writer = connection.writable.getWriter();
  const reader = connection.readable.getReader();
  const reason = new Error("application aborted UDP");
  const closed = assert.rejects(writer.closed, (error) => error === reason);
  try {
    await writer.abort(reason);
    await closed;
    assert.deepEqual(await reader.read(), { done: true, value: undefined });
    connection.close();
  } finally {
    connection.close();
    writer.releaseLock();
    reader.releaseLock();
    network.close();
  }
});

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

for (const mode of ["connection close", "network close", "reader cancel"] as const) {
  test(`UDP ${mode} settles an idle writer and pending reader`, async () => {
    const network = isolatedNetwork();
    const attachment = network.attach(guestAgent());
    const connection = await attachment.connect({ port: 12345, transport: "udp" });
    const writer = connection.writable.getWriter();
    const reader = connection.readable.getReader();
    const read = reader.read();
    const writeClosed = writer.closed.then(
      () => "closed",
      () => "errored",
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (mode === "connection close") connection.close();
      if (mode === "network close") network.close();
      if (mode === "reader cancel") await reader.cancel();
      assert.deepEqual(await read, { done: true, value: undefined });
      assert.equal(
        await Promise.race([
          writeClosed,
          new Promise((resolve) => {
            timer = setTimeout(() => resolve("pending"), 100);
          }),
        ]),
        "errored",
        "closing the channel must also settle an otherwise idle writer",
      );
      await assert.rejects(writer.write(Uint8Array.of(1)), /UDP connection is closed/);
      connection.close();
      network.close();
    } finally {
      clearTimeout(timer);
      connection.close();
      // Also settle the unfixed implementation after the bounded assertion.
      await writer.abort().catch(() => {});
      await read;
      reader.releaseLock();
      writer.releaseLock();
      network.close();
    }
  });
}
