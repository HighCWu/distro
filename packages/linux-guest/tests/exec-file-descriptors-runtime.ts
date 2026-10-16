// SPDX-License-Identifier: MIT
import type { GuestAgent } from "../src/index.ts";
import type { RuntimeAssertions } from "./agent-wasm64-suite.ts";

export const descriptorCheckScript = `
[ -d /proc/self/fd ] || exit 20
/bin/readlink /proc/self/fd/0 >/dev/null || exit 22
for entry in /proc/self/fd/*; do
  target=$(/bin/readlink "$entry" 2>/dev/null) || continue
  if [ "$target" = "$1" ] || [ "$target" = "$2" ]; then
    printf 'inherited SDK descriptor: %s\\n' "$target" >&2
    exit 21
  fi
done
`;

// Shared wasm32/wasm64 native check. An open SDK handle and a stalled streamed
// upload must remain usable by the agent, but not be inherited across exec.
export async function checkExecFileDescriptors(
  agent: Pick<GuestAgent, "fs" | "run">,
  assert: RuntimeAssertions,
  prefix: string,
) {
  const heldPath = `${prefix}-held`;
  const uploadPath = `${prefix}-upload`;
  await agent.fs.writeTextFile(heldPath, "held");
  const held = await agent.fs.open(heldPath);
  const ready = Promise.withResolvers<void>();
  let input: ReadableStreamDefaultController<Uint8Array> | undefined;
  const source = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        input = controller;
        ready.resolve();
      },
      cancel() {
        input = undefined;
      },
    },
    // Pull is evidence that writeFile has opened its descriptor, not an eager
    // source prefetch before the operation starts.
    { highWaterMark: 0 },
  );
  const writing = agent.fs.writeFile(uploadPath, source);
  void writing.catch(() => {});
  try {
    await Promise.race([ready.promise, writing]);
    assert.equal(input !== undefined, true);
    const result = await agent.run(
      ["/bin/sh", "-c", descriptorCheckScript, "sdk-descriptor-check", heldPath, uploadPath],
      { signal: AbortSignal.timeout(10000) },
    );
    assert.deepEqual(result.status, { success: true, code: 0, signal: null });
    assert.equal(result.stderr.byteLength, 0);
    const bytes = new Uint8Array(4);
    assert.equal(await held.read(bytes), 4);
    assert.equal(new TextDecoder().decode(bytes), "held");
  } finally {
    input?.close();
    try {
      await writing;
    } finally {
      await held.close();
      await agent.fs.remove(heldPath);
      await agent.fs.remove(uploadPath);
    }
  }
}
