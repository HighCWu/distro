// SPDX-License-Identifier: MIT

import { assert } from "../util.ts";
import { VirtioController, type VirtioDevice, type Virtqueue } from "./core.ts";

/** A virtio entropy source, feeding Linux's randomness pool from `crypto.getRandomValues`. */
export function entropyDevice(): VirtioDevice {
  function notify(queue: Virtqueue) {
    for (const chain of queue) {
      let n = 0;
      for (const { array, writable } of chain) {
        assert(writable);

        // Web Crypto accepts at most 65536 bytes per call and does not accept
        // SharedArrayBuffer views. Bound temporary storage as well as each call.
        const scratch = new Uint8Array(Math.min(array.length, 65536));
        for (let offset = 0; offset < array.length; offset += scratch.length) {
          const chunk = scratch.subarray(0, Math.min(scratch.length, array.length - offset));
          crypto.getRandomValues(chunk);
          array.set(chunk, offset);
        }

        n += array.byteLength;
      }
      chain.release(n);
    }
  }

  return new VirtioController({ deviceId: 4 }, { queues: [notify] }).device;
}
