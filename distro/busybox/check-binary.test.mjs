// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

function leb(value) {
  let remaining = BigInt(value);
  const bytes = [];
  do {
    const byte = Number(remaining & 127n);
    remaining >>= 7n;
    bytes.push(byte | (remaining ? 128 : 0));
  } while (remaining);
  return bytes;
}

function moduleBytes({
  bits = 64,
  shared = true,
  maximum = 262144,
  defined = false,
  count = 1,
  minimum = 1,
} = {}) {
  const flags = (bits === 64 ? 4 : 0) | (shared ? 2 : 0) | (maximum === null ? 0 : 1);
  const type = [flags, ...leb(minimum), ...(maximum === null ? [] : leb(maximum))];
  const entry = defined
    ? type
    : [3, ...Buffer.from("env"), 6, ...Buffer.from("memory"), 2, ...type];
  const section = [...leb(count), ...Array.from({ length: count }, () => entry).flat()];
  return Uint8Array.from([
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    defined ? 5 : 2,
    ...leb(section.length),
    ...section,
  ]);
}

const parser = fileURLToPath(new URL("../../packages/kernel/src/wasm_binary.ts", import.meta.url));
const checker = fileURLToPath(new URL("./check-binary.mjs", import.meta.url));

function withFixture(body) {
  const directory = mkdtempSync(join(tmpdir(), "busybox-binary-contract-"));
  try {
    const binary = join(directory, "busybox");
    body((bytes, bits = "64", maximum = "17179869184") => {
      writeFileSync(binary, bytes);
      return spawnSync(process.execPath, [checker, parser, binary, bits, maximum], {
        encoding: "utf8",
      });
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("built userland contract accepts matching wasm32 and wasm64 imported memories", () => {
  withFixture((check) => {
    for (const bits of [32, 64]) {
      const maximum = bits === 32 ? 65536 : 262144;
      const result = check(moduleBytes({ bits, maximum }), String(bits), String(maximum * 65536));
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`Verified wasm${bits} shared env.memory`));
    }
  });
});

test("built userland contract refuses another ABI, private or defined memories and mismatched ceilings", () => {
  withFixture((check) => {
    for (const bytes of [
      moduleBytes({ bits: 32 }),
      moduleBytes({ shared: false }),
      moduleBytes({ defined: true }),
      moduleBytes({ maximum: 65536 }),
      moduleBytes({ maximum: null }),
      moduleBytes({ count: 0 }),
      moduleBytes({ count: 2 }),
      moduleBytes({ minimum: 262145 }),
      Uint8Array.of(0, 97, 115, 109),
      Buffer.from("not a WebAssembly executable"),
    ]) {
      const result = check(bytes);
      assert.notEqual(result.status, 0, result.stdout);
      assert.ok(result.stderr.length > 0);
      assert.doesNotMatch(result.stdout, /Verified/);
    }
  });
});

test("built userland contract rejects invalid profile arguments", () => {
  withFixture((check) => {
    for (const [bits, maximum] of [
      ["128", "17179869184"],
      ["64", "65537"],
      ["64", "NaN"],
      ["64", "-65536"],
    ]) {
      assert.notEqual(check(moduleBytes(), bits, maximum).status, 0);
    }
  });
});
