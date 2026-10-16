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
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.byteLength > limit - length)
        throw new RequestBodyTooLarge("buffered request body exceeds limit");
      chunks.push(value.slice());
      length += value.byteLength;
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
