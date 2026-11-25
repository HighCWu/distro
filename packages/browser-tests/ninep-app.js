// SPDX-License-Identifier: MIT
import {
  bootMachine,
  closeDevice,
  consoleDevice,
  entropyDevice,
  vsockDevice,
} from "@lowland/kernel";
import {
  importNinepBrowserDirectorySnapshot,
  serveNinep,
} from "./node_modules/@lowland/kernel/dist/ninep.js";
import { runRuntimeSmoke } from "./runtime-smoke.js";

async function createSnapshot() {
  const origin = await navigator.storage.getDirectory();
  const name = `ninep-smoke-${crypto.randomUUID()}`;
  const root = await origin.getDirectoryHandle(name, { create: true });
  try {
    const project = await root.getDirectoryHandle("project", { create: true });
    const input = await project.getFileHandle("input.txt", { create: true });
    const data = await input.createWritable();
    try {
      await data.write("linux-wasm 9p transport\n");
      await data.close();
    } catch (error) {
      await data.abort().catch(() => {});
      throw error;
    }
    const snapshot = await importNinepBrowserDirectorySnapshot(root, {
      maxBytes: 256,
      maxEntries: 4,
    });
    // Exercise the Linux filename through the export after reading the real
    // OPFS file. Host filesystem name handling is independent of 9P decoding.
    snapshot.rename("/project/input.txt", "/project/\uFEFFinput.txt");
    return snapshot;
  } finally {
    await origin.removeEntry(name, { recursive: true });
  }
}

globalThis.bootNinepRuntimeSmoke = async () => {
  if (!crossOriginIsolated) throw new Error("9P runtime requires cross-origin isolation");
  const profile = await fetch("./profile.json");
  if (!profile.ok) throw new Error(`9P profile load failed: ${profile.status}`);
  const { cpus } = await profile.json();
  const vsock = vsockDevice();
  let server;
  let session;
  let deviceHandedOff = false;
  try {
    const fs = await createSnapshot();
    fs.writeFile("/message.txt", "linux-wasm 9p transport\n");
    server = serveNinep(vsock, { port: 18109 });
    session = server.add(fs, { readOnly: false });
    if (session.name !== "fs1") throw new Error("invalid first 9P export name");

    const { promise: hostCompleted, resolve, reject } = Promise.withResolvers();
    let attached = false;
    let hostBytes;
    session.onConnection = (connected) => {
      if (connected) {
        attached = true;
        return;
      }
      if (!attached) return;
      try {
        const written = fs.readFile("/written.bin");
        if (
          written.length !== 12546 ||
          written.some((byte, index) => byte !== (index * 37 + 11) % 251)
        ) {
          throw new Error("9P host file differs from the Linux write pattern");
        }
        hostBytes = written.length;
        resolve();
      } catch (error) {
        reject(error);
      }
    };

    const output = await runRuntimeSmoke({
      cpus,
      bootMachine(options) {
        deviceHandedOff = true;
        return bootMachine({ ...options, plugins: [...options.plugins, vsock] });
      },
      consoleDevice,
      entropyDevice,
      additionalCompletion: hostCompleted,
      async loadInitramfs() {
        const response = await fetch("./ninep-memory.cpio");
        if (!response.ok) throw new Error(`9P initramfs load failed: ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      },
    });
    return { output, hostBytes };
  } finally {
    if (session) session.onConnection = undefined;
    try {
      await server?.close();
    } finally {
      if (!deviceHandedOff) await closeDevice(vsock);
    }
  }
};
