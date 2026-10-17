// SPDX-License-Identifier: MIT
// Host substitute only: exercises the real runner without booting Linux.
export const consoleDevice = (_input, output) => ({ output });
export const entropyDevice = () => ({});
export const blockDevice = (storage) => ({ storage });

export async function bootMachine({ plugins }) {
  const writer = plugins[0].output.getWriter();
  await writer.write(new TextEncoder().encode("::vm-test::pass\n"));
  const closed = Promise.withResolvers();
  void closed.promise.catch(() => {});
  return {
    memory: new WebAssembly.Memory({ initial: 1 }),
    bootConsole: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    closed: closed.promise,
    close() {
      setImmediate(async () => {
        try {
          const bytes = new Uint8Array(512);
          if ((await plugins[2].storage.read(0, bytes)) !== 512 || bytes[0] !== 0x37)
            throw new Error("fixture disk mismatch");
          console.log("fixture: late disk read completed");
          if (process.env.RUNNER_FIXTURE_FAIL === "1") throw new Error("fixture flush failed");
          closed.resolve();
        } catch (error) {
          closed.reject(error);
        }
      });
    },
  };
}
