// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";

/** Test-only pipe handshake. Keep the same reader after consuming readiness:
 * a disturbed stream cannot subsequently become a Response body. */
export async function readReadyOutput(stream: ReadableStream<Uint8Array>, ready: string) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (!text.includes("\n")) {
      const next = await reader.read();
      if (next.done) throw new Error("stdout ended before readiness line");
      text += decoder.decode(next.value, { stream: true });
    }
    const end = text.indexOf("\n");
    assert.equal(text.slice(0, end), ready, "unexpected readiness output");
    const output = (async () => {
      let rest = text.slice(end + 1);
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) return rest + decoder.decode();
          rest += decoder.decode(next.value, { stream: true });
        }
      } finally {
        reader.releaseLock();
      }
    })();
    // The caller may still be replacing a host file or feeding stdin.
    // Preserve rejection for its await without an early unhandled rejection.
    void output.catch(() => {});
    return { output };
  } catch (error) {
    reader.releaseLock();
    throw error;
  }
}
