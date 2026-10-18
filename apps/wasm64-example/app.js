// SPDX-License-Identifier: MIT
import {
  blockDevice,
  closeDevice,
  bootMachine,
  consoleDevice,
  entropyDevice,
  workerDevice,
} from "@lowland/kernel";
import { guestAgent } from "@lowland/guest";
import { assertBrowserSupport } from "./browser-support.js";
import { outputTail, runProgram } from "./program.js";
import { prepareDownload } from "./download.js";
import { openRoot } from "./root.js";
import { deleteRootDisk, listRootDisks } from "./root-storage.js";
import { openDiskWorker } from "linux-wasm-opfs-device";

const element = (id) => document.getElementById(id);
let session;
let busy = false;
let programController;
let stopping;
let generation = 0;
let downloadUrl;
function clearDownload() {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = undefined;
  element("download-link").hidden = true;
  element("download-link").removeAttribute("href");
}
function state(message) {
  element("state").textContent = message;
  element("start").disabled = busy || !!session || !!stopping;
  element("stop").disabled = !session || !!stopping;
  for (const id of ["uname", "file", "read", "run-program", "download"])
    element(id).disabled = busy || !session || !!stopping;
  element("cancel-program").disabled =
    !!stopping || !programController || programController.signal.aborted;
  element("save-stop").disabled = busy || !session || !!stopping;
  for (const id of ["storage-mode", "disk-name", "refresh-disks", "delete-disk"])
    element(id).disabled = busy || !!session || !!stopping;
}
function consoleOutput() {
  const decoder = new TextDecoder();
  const append = (text) => {
    element("console").textContent = (element("console").textContent + text).slice(-65536);
  };
  return new WritableStream({
    write(bytes) {
      append(decoder.decode(bytes, { stream: true }));
    },
    close() {
      append(decoder.decode());
    },
  });
}
async function image(path, { stream = false } = {}) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`image download failed: ${path}: ${response.status}`);
  if (stream) {
    if (!response.body) throw new Error(`image download has no response body: ${path}`);
    return response.body;
  }
  return new Uint8Array(await response.arrayBuffer());
}
async function action(operation) {
  if (busy || stopping) return;
  const ownGeneration = ++generation;
  busy = true;
  state("working");
  try {
    const message = await operation();
    if (ownGeneration !== generation) return;
    if (message === "running" && !session) throw new Error("Linux stopped during the operation");
    busy = false;
    state(message);
  } catch (error) {
    if (ownGeneration !== generation) return;
    busy = false;
    state(`error: ${error.message}`);
    console.error(error);
  }
}
element("start").addEventListener("click", () =>
  action(async () => {
    assertBrowserSupport();
    clearDownload();
    element("console").textContent = "";
    element("result").textContent = "";
    const boot = await image("/agent-boot.img");
    const root = await openRoot(
      { mode: element("storage-mode").value, name: element("disk-name").value },
      { loadImage: image, blockDevice, closeDevice, workerDevice, openWorker: openDiskWorker },
    );
    let agent;
    let machine;
    try {
      agent = guestAgent({ abi: "wasm64", image: boot });
      machine = await bootMachine({
        cpus: 1,
        plugins: [
          root.device,
          agent,
          consoleDevice(
            new ReadableStream({
              start(controller) {
                controller.close();
              },
            }),
            consoleOutput(),
          ),
          entropyDevice(),
        ],
      });
    } catch (error) {
      try {
        await root.close();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], "Linux boot and disk cleanup failed");
      }
      throw error;
    }
    const output = machine.bootConsole.pipeTo(consoleOutput());
    void output.catch(() => {});
    const active = { agent, machine, output, root };
    session = active;
    const ended = (message, reason) => {
      // Machine closure is authoritative even if an old operation never
      // settles. Stop owns its separate cleanup path until output is drained.
      if (session !== active || stopping) return;
      void stopSession(active, message, reason);
    };
    void machine.closed.then(
      () => ended("stopped", new DOMException("Linux stopped", "AbortError")),
      (error) => ended(`error: ${error.message}`, error),
    );
    return "running";
  }),
);
element("refresh-disks").addEventListener("click", () => {
  if (session || stopping) return;
  return action(async () => {
    // Clear old observations first, including when the new listing fails.
    element("saved-disks").textContent = "";
    const disks = await listRootDisks();
    element("saved-disks").textContent = disks.length
      ? disks.map(({ name, size }) => `${name} — ${size} bytes`).join("\n")
      : "No saved disks";
    return "saved disks listed";
  });
});
element("delete-disk").addEventListener("click", () => {
  if (session || stopping) return;
  return action(async () => {
    const name = element("disk-name").value;
    const confirmation = prompt(
      `Permanently delete saved disk "${name}" and all its Linux files? Type the exact disk name to confirm. This cannot be undone here.`,
      "",
    );
    if (confirmation === null) return "disk deletion cancelled";
    await deleteRootDisk({ name, confirmation });
    element("saved-disks").textContent = "Disk deleted. Refresh the list to see current disks.";
    return `deleted disk: ${name}`;
  });
});
async function stopSession(
  active,
  message = "stopped",
  reason = new DOMException("Linux stopped", "AbortError"),
) {
  if (!active || stopping) return;
  // Stop must not queue behind an application, its descendants' pipes, or
  // outstanding filesystem work. Invalidate their UI ownership immediately.
  ++generation;
  clearDownload();
  stopping = active;
  busy = true;
  programController?.abort(reason);
  programController = undefined;
  state("stopping");
  try {
    active.machine.close();
    const results = await Promise.allSettled([active.machine.closed, active.output]);
    const failures = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    try {
      await active.root.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length)
      throw failures.length === 1
        ? failures[0]
        : new AggregateError(failures, "Linux or disk close failed");
  } catch (error) {
    message = `error: ${error.message}`;
    console.error(error);
  } finally {
    if (session === active) session = undefined;
    stopping = undefined;
    busy = false;
    state(message);
  }
}
element("stop").addEventListener("click", () => stopSession(session));
element("save-stop").addEventListener("click", () =>
  action(async () => {
    const active = session;
    if (!active) throw new Error("Linux is not running");
    const result = await active.agent.run(["/bin/sync"]);
    if (session !== active || stopping) throw new Error("Linux stopped during synchronization");
    if (!result.status.success)
      throw new Error("Linux sync failed; disk remains open for retry or Stop");
    await stopSession(active);
    return "stopped";
  }),
);
async function command(args, active = session) {
  if (!active || session !== active || stopping) throw new Error("Linux is not running");
  const result = await active.agent.run(args);
  if (session !== active || stopping) throw new Error("Linux stopped during the operation");
  const decode = (bytes) => new TextDecoder().decode(bytes);
  element("result").textContent = decode(result.stdout) + decode(result.stderr);
  if (!result.status.success)
    throw new Error(`native command failed: ${JSON.stringify(result.status)}`);
  return "running";
}
element("uname").addEventListener("click", () => action(() => command(["/bin/uname", "-a"])));
element("file").addEventListener("click", () =>
  action(async () => {
    const active = session;
    if (!active) throw new Error("Linux is not running");
    await active.agent.fs.writeFile(
      "/root/example.txt",
      new TextEncoder().encode(element("contents").value),
    );
    return command(["/bin/cat", "/root/example.txt"], active);
  }),
);
element("read").addEventListener("click", () =>
  action(() => command(["/bin/cat", "/root/example.txt"])),
);
element("download").addEventListener("click", () =>
  action(async () => {
    const active = session;
    if (!active) throw new Error("Linux is not running");
    clearDownload();
    const prepared = await prepareDownload(active.agent.fs, element("download-path").value);
    if (session !== active || stopping) throw new Error("Linux stopped during the download");
    downloadUrl = URL.createObjectURL(prepared.blob);
    const link = element("download-link");
    link.href = downloadUrl;
    link.download = prepared.name;
    link.hidden = false;
    return "running";
  }),
);
state("stopped");

element("run-program").addEventListener("click", () =>
  action(async () => {
    const active = session;
    if (!active) throw new Error("Linux is not running");
    const controller = new AbortController();
    programController = controller;
    element("result").textContent = "";
    state("running application");
    try {
      const status = await runProgram(
        active.agent,
        element("program").files[0],
        element("arguments").value,
        {
          signal: controller.signal,
          format: element("program-kind").value,
          inputText: element("stdin").value,
          inputFile:
            element("stdin-source").value === "file"
              ? (element("stdin-file").files[0] ?? null)
              : undefined,
          onOutput(_name, text) {
            if (session === active && !stopping)
              element("result").textContent = outputTail(element("result").textContent, text);
          },
        },
      );
      if (!status.success) throw new Error(`native application failed: ${JSON.stringify(status)}`);
      return "running";
    } finally {
      if (programController === controller) programController = undefined;
    }
  }),
);
element("cancel-program").addEventListener("click", () => {
  programController?.abort(new DOMException("application cancelled", "AbortError"));
  element("cancel-program").disabled = true;
});
