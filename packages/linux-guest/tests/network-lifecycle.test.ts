// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { closeDevice, type EthernetDevice, type VirtioDevice } from "@lowland/kernel";
import { getMachinePlugin } from "@lowland/kernel/plugin";
import { guestAgent } from "../src/agent.ts";
import { createNetwork, type NetworkAttachment } from "../src/network.ts";

const isolatedNetwork = () =>
  createNetwork({
    connectTcp() {
      assert.fail("UDP lifecycle test must not open external TCP");
    },
    async resolveDns() {
      assert.fail("UDP lifecycle test must not resolve external names");
    },
  });

async function attachmentDevice(attachment: NetworkAttachment): Promise<EthernetDevice> {
  const devices: VirtioDevice[] = [];
  await attachment[getMachinePlugin]().configure({
    args: { add: () => assert.fail("network attachment added an unexpected kernel argument") },
    devices: { add: (...values) => devices.push(...values) },
    deviceTree: { merge: () => assert.fail("network attachment merged an unexpected device tree") },
  });
  assert.equal(devices.length, 1);
  const device = devices[0]!;
  assert.ok("macAddress" in device);
  return device as EthernetDevice;
}

test(
  "a closed device releases its IPv4 address without reviving its attachment",
  { timeout: 2000 },
  async () => {
    const network = isolatedNetwork();
    const firstAgent = guestAgent();
    const first = network.attach(firstAgent);
    const device = await attachmentDevice(first);
    let replacementDevice: EthernetDevice | undefined;
    try {
      assert.equal(first.address, "192.0.2.2");
      for (let suffix = 3; suffix <= 254; ++suffix) {
        assert.equal(network.attach(guestAgent()).address, `192.0.2.${suffix}`);
      }
      const nextAgent = guestAgent();
      assert.throws(() => network.attach(nextAgent), /network has no guest addresses left/);

      const udp = await first.connect({ transport: "udp", port: 12345 });
      const writer = udp.writable.getWriter();
      const reader = udp.readable.getReader();
      const writerClosed = assert.rejects(writer.closed, /UDP connection is closed/);
      const tcpClosed = assert.rejects(
        first.connect({ port: 12345 }),
        /guest detached from network/,
      );
      try {
        const deviceClosing = closeDevice(device);
        assert.throws(() => network.attach(nextAgent), /network has no guest addresses left/);
        await deviceClosing;
        await writerClosed;
        await tcpClosed;
        assert.deepEqual(await reader.read(), { done: true, value: undefined });
      } finally {
        udp.close();
        writer.releaseLock();
        reader.releaseLock();
      }

      assert.throws(() => network.attach(firstAgent), /already has a network attachment/);
      const replacement = network.attach(nextAgent);
      replacementDevice = await attachmentDevice(replacement);
      assert.equal(replacement.address, first.address);
      assert.notDeepEqual(replacementDevice.macAddress, device.macAddress);
      await assert.rejects(first.connect({ port: 12345 }), /guest detached from network/);
      await assert.rejects(
        first.connect({ transport: "udp", port: 12345 }),
        /guest detached from network/,
      );

      const current = await replacement.connect({ transport: "udp", port: 12345 });
      current.close();
      network.close();
      network.close();
      assert.throws(() => network.attach(guestAgent()), /network is closed/);
    } finally {
      network.close();
      await closeDevice(device);
      if (replacementDevice) await closeDevice(replacementDevice);
    }
  },
);

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

test(
  "guest address suffixes recycle across more than 260 attachment cycles",
  { timeout: 5000 },
  async () => {
    const network = isolatedNetwork();
    try {
      const seenAddresses = new Set<string>();
      const seenMacs = new Set<string>();
      for (let i = 0; i < 300; i++) {
        const attachment = network.attach(guestAgent());
        const device = await attachmentDevice(attachment);
        seenAddresses.add(attachment.address);
        seenMacs.add(device.macAddress.join(":"));
        await closeDevice(device);
      }
      assert.equal(seenAddresses.size, 253);
      assert.equal(seenMacs.size, 300);
    } finally {
      network.close();
    }
  },
);
