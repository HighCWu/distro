// SPDX-License-Identifier: MIT
import { blockDevice, bootMachine, consoleDevice, entropyDevice } from "@lowland/kernel";
import { guestAgent } from "@lowland/guest";
import { assertBrowserSupport } from "./browser-support.js";

const element = (id) => document.getElementById(id);
let session;
let busy = false;
function state(message) {
  element("state").textContent = message;
  element("start").disabled = busy || !!session;
  for (const id of ["stop", "uname", "file", "read"]) element(id).disabled = busy || !session;
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
  if (busy) return;
  busy = true;
  state("working");
  try {
    const message = await operation();
    if (message === "running" && !session) throw new Error("Linux stopped during the operation");
    busy = false;
    state(message);
  } catch (error) {
    busy = false;
    state(`error: ${error.message}`);
    console.error(error);
  }
}
element("start").addEventListener("click", () =>
  action(async () => {
    assertBrowserSupport();
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
    void machine.closed.then(
      () => {
        if (session === active) {
          session = undefined;
          if (!busy) state("stopped");
        }
      },
      (error) => {
        if (session === active) {
          session = undefined;
          state(`error: ${error.message}`);
        }
      },
    );
    return "running";
  }),
);
element("stop").addEventListener("click", () =>
  action(async () => {
    const active = session;
    if (!active) return "stopped";
    active.machine.close();
    try {
      await active.machine.closed;
      await active.output;
    } finally {
      if (session === active) session = undefined;
    }
    return "stopped";
  }),
);
async function command(args) {
  if (!session) throw new Error("Linux is not running");
  const result = await session.agent.run(args);
  const decode = (bytes) => new TextDecoder().decode(bytes);
  element("result").textContent = decode(result.stdout) + decode(result.stderr);
  if (!result.status.success)
    throw new Error(`native command failed: ${JSON.stringify(result.status)}`);
  return "running";
}
element("uname").addEventListener("click", () => action(() => command(["/bin/uname", "-a"])));
element("file").addEventListener("click", () =>
  action(async () => {
    if (!session) throw new Error("Linux is not running");
    await session.agent.fs.writeFile(
      "/root/example.txt",
      new TextEncoder().encode(element("contents").value),
    );
    return command(["/bin/cat", "/root/example.txt"]);
  }),
);
element("read").addEventListener("click", () =>
  action(() => command(["/bin/cat", "/root/example.txt"])),
);
state("stopped");
