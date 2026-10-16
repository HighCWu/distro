// SPDX-License-Identifier: MIT
import type { AgentAbi } from "./conn.ts";

/** The default asset is wasm32. A custom GPT agent image requires an explicit ABI. */
export type GuestAgentOptions =
  | { abi?: "wasm32"; image?: undefined }
  | { abi: AgentAbi; image: Uint8Array };

/** @internal Validate before creating devices; snapshot caller-owned image bytes. */
export function select_agent_image(options: GuestAgentOptions): {
  abi: AgentAbi | undefined;
  image: Uint8Array<ArrayBuffer> | undefined;
} {
  if (options === null || typeof options !== "object") {
    throw new TypeError("guest agent options must be an object");
  }
  // JavaScript callers need the same checks as the discriminated TS union.
  const { abi, image } = options as { abi?: AgentAbi; image?: Uint8Array };
  if (abi !== undefined && abi !== "wasm32" && abi !== "wasm64") {
    throw new RangeError("unsupported agent ABI");
  }
  if (image === undefined) {
    if (abi === "wasm64") throw new TypeError("wasm64 requires a matching custom agent image");
    return { abi, image: undefined };
  }
  if (abi === undefined) throw new TypeError("a custom agent image requires an explicit ABI");
  if (!(image instanceof Uint8Array)) throw new TypeError("agent image must be a Uint8Array");
  if (image.byteLength === 0 || image.byteLength % 512 !== 0) {
    throw new RangeError("agent image must contain a positive whole number of 512-byte sectors");
  }
  return { abi, image: new Uint8Array(image) };
}
