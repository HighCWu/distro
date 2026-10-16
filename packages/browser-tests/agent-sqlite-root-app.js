// SPDX-License-Identifier: MIT
import { runSqliteRootWasm64Suite } from "./agent-sqlite-root-suite.js";
import { runtimeAssertions } from "./agent-assertions.js";

async function image(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`SQLite image load failed: ${path}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}
globalThis.runNativeSqliteRoot = async () => {
  const [boot, root] = await Promise.all([image("/agent-boot.img"), image("/agent-root.ext4")]);
  return runSqliteRootWasm64Suite(
    boot,
    root,
    runtimeAssertions,
    async (name, body) => {
      await body();
      console.log(`SQLite root passed: ${name}`);
    },
    (line) => console.log(line.trimEnd()),
  );
};
