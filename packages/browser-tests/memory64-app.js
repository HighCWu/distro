import { bootMachine } from "@lowland/kernel";

globalThis.bootMemory64Smoke = async () => {
  const machine = await bootMachine({ cpus: 1, args: ["panic=-1"] });
  const reader = machine.bootConsole.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let timeout;

  try {
    await Promise.race([
      (async () => {
        while (!output.includes("Linux version")) {
          const { value, done } = await reader.read();
          if (done) throw new Error(`Memory64 kernel stopped before its banner:\n${output}`);
          output += decoder.decode(value, { stream: true });
        }
      })(),
      machine.closed.then(() => {
        throw new Error(`Memory64 kernel stopped before its banner:\n${output}`);
      }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Memory64 kernel boot timed out")), 20_000);
      }),
    ]);
    return output;
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
    machine.close();
    await machine.closed.catch(() => {});
  }
};
