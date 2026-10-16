// SPDX-License-Identifier: MIT
import { runPublicAgentWasm64Suite } from "./agent-public-suite.js";
import { runtimeAssertions } from "./agent-assertions.js";

async function loadImage(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`agent image load failed: ${path}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

globalThis.runPublicNativeAgent = async () => {
  const [image, root] = await Promise.all([
    loadImage("/agent-boot.img"),
    loadImage("/agent-root.erofs"),
  ]);
  return runPublicAgentWasm64Suite(
    image,
    root,
    runtimeAssertions,
    async (name, body) => {
      await body();
      console.log(`public agent passed: ${name}`);
    },
    (line) => console.log(line.trimEnd()),
  );
};
