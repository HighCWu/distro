// SPDX-License-Identifier: MIT
import { runAgentWasm64Suite } from "./agent-suite.js";
import { runtimeAssertions } from "./agent-assertions.js";
import { blockDevice } from "@lowland/kernel";

globalThis.runNativeAgent = async ({ productionRoot = false } = {}) => {
  const response = await fetch("/agent-runtime.cpio");
  if (!response.ok) throw new Error(`agent initramfs load failed: ${response.status}`);
  const plugins = [];
  if (productionRoot) {
    const root = await fetch("/agent-root.erofs");
    if (!root.ok) throw new Error(`agent root load failed: ${root.status}`);
    const bytes = new Uint8Array(await root.arrayBuffer());
    plugins.push(
      blockDevice({
        capacity: bytes.byteLength,
        read(offset, target) {
          const source = bytes.subarray(offset, offset + target.byteLength);
          target.set(source);
          return source.byteLength;
        },
      }),
    );
  }
  return runAgentWasm64Suite(
    new Uint8Array(await response.arrayBuffer()),
    runtimeAssertions,
    async (name, body) => {
      await body();
      console.log(`native agent passed: ${name}`);
    },
    (line) => console.log(line.trimEnd()),
    { productionRoot, plugins },
  );
};
