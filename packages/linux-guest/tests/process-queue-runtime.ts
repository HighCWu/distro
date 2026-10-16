// SPDX-License-Identifier: MIT
import type { Exec } from "../src/client.ts";
import type { ChildProcess } from "../src/process.ts";
import type { RuntimeAssertions } from "./agent-wasm64-suite.ts";

// Fill the SDK's eight slots with real long-running programs, then cancel
// the ninth without releasing any of them. No timer-based child expiration.
export async function checkQueuedExecAbort(client: { exec: Exec }, assert: RuntimeAssertions) {
  const children: ChildProcess[] = [];
  let queued: Promise<ChildProcess> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const reason = new Error("cancel queued native process");
  try {
    for (let i = 0; i < 8; i++) children.push(await client.exec(["/bin/sleep", "30"]));
    queued = client.exec(["/bin/true"], { signal: controller.signal });
    void queued.catch(() => {});
    // The cached connection continuation enters admission before this one.
    await Promise.resolve();
    controller.abort(reason);
    await assert.rejects(
      Promise.race([
        queued,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("queued exec ignored cancellation")), 5000);
        }),
      ]),
      (error) => error === reason,
    );
  } finally {
    clearTimeout(timer);
    await Promise.all(children.map((child) => child.close()));
    // Dispose an unexpected late child if a regression made exec resolve.
    const unexpected = await queued?.catch(() => undefined);
    await unexpected?.close();
  }
  const next = await client.exec(["/bin/true"]);
  try {
    assert.deepEqual(await next.status, { success: true, code: 0, signal: null });
  } finally {
    await next.close();
  }
}
