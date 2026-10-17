// SPDX-License-Identifier: MIT
import { SystemError, type GuestAgent } from "../src/index.ts";
import type { RuntimeAssertions } from "./agent-wasm64-suite.ts";

export async function checkInvalidWriteInput(
  fs: GuestAgent["fs"],
  assert: RuntimeAssertions,
  prefix: string,
) {
  const existing = `${prefix}-existing`;
  const partial = `${prefix}-partial`;
  await fs.writeTextFile(existing, "keep original bytes");
  for (const value of ["text", new ArrayBuffer(0), new Uint16Array(0)]) {
    await assert.rejects(
      fs.writeFile(existing, value as unknown as Uint8Array),
      (error) => error instanceof TypeError,
    );
  }
  assert.equal(await fs.readTextFile(existing), "keep original bytes");
  const bytes = Uint8Array.of(0, 255, 42);
  let chunks = 0;
  let cancelled: unknown;
  const input = new ReadableStream<unknown>(
    {
      pull(controller) {
        if (chunks === 2) controller.close();
        else controller.enqueue(chunks++ === 0 ? bytes : "not a byte chunk");
      },
      cancel(error) {
        cancelled = error;
      },
    },
    { highWaterMark: 0 },
  );
  await assert.rejects(
    fs.writeFile(partial, input as ReadableStream<Uint8Array>),
    (error) => error instanceof TypeError && error === cancelled,
  );
  assert.equal(input.locked, false);
  assert.deepEqual(await fs.readFile(partial), bytes);
  await fs.remove(existing);
  await fs.remove(partial);
}

export async function checkLockedWriteInput(
  fs: GuestAgent["fs"],
  assert: RuntimeAssertions,
  prefix: string,
) {
  const existing = `${prefix}-existing`;
  const absent = `${prefix}-absent`;
  await fs.writeTextFile(existing, "keep original bytes");
  const payload = Uint8Array.of(0, 255, 42);
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(payload);
      controller.close();
    },
  });
  const reader = input.getReader();
  try {
    for (const path of [existing, absent])
      await assert.rejects(fs.writeFile(path, input), (error) => error instanceof TypeError);
    assert.equal(await fs.readTextFile(existing), "keep original bytes");
    await assert.rejects(
      fs.stat(absent),
      (error) => error instanceof SystemError && error.code === "ENOENT",
    );
  } finally {
    reader.releaseLock();
  }
  await fs.writeFile(absent, input);
  assert.equal(input.locked, false);
  assert.deepEqual(await fs.readFile(absent), payload);
  await fs.remove(existing);
  await fs.remove(absent);
}
