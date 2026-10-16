// SPDX-License-Identifier: MIT
import {
  runPersistentRootWasm64Suite,
  withPersistentRootMachine,
  writePersistentRoot,
  readPersistentRoot,
} from "./agent-persistent-root-suite.js";
import { workerDevice } from "@lowland/kernel";
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

// The caller retains only a unique OPFS filename across page reloads.
globalThis.runOpfsNativeRoot = async (phase, name) => {
  if (phase !== "write" && phase !== "read") throw new Error("invalid persistence phase");
  if (!/^native-root-[a-f0-9-]+\.img$/.test(name)) throw new Error("invalid test disk name");
  const directory = await navigator.storage.getDirectory();
  if (phase === "write") {
    // Refuse to overwrite an existing test disk.
    try {
      await directory.getFileHandle(name);
      throw new Error("test disk already exists");
    } catch (error) {
      if (error.name !== "NotFoundError") throw error;
    }
    const bytes = await loadImage("/agent-root.ext4");
    const handle = await directory.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(bytes);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }
  }
  const handle = await directory.getFileHandle(name);
  const image = await loadImage("/agent-boot.img");
  const worker = new Worker("/opfs-disk-worker.js", { type: "module" });
  try {
    const pending = workerDevice(worker);
    void pending.catch(() => {});
    // Reopen the existing image without capacity: never truncate it on readback.
    worker.postMessage({ handle });
    const device = await pending;
    await withPersistentRootMachine(
      image,
      device,
      runtimeAssertions,
      (agent) =>
        (phase === "write" ? writePersistentRoot : readPersistentRoot)(agent, runtimeAssertions),
      (line) => console.log(line.trimEnd()),
    );
    await device.closed;
    return { phase, closed: true };
  } finally {
    worker.terminate();
  }
};
