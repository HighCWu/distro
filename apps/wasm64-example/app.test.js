// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { outputTail } from "./program.js";

const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const imports = /^import .* from "[^"]+";$/gm;
assert.equal([...source.matchAll(imports)].length, 4);
const success = {
  status: { success: true, code: 0, signal: null },
  stdout: new TextEncoder().encode("Linux fixture\n"),
  stderr: new Uint8Array(),
};
function harness({ closeError, deferClose = false } = {}) {
  const elements = new Map();
  const nodes = (id) => {
    if (!elements.has(id))
      elements.set(id, {
        textContent: "",
        disabled: false,
        value: id === "arguments" ? "[]" : "text",
        files: [{}],
        listeners: {},
        addEventListener(name, listener) {
          this.listeners[name] = listener;
        },
      });
    return elements.get(id);
  };
  const machines = [];
  const applications = [];
  const agents = [];
  const context = {
    document: { getElementById: nodes },
    console: { error() {} },
    Uint8Array,
    TextDecoder,
    TextEncoder,
    ReadableStream,
    WritableStream,
    AbortController,
    DOMException,
    assertBrowserSupport() {},
    outputTail,
    fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }),
    blockDevice: (device) => device,
    consoleDevice() {},
    entropyDevice() {},
    guestAgent() {
      const agent = {
        commands: [],
        fs: { async writeFile() {} },
        async run(args) {
          this.commands.push(args);
          return success;
        },
      };
      agents.push(agent);
      return agent;
    },
    async bootMachine() {
      const closed = Promise.withResolvers();
      const machine = {
        closed: closed.promise,
        bootConsole: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        closes: 0,
        close() {
          this.closes++;
          if (closeError) closed.reject(closeError);
          else if (!deferClose) closed.resolve();
        },
        finishClose() {
          closed.resolve();
        },
      };
      machines.push(machine);
      return machine;
    },
    runProgram(_agent, _file, _arguments, options) {
      const result = Promise.withResolvers();
      applications.push({ options, result });
      return result.promise;
    },
  };
  runInNewContext(source.replace(imports, ""), context);
  return { nodes, agents, machines, applications, click: (id) => nodes(id).listeners.click() };
}

test("Stop Linux remains usable during an application and old output cannot affect a restart", async () => {
  const h = harness();
  await h.click("start");
  const running = h.click("run-program");
  assert.equal(h.nodes("stop").disabled, false);
  await h.click("stop");
  assert.equal(h.machines[0].closes, 1);
  assert.equal(h.applications[0].options.signal.aborted, true);
  assert.equal(h.nodes("state").textContent, "stopped");
  await h.click("start");
  await h.click("uname");
  const output = h.nodes("result").textContent;
  h.applications[0].options.onOutput("stdout", "stale output");
  h.applications[0].result.resolve(success.status);
  await running;
  assert.equal(h.nodes("result").textContent, output);
  assert.equal(h.nodes("state").textContent, "running");
  assert.equal(h.nodes("start").disabled, true);
  await h.click("stop");
});

test("a stopped file operation never runs cat in a replacement machine", async () => {
  const h = harness();
  await h.click("start");
  const write = Promise.withResolvers();
  h.agents[0].fs.writeFile = () => write.promise;
  const writing = h.click("file");
  await h.click("stop");
  await h.click("start");
  write.resolve();
  await writing;
  assert.equal(h.agents[1].commands.length, 0);
  assert.equal(h.nodes("state").textContent, "running");
  await h.click("stop");
});

test("late command errors cannot overwrite a replacement machine's state", async () => {
  const h = harness();
  await h.click("start");
  const result = Promise.withResolvers();
  h.agents[0].run = () => result.promise;
  const command = h.click("uname");
  await h.click("stop");
  await h.click("start");
  result.reject(new Error("old connection closed"));
  await command;
  assert.equal(h.nodes("state").textContent, "running");
  await h.click("stop");
});

test("machine close failures remain visible without waiting for application completion", async () => {
  const h = harness({ closeError: new Error("disk close failed") });
  await h.click("start");
  const running = h.click("run-program");
  await h.click("stop");
  assert.equal(h.nodes("state").textContent, "error: disk close failed");
  assert.equal(h.nodes("start").disabled, false);
  h.applications[0].result.reject(new Error("old application terminated"));
  await running;
  assert.equal(h.nodes("state").textContent, "error: disk close failed");
});

test("restart remains blocked until the old machine closure settles", async () => {
  const h = harness({ deferClose: true });
  await h.click("start");
  const stopping = h.click("stop");
  assert.equal(h.nodes("state").textContent, "stopping");
  assert.equal(h.nodes("start").disabled, true);
  assert.equal(h.nodes("stop").disabled, true);
  await h.click("start");
  assert.equal(h.machines.length, 1);
  h.machines[0].finishClose();
  await stopping;
  await h.click("start");
  assert.equal(h.machines.length, 2);
  const finalStop = h.click("stop");
  h.machines[1].finishClose();
  await finalStop;
});
