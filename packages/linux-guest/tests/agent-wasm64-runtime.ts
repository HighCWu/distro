// SPDX-License-Identifier: MIT
// Explicit heavy check: never auto-discovered by the default wasm32 suite.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { blockDevice } from "@lowland/kernel";
import { runAgentWasm64Suite } from "./agent-wasm64-suite.ts";

test(
  "native wasm64 agent sessions, files and processes on real Linux",
  { timeout: 120_000 },
  async (t) => {
    const path = process.env.AGENT_WASM64_INITRAMFS;
    const bootDiskPath = process.env.AGENT_WASM64_BOOT_DISK;
    assert.ok(path || bootDiskPath, "select a wasm64 initramfs or boot disk");
    assert.ok(!(path && bootDiskPath), "do not bypass the boot disk with an initramfs");
    const rootPath = process.env.AGENT_WASM64_ROOTFS;
    const root = rootPath ? readFileSync(rootPath) : undefined;
    if (bootDiskPath) assert.ok(root, "boot disk requires a separate matching system root");
    const disks = [root, bootDiskPath ? readFileSync(bootDiskPath) : undefined].filter(
      (bytes): bytes is NonNullable<typeof bytes> => bytes !== undefined,
    );
    await runAgentWasm64Suite(
      path ? readFileSync(path) : undefined,
      assert,
      (name, body) => t.test(name, body),
      (text) => {
        process.stderr.write(text);
      },
      {
        productionRoot: root !== undefined,
        args: bootDiskPath
          ? ["root=PARTLABEL=LOWLAND_AGENT", "rootfstype=erofs", "ro", "rootwait", "init=/init"]
          : [],
        // Root deliberately comes before the GPT agent disk: discovery must
        // follow its label, never a hard-coded virtio device position.
        plugins: disks.map((bytes) =>
          blockDevice({
            capacity: bytes.byteLength,
            read(offset, target) {
              const source = bytes.subarray(offset, offset + target.byteLength);
              target.set(source);
              return source.byteLength;
            },
          }),
        ),
      },
    );
  },
);
