// SPDX-License-Identifier: MIT
import { runPythonGitRootWasm64Suite } from "./agent-python-git-root-suite.js";
import { runtimeAssertions } from "./agent-assertions.js";

async function image(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Python Git asset load failed: ${path}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

globalThis.runNativePythonGitRoot = async () => {
  const [boot, root, source] = await Promise.all([
    image("/agent-boot.img"),
    image("/agent-root.ext4"),
    image("/git-workspace-example.py"),
  ]);
  return runPythonGitRootWasm64Suite(
    boot,
    root,
    source,
    runtimeAssertions,
    async (name, body) => {
      await body();
      console.log(`Python Git root passed: ${name}`);
    },
    (line) => console.log(line.trimEnd()),
  );
};
