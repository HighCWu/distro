// SPDX-License-Identifier: MIT
import { SystemError, type GuestAgent } from "../src/index.ts";
import type { RuntimeAssertions } from "./agent-wasm64-suite.ts";

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
