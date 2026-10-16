// SPDX-License-Identifier: MIT
import {
  runSqliteRootWasm64Suite,
  verifySqliteRoot,
  withPersistentRootMachine,
} from "./agent-sqlite-root-suite.js";
import { runtimeAssertions } from "./agent-assertions.js";
import { workerDevice } from "@lowland/kernel";
import { openDiskWorker } from "./opfs-device.js";

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

globalThis.runOpfsSqliteRoot = async (phase, name) => {
  if (phase !== "write" && phase !== "read") throw new Error("invalid SQLite persistence phase");
  if (!/^sqlite-root-[a-f0-9-]+\.img$/.test(name)) throw new Error("invalid SQLite disk name");
  const directory = await navigator.storage.getDirectory();
  if (phase === "write") {
    try {
      await directory.getFileHandle(name);
      throw new Error("SQLite disk already exists");
    } catch (error) {
      if (error.name !== "NotFoundError") throw error;
    }
    const root = await image("/agent-root.ext4");
    const handle = await directory.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(root);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }
  }
  const handle = await directory.getFileHandle(name);
  const boot = await image("/agent-boot.img");
  const worker = new Worker("/opfs-disk-worker.js", { type: "module" });
  try {
    // Omit capacity when opening the existing filesystem: never truncate it.
    const device = await openDiskWorker(worker, { handle }, workerDevice);
    await withPersistentRootMachine(
      boot,
      device,
      runtimeAssertions,
      (agent) => verifySqliteRoot(agent, phase, runtimeAssertions),
      (line) => console.log(line.trimEnd()),
    );
    await device.closed;
    return { phase, closed: true };
  } finally {
    worker.terminate();
  }
};
