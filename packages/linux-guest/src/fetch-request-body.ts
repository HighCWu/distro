// SPDX-License-Identifier: MIT
export class RequestBodyTooLarge extends Error {}

export function supportsRequestStreams(): boolean {
  let duplexRead = false;
  try {
    const request = new Request("https://example.invalid/", {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      get duplex() {
        duplexRead = true;
        return "half";
      },
    } as RequestInit);
    // Some browsers stringify an unsupported stream instead of throwing.
    return duplexRead && !request.headers.has("content-type");
  } catch {
    return false;
  }
}

export async function bufferRequestBody(
  body: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = body.getReader();
  let bytes = new Uint8Array(0);
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.byteLength > limit - length)
        throw new RequestBodyTooLarge("buffered request body exceeds limit");
      // Do not retain one object per chunk: even empty or single-byte chunks
      // must not amplify retained storage beyond the byte budget.
      const required = length + value.byteLength;
      if (required > bytes.length) {
        const capacity = Math.min(limit, Math.max(required, 4096, bytes.length * 2));
        const grown = new Uint8Array(capacity);
        grown.set(bytes.subarray(0, length));
        bytes = grown;
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
    return length === bytes.length ? bytes : bytes.slice(0, length);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
