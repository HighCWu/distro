// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { resolve_dylink_address } from "../src/dylink_address.ts";
import type { DylinkAddressObject } from "../src/dylink_address.ts";

const object = (
  id: string,
  base: bigint,
  memorySize: bigint,
  dataSymbols: DylinkAddressObject["dataSymbols"] = [],
): DylinkAddressObject => ({ id, base, memorySize, dataSymbols });

test("dylink address resolver rejects zero and negative addresses", () => {
  const objects = [object("module", 0x1000n, 0x100n)];
  assert.equal(resolve_dylink_address(0n, objects, { owner: "function" }), undefined);
  assert.equal(resolve_dylink_address(-1n, objects, { owner: "function" }), undefined);
});

test("dylink address resolver trusts verified function ownership and symbol", () => {
  const match = {
    owner: "function-module",
    symbol: { name: "run", address: 0x4000n },
  };
  assert.deepEqual(resolve_dylink_address(0x4000n, [], match), match);
  assert.deepEqual(resolve_dylink_address(0x4000n, [], { owner: "function-module" }), {
    owner: "function-module",
  });
});

test("dylink address resolver resolves exact symbols and same-address aliases stably", () => {
  const symbols = [
    { name: "zeta", address: 0x1010n },
    { name: "alpha", address: 0x1010n },
  ];
  assert.deepEqual(resolve_dylink_address(0x1010n, [object("module", 0x1000n, 0x100n, symbols)]), {
    owner: "module",
    symbol: { name: "alpha", address: 0x1010n },
  });
});

test("dylink address resolver handles main exact symbols and excludes range end", () => {
  const main = object("main", 0x8000n, 0n, [{ name: "global", address: 0x8000n }]);
  assert.deepEqual(resolve_dylink_address(0x8000n, [main]), {
    owner: "main",
    symbol: { name: "global", address: 0x8000n },
  });
  assert.equal(resolve_dylink_address(0x8001n, [main]), undefined);

  const module = object("module", 0x1000n, 0x100n);
  assert.deepEqual(resolve_dylink_address(0x1000n, [module]), { owner: "module" });
  assert.equal(resolve_dylink_address(0x1100n, [module]), undefined);
});

test("dylink address resolver returns only owner for interior data addresses", () => {
  assert.deepEqual(resolve_dylink_address(0x1080n, [object("module", 0x1000n, 0x100n)]), {
    owner: "module",
  });
});

test("dylink address resolver rejects cross-owner data and function ambiguity", () => {
  const objects = [
    object("one", 0x1000n, 0x100n, [{ name: "exact", address: 0x1080n }]),
    object("two", 0x1080n, 0x100n),
  ];
  assert.equal(resolve_dylink_address(0x1080n, objects), undefined);
  assert.equal(resolve_dylink_address(0x1080n, objects, { owner: "three" }), undefined);
});

test("dylink address resolver omits symbols for same-owner function and data ambiguity", () => {
  const objects = [object("module", 0x1000n, 0x100n, [{ name: "data", address: 0x1080n }])];
  assert.deepEqual(
    resolve_dylink_address(0x1080n, objects, {
      owner: "module",
      symbol: { name: "function", address: 0x1080n },
    }),
    { owner: "module" },
  );
});
