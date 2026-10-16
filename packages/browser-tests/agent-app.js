// SPDX-License-Identifier: MIT
import { runAgentWasm64Suite } from "./agent-suite.js";
import { runtimeAssertions } from "./agent-assertions.js";

globalThis.runNativeAgent = async () => {
  const response = await fetch("/agent-runtime.cpio");
  if (!response.ok) throw new Error(`agent initramfs load failed: ${response.status}`);
  return runAgentWasm64Suite(
    new Uint8Array(await response.arrayBuffer()),
    runtimeAssertions,
    async (name, body) => {
      await body();
      console.log(`native agent passed: ${name}`);
    },
    (line) => console.log(line.trimEnd()),
  );
};
