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
  await fs.remove(path);
}
