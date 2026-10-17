// SPDX-License-Identifier: MIT
// Host substitute only: exercises the real runner without booting Linux.
export const consoleDevice = (_input, output) => ({ output });
export const entropyDevice = () => ({});
export const blockDevice = (storage) => {
  if (process.env.RUNNER_FIXTURE_SETUP_CHECK === "1") {
    process.once("beforeExit", async () => {
      try {
        await storage.read(0, new Uint8Array(512));
        console.log("fixture: fd leaked after failed setup");
      } catch (error) {
        if (error.code === "EBADF") console.log("fixture: fd closed after failed setup");
        else throw error;
      }
    });
  }
  return { storage };
};

export async function bootMachine({ plugins }) {
  const writer = plugins[0].output.getWriter();
  const scenario = process.env.RUNNER_FIXTURE_SCENARIO;
  const write = (line) => writer.write(new TextEncoder().encode(line));
  if (scenario !== "boot-pass") {
    await write(
      "::vm-test::pass\n" + (scenario === "same-chunk" ? "::vm-test::fail: late failure\n" : ""),
    );
    if (scenario === "separate-chunk") await write("::vm-test::fail: late failure\n");
  }
  if (process.env.RUNNER_FIXTURE_BOOT_FAIL === "1")
    throw new Error("fixture boot failed after pass");
  const closed = Promise.withResolvers();
  void closed.promise.catch(() => {});
  return {
    memory: new WebAssembly.Memory({ initial: 1 }),
    bootConsole: new ReadableStream({
      start(controller) {
        if (scenario === "boot-panic")
          controller.enqueue(
            new TextEncoder().encode("Kernel panic - not syncing: late boot failure"),
          );
        if (scenario === "boot-pass") {
          controller.enqueue(new TextEncoder().encode("::vm-test::pass\n"));
          setTimeout(() => {
            void write("::vm-test::fail: no user pass\n");
          }, 10);
        }
        controller.close();
      },
    }),
    closed: closed.promise,
    close() {
      setImmediate(async () => {
        try {
          if (scenario === "shutdown-fail") await write("::vm-test::fail: late failure\n");
          if (scenario === "shutdown-panic")
            await write("Kernel panic - not syncing: late failure\n");
          if (scenario === "buffered-fail") await write("::vm-test::fail: late failure");
          if (["normal-abort", "error-abort", "buffered-fail"].includes(scenario))
            await writer.abort(
              scenario === "error-abort" ? new Error("late console error") : undefined,
            );
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
