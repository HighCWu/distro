// SPDX-License-Identifier: MIT
import {
  bootMachine,
  closeDevice,
  consoleDevice,
  entropyDevice,
  vsockDevice,
} from "@lowland/kernel";
import { MemoryFs, serveNinep } from "./node_modules/@lowland/kernel/dist/virtio/ninep/host.js";
import { runRuntimeSmoke } from "./runtime-smoke.js";

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
    const fs = new MemoryFs();
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
