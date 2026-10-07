// SPDX-License-Identifier: MIT
import { blockDevice, bootMachine, consoleDevice, entropyDevice } from "@lowland/kernel";
import { snapshot_block_device } from "/node_modules/@lowland/kernel/dist/immutable-image.js";
import { LineDecoder, parseResult } from "./protocol.js";

async function load(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`failed to load ${path}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

globalThis.runErofsCopies = async () => {
  let machine;
  let finished = false;
  let timeout;
  let output = "";
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // Register rejection handling even if a console reports failure during boot.
  const completion = result.then((value) => value);
  void completion.catch(() => {});
  const consoleOutput = () => {
    const decoder = new LineDecoder();
    const consume = (lines) => {
      for (const line of lines) {
        output += `${line}\n`;
        console.log(line);
        const status = parseResult(line);
        if (status?.passed) resolveResult();
        else if (status) rejectResult(new Error(status.reason));
        else if (line.includes("Kernel panic - not syncing")) rejectResult(new Error(line));
      }
    };
    return new WritableStream({
      write(chunk) { consume(decoder.write(chunk)); },
      close() { consume(decoder.close()); },
      abort(error) { rejectResult(new Error(`console failed: ${error}`)); },
    });
  };
  try {
    await Promise.race([
      (async () => {
        const [initcpio, image] = await Promise.all([load("/erofs.cpio"), load("/erofs.img")]);
        if (finished) return;
        const input = new TransformStream();
        const ordinary = blockDevice({
          capacity: image.byteLength,
          read(offset, target) {
            const bytes = image.subarray(offset, offset + target.byteLength);
            target.set(bytes);
            return bytes.byteLength;
          },
        });
        machine = await bootMachine({
          cpus: 4,
          initcpio,
          plugins: [consoleDevice(input.readable, consoleOutput()), entropyDevice(),
            snapshot_block_device(image), ordinary],
        });
        // A boot that finishes after the watchdog must not leak its Workers.
        if (finished) { machine.close(); return; }
        void machine.bootConsole.pipeTo(consoleOutput()).catch(rejectResult);
        void machine.closed.then(
          () => rejectResult(new Error("machine closed before test completion")), rejectResult,
        );
        await completion;
      })(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`EROFS test timed out:\n${output}`)), 240_000);
      }),
    ]);
  } finally {
    finished = true;
    clearTimeout(timeout);
    if (machine) {
      machine.close();
      let closeTimeout;
      try {
        await Promise.race([
          machine.closed,
          new Promise((_, reject) => {
            closeTimeout = setTimeout(() => reject(new Error("machine close timed out")), 10_000);
          }),
        ]);
      } finally { clearTimeout(closeTimeout); }
    }
  }
  return { passed: true, output, machineClosed: true };
};
