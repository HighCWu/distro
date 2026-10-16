// SPDX-License-Identifier: MIT
import { runMinimalRootWasm64Suite } from "./agent-minimal-root-suite.js";
import { runtimeAssertions } from "./agent-assertions.js";

async function loadImage(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`minimal root image load failed: ${path}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

globalThis.runMinimalNativeRoot = async () => {
  const [image, root] = await Promise.all([
    loadImage("/agent-boot.img"),
    loadImage("/agent-root.erofs"),
  ]);
  return runMinimalRootWasm64Suite(
    image,
    root,
    runtimeAssertions,
    async (name, body) => {
      await body();
      console.log(`minimal root passed: ${name}`);
    },
    (line) => console.log(line.trimEnd()),
  );
};
