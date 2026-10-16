// SPDX-License-Identifier: MIT
import { runPersistentRootWasm64Suite } from "./agent-persistent-root-suite.js";
import { runtimeAssertions } from "./agent-assertions.js";

async function loadImage(path) {
  const response = await fetch(path);
  if (!response.ok)
    throw new Error(`persistent root image load failed: ${path}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

globalThis.runPersistentNativeRoot = async () => {
  const [image, root] = await Promise.all([
    loadImage("/agent-boot.img"),
    loadImage("/agent-root.ext4"),
  ]);
  return runPersistentRootWasm64Suite(
    image,
    root,
    runtimeAssertions,
    async (name, body) => {
      await body();
      console.log(`persistent root passed: ${name}`);
    },
    (line) => console.log(line.trimEnd()),
  );
};
