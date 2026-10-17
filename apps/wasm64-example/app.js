// SPDX-License-Identifier: MIT
import { blockDevice, bootMachine, consoleDevice, entropyDevice } from "@lowland/kernel";
import { guestAgent } from "@lowland/guest";
import { assertBrowserSupport } from "./browser-support.js";
import { outputTail, runProgram } from "./program.js";
import { prepareDownload } from "./download.js";

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
async function image(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`image download failed: ${path}: ${response.status}`);
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
    const [boot, root] = await Promise.all([image("/agent-boot.img"), image("/root.ext4")]);
    const agent = guestAgent({ abi: "wasm64", image: boot });
    const machine = await bootMachine({
      cpus: 1,
      plugins: [
        blockDevice({
          capacity: root.byteLength,
          read(offset, target) {
            target.set(root.subarray(offset, offset + target.byteLength));
            return target.byteLength;
          },
          write(offset, data) {
            root.set(data, offset);
            return data.byteLength;
          },
          flush() {}, // Only memory is retained; this is not durable storage.
        }),
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
    const output = machine.bootConsole.pipeTo(consoleOutput());
    void output.catch(() => {});
    const active = { agent, machine, output };
    session = active;
    const ended = (message, reason) => {
      // Machine closure is authoritative even if an old operation never
      // settles. Stop owns its separate cleanup path until output is drained.
      if (session !== active || stopping) return;
      ++generation;
      session = undefined;
      clearDownload();
      busy = false;
      programController?.abort(reason);
      programController = undefined;
      state(message);
    };
    void machine.closed.then(
      () => ended("stopped", new DOMException("Linux stopped", "AbortError")),
      (error) => ended(`error: ${error.message}`, error),
    );
    return "running";
  }),
);
element("stop").addEventListener("click", async () => {
  const active = session;
  if (!active || stopping) return;
  // Stop must not queue behind an application, its descendants' pipes, or
  // outstanding filesystem work. Invalidate their UI ownership immediately.
  ++generation;
  clearDownload();
  stopping = active;
  busy = true;
  programController?.abort(new DOMException("Linux stopped", "AbortError"));
  programController = undefined;
  state("stopping");
  let message = "stopped";
  try {
    active.machine.close();
    const results = await Promise.allSettled([active.machine.closed, active.output]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  } catch (error) {
    message = `error: ${error.message}`;
    console.error(error);
  } finally {
    if (session === active) session = undefined;
    stopping = undefined;
    busy = false;
    state(message);
  }
});
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
