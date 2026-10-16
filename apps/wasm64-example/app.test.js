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
        failClose(error) {
          closed.reject(error);
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
  h.nodes("stdin").value = "text for the application";
  const running = h.click("run-program");
  assert.equal(h.applications[0].options.inputText, "text for the application");
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

test("input source choice forwards a file or explicit missing-file value without text fallback", async () => {
  const h = harness();
  await h.click("start");
  h.nodes("stdin-source").value = "file";
  const selected = { size: 100, stream() {} };
  h.nodes("stdin-file").files = [selected];
  const running = h.click("run-program");
  assert.equal(h.applications[0].options.inputFile, selected);
  h.applications[0].result.resolve(success.status);
  await running;
  h.nodes("stdin-file").files = [];
  const missing = h.click("run-program");
  assert.equal(h.applications[1].options.inputFile, null);
  h.applications[1].result.reject(new Error("select a standard-input file"));
  await missing;
  assert.match(h.nodes("state").textContent, /standard-input file/);
  h.nodes("stdin-source").value = "text";
  h.nodes("stdin-file").files = [selected];
  const text = h.click("run-program");
  assert.equal(h.applications[2].options.inputFile, undefined);
  h.applications[2].result.resolve(success.status);
  await text;
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

for (const failure of [false, true]) {
  test(`unexpected machine ${failure ? "failure" : "closure"} releases the UI while an application is pending`, async () => {
    const h = harness();
    await h.click("start");
    const running = h.click("run-program");
    const error = new Error("machine crashed");
    if (failure) h.machines[0].failClose(error);
    else h.machines[0].finishClose();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.nodes("state").textContent, failure ? "error: machine crashed" : "stopped");
    assert.equal(h.nodes("start").disabled, false);
    assert.equal(h.nodes("cancel-program").disabled, true);
    assert.equal(h.applications[0].options.signal.aborted, true);
    await h.click("start");
    assert.equal(h.machines.length, 2);
    const replacement = h.click("run-program");
    h.applications[0].options.onOutput("stdout", "obsolete output");
    h.applications[0].result.reject(new Error("obsolete operation failed"));
    await running;
    assert.equal(h.nodes("state").textContent, "running application");
    assert.equal(h.nodes("result").textContent, "");
    assert.equal(h.nodes("cancel-program").disabled, false);
    assert.equal(h.applications[1].options.signal.aborted, false);
    h.applications[1].result.resolve(success.status);
    await replacement;
    await h.click("stop");
  });
}

test("unexpected machine closure invalidates a pending command before restart", async () => {
  const h = harness();
  await h.click("start");
  const result = Promise.withResolvers();
  h.agents[0].run = () => result.promise;
  const command = h.click("uname");
  h.machines[0].finishClose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.nodes("start").disabled, false);
  await h.click("start");
  result.resolve(success);
  await command;
  assert.equal(h.nodes("result").textContent, "");
  assert.equal(h.nodes("state").textContent, "running");
  await h.click("stop");
});
