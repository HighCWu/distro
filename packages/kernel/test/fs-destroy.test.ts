// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { fileSystemDevice, FSError } from "../src/virtio/fs.ts";
import { close_virtio_device, virtio_imports } from "../src/virtio/core.ts";

for (const openFails of [false, true]) {
  for (const destroyFails of [false, true]) {
    test(`FUSE DESTROY drains another queue before cleanup, open fails=${openFails}, destroy fails=${destroyFails}`, async () => {
      const root = {},
        node = {},
        handle = {};
      const entered = Promise.withResolvers<void>();
      const pending = Promise.withResolvers<void>();
      const events: string[] = [];
      const device = fileSystemDevice(
        {
          root,
          lookup() {
            events.push("lookup");
            return node;
          },
          getattr() {
            return { mode: 0o100600, size: 0n };
          },
          async open() {
            events.push("open");
            entered.resolve();
            await pending.promise;
            if (openFails) throw new FSError("EACCES");
            events.push("opened");
            return handle;
          },
          release(actualNode: object, actualHandle: object) {
            assert.equal(actualNode, node);
            assert.equal(actualHandle, handle);
            events.push("release");
          },
          destroy() {
            events.push("destroy");
            if (destroyFails) throw new FSError("EIO");
          },
        },
        { tag: "destroy" },
      );
      const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
      const bytes = new Uint8Array(memory.buffer),
        view = new DataView(memory.buffer);
      const completions = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
      const imports = virtio_imports({
        memory,
        devices: [device],
        trigger_irq(irq: number) {
          completions[irq - 1]!.resolve();
        },
        on_error(error) {
          for (const completion of completions) completion.reject(error);
        },
      });
      async function request(
        queue: number,
        opcode: number,
        id: bigint,
        body: Uint8Array,
        errno = 0,
      ) {
        const descriptors = queue * 64,
          address = 512 + queue * 512,
          response = 2048 + queue * 1024;
        completions[queue] = Promise.withResolvers<void>();
        bytes.fill(0, descriptors, descriptors + 64);
        bytes.fill(0, address, address + 256);
        bytes.fill(0, response, response + 512);
        view.setUint32(address, 40 + body.length, true);
        view.setUint32(address + 4, opcode, true);
        view.setBigUint64(address + 8, BigInt(queue + 1), true);
        view.setBigUint64(address + 16, id, true);
        bytes.set(body, address + 40);
        view.setBigUint64(descriptors, BigInt(address), true);
        view.setUint32(descriptors + 8, 40 + body.length, true);
        view.setUint16(descriptors + 14, 129, true);
        view.setBigUint64(descriptors + 16, BigInt(response), true);
        view.setUint32(descriptors + 24, 512, true);
        view.setUint16(descriptors + 30, 130, true);
        imports.enable_vring(0, queue, 4, descriptors, queue + 1);
        imports.notify(0, queue);
        await completions[queue]!.promise;
        imports.disable_vring(0, queue);
        assert.equal(view.getInt32(response + 4, true), -errno || 0);
      }
      let opening: Promise<void> | undefined, destroying: Promise<void> | undefined;
      try {
        await request(0, 1, 1n, new TextEncoder().encode("file\0"));
        const id = view.getBigUint64(2064, true);
        events.length = 0;
        opening = request(0, 14, id, new Uint8Array(8), openFails ? 13 : 0);
        await entered.promise;
        let destroyed = false;
        destroying = request(1, 38, 0n, new Uint8Array(), destroyFails ? 5 : 0).then(() => {
          destroyed = true;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(destroyed, false, "DESTROY must wait for the other request");
        assert.deepEqual(events, ["open"]);
        pending.resolve();
        await Promise.all([opening, destroying]);
        assert.deepEqual(
          events,
          openFails ? ["open", "destroy"] : ["open", "opened", "release", "destroy"],
        );
        await request(0, 1, 1n, new TextEncoder().encode("after\0"), 5);
        assert.equal(
          events.includes("lookup"),
          false,
          "destroyed backend cannot serve new requests",
        );
      } finally {
        pending.resolve();
        await Promise.allSettled([opening, destroying]);
        if (destroyFails)
          await assert.rejects(
            close_virtio_device(device),
            (error: unknown) => error instanceof FSError && error.errno === 5,
          );
        else await close_virtio_device(device);
      }
      assert.equal(events.filter((event) => event === "destroy").length, 1);
      assert.equal(events.filter((event) => event === "release").length, openFails ? 0 : 1);
    });
  }
}
