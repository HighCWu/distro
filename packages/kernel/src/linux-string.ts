// SPDX-License-Identifier: MIT

// Linux C strings carry bytes, including filenames which are not valid UTF-8.
// Preserve ordinary Unicode and escape each undecodable byte as U+DC80..DCFF.
// These escapes stay private to the host and are reversed before calling libc.
export function decode_linux_bytes(input: Uint8Array): string {
  // Browser decoders may reject SharedArrayBuffer views. Own one stable copy.
  const bytes = new Uint8Array(input);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  try {
    return decoder.decode(bytes);
  } catch {
    let result = "";
    for (let i = 0; i < bytes.length;) {
      const first = bytes[i]!;
      if (first < 128) {
        result += String.fromCharCode(first);
        i++;
        continue;
      }
      const count =
        first >= 0xc2 && first <= 0xdf
          ? 2
          : first >= 0xe0 && first <= 0xef
            ? 3
            : first >= 0xf0 && first <= 0xf4
              ? 4
              : 0;
      if (count && i + count <= bytes.length) {
        try {
          result += decoder.decode(bytes.subarray(i, i + count));
          i += count;
          continue;
        } catch {
          // An invalid continuation, overlong scalar or encoded surrogate
          // belongs to the byte namespace, not a replacement-character alias.
        }
      }
      result += String.fromCharCode(0xdc00 + first);
      i++;
    }
    return result;
  }
}

export function encode_linux_string(value: string): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  if (!/[\udc80-\udcff]/.test(value)) return encoder.encode(value);
  const pieces: Uint8Array[] = [];
  let literal = "";
  let length = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code >= 0xdc80 && code <= 0xdcff) {
      const encoded = encoder.encode(literal);
      pieces.push(encoded, Uint8Array.of(code - 0xdc00));
      length += encoded.length + 1;
      literal = "";
    } else {
      // for-of retains a valid surrogate pair as one code point: an emoji's
      // low half must never become an escaped filename byte.
      literal += character;
    }
  }
  const tail = encoder.encode(literal);
  pieces.push(tail);
  length += tail.length;
  const result = new Uint8Array(length);
  let offset = 0;
  for (const piece of pieces) {
    result.set(piece, offset);
    offset += piece.length;
  }
  return result;
}
