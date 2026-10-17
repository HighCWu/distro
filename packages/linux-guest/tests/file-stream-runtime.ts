// SPDX-License-Identifier: MIT
import { SystemError, type GuestAgent } from "../src/index.ts";
import type { RuntimeAssertions } from "./agent-wasm64-suite.ts";

export async function checkFileStreamErrors(
  fs: GuestAgent["fs"],
  assert: RuntimeAssertions,
  path: string,
) {
  await fs.writeTextFile(path, "retained data");
  const readonly = await fs.open(path);
  const writer = readonly.writable.getWriter();
  try {
    await assert.rejects(
      writer.write(Uint8Array.of(42)),
      (error) => error instanceof SystemError && error.code === "EBADF",
    );
    await assert.rejects(readonly.stat(), (error) => error instanceof TypeError);
  } finally {
    writer.releaseLock();
    await readonly.close();
  }
  const directory = await fs.open("/tmp");
  const reader = directory.readable.getReader();
  try {
    await assert.rejects(
      reader.read(),
      (error) => error instanceof SystemError && error.code === "EISDIR",
    );
    await assert.rejects(directory.stat(), (error) => error instanceof TypeError);
  } finally {
    reader.releaseLock();
    await directory.close();
  }
  assert.equal(await fs.readTextFile(path), "retained data");
  const invalid = await fs.open(path, { write: true });
  const invalidWriter = invalid.writable.getWriter();
  try {
    await assert.rejects(
      invalid.write("not bytes" as unknown as Uint8Array),
      (error) => error instanceof TypeError,
    );
    assert.equal((await invalid.stat()).size, 13);
    await assert.rejects(
      invalidWriter.write("not bytes" as unknown as Uint8Array),
      (error) => error instanceof TypeError,
    );
    await assert.rejects(invalid.stat(), (error) => error instanceof TypeError);
  } finally {
    invalidWriter.releaseLock();
    await invalid.close();
  }
  assert.equal(await fs.readTextFile(path), "retained data");
  // One stream chunk spans several syscall payloads. Verify its complete
  // contents through Linux, not just the mocked request ordering checks.
  const payload = Uint8Array.from(
    { length: 256 * 1024 + 17 },
    (_, index) => (index * 37 + 11) & 255,
  );
  const output = await fs.open(path, { write: true, truncate: true });
  const outputWriter = output.writable.getWriter();
  try {
    await outputWriter.write(payload);
    await outputWriter.close();
  } finally {
    outputWriter.releaseLock();
    await output.close();
  }
  assert.deepEqual(await fs.readFile(path), payload);
  await fs.remove(path);
}
