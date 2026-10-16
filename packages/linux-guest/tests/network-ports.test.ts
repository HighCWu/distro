// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { createPortAllocator } from "../src/network-ports.ts";

test("port allocation checks the last available candidate, including port 65535", () => {
  const allocate = createPortAllocator();
  const visited: number[] = [];
  assert.equal(
    allocate((port) => {
      visited.push(port);
      return port !== 65535;
    }),
    65535,
  );
  assert.equal(visited.length, 16384);
  assert.equal(new Set(visited).size, 16384);
  assert.equal(
    allocate(() => false),
    49152,
    "the cursor wraps after the upper endpoint",
  );
});

test("a full allocation failure checks each port exactly once and preserves the cursor", () => {
  const allocate = createPortAllocator();
  for (let index = 0; index < 7; index++)
    assert.equal(
      allocate(() => false),
      49152 + index,
    );
  const visited: number[] = [];
  assert.throws(
    () =>
      allocate((port) => {
        visited.push(port);
        return true;
      }),
    /no network ports available/,
  );
  assert.equal(visited.length, 16384);
  assert.equal(new Set(visited).size, 16384);
  assert.equal(visited[0], 49159);
  assert.equal(visited.at(-1), 49158);
  assert.equal(
    allocate(() => false),
    49159,
  );
});

test("a released port immediately before the cursor remains discoverable", () => {
  const allocate = createPortAllocator();
  assert.equal(
    allocate(() => false),
    49152,
  );
  assert.equal(
    allocate((port) => port !== 49152),
    49152,
  );
});

test("allocation remains round-robin over every inclusive port across repeated cycles", () => {
  const allocate = createPortAllocator();
  for (let index = 0; index < 16384 * 2 + 5; index++) {
    assert.equal(
      allocate(() => false),
      49152 + (index % 16384),
    );
  }
});

test("separate networks retain independent cursors", () => {
  const left = createPortAllocator(),
    right = createPortAllocator();
  assert.equal(
    left(() => false),
    49152,
  );
  assert.equal(
    left(() => false),
    49153,
  );
  assert.equal(
    right(() => false),
    49152,
  );
});
