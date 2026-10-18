// SPDX-License-Identifier: MIT
import {
  runPythonGitRootWasm64Suite,
  verifyPythonGitRoot,
  withPythonGitRootMachine,
} from "./agent-python-git-root-suite.js";
import { runtimeAssertions } from "./agent-assertions.js";
import { workerDevice } from "@lowland/kernel";
import { openDiskWorker } from "./opfs-device.js";

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

globalThis.runOpfsPythonGitRoot = async (phase, name, expectedHead) => {
  if (phase !== "write" && phase !== "read")
    throw new Error("invalid Python Git persistence phase");
  if (!/^python-git-root-[a-f0-9-]+\.img$/.test(name))
    throw new Error("invalid Python Git disk name");
  if (
    phase === "read" &&
    (typeof expectedHead !== "string" || !/^[0-9a-f]{40}$/.test(expectedHead))
  )
    throw new Error("read requires the original Python Git HEAD");
  if (phase === "write" && expectedHead !== undefined)
    throw new Error("write must not supply a previous Python Git HEAD");
  const directory = await navigator.storage.getDirectory();
  if (phase === "write") {
    try {
      await directory.getFileHandle(name);
      throw new Error("Python Git disk already exists");
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
  // No create, capacity, template root or truncation on reopening an existing disk.
  const handle = await directory.getFileHandle(name);
  const [boot, source] = await Promise.all([
    image("/agent-boot.img"),
    image("/git-workspace-example.py"),
  ]);
  const worker = new Worker("/opfs-disk-worker.js", { type: "module" });
  try {
    const device = await openDiskWorker(worker, { handle }, workerDevice);
    let head;
    await withPythonGitRootMachine(
      boot,
      device,
      runtimeAssertions,
      async (agent) => {
        head = await verifyPythonGitRoot(agent, source, phase, expectedHead, runtimeAssertions);
      },
      (line) => console.log(line.trimEnd()),
    );
    await device.closed;
    return { phase, head, closed: true };
  } finally {
    worker.terminate();
  }
};
