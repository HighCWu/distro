// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { maximumProgramBytes, outputTail, programArguments, runProgram } from "./program.js";

const wasm = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
const file = { size: wasm.length, arrayBuffer: async () => wasm.buffer };
const success = { success: true, code: 0, signal: null };
const zip = Uint8Array.of(80, 75, 3, 4, 1, 2, 3, 4);
const pythonFile = { size: zip.length, arrayBuffer: async () => zip.buffer };
const stream = (chunks = []) =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
function harness({
  status = success,
  stdout,
  stderr,
  cleanupError,
  writeError,
  inputFailure,
} = {}) {
  const calls = [];
  const agent = {
    fs: {
      async writeFile(path, bytes, options) {
        calls.push(["write", path, bytes, options]);
        if (writeError) throw writeError;
      },
      async chmod(path, mode) {
        calls.push(["chmod", path, mode]);
      },
    },
    async exec(argv, options) {
      calls.push(["exec", argv, options]);
      return {
        status: Promise.resolve(status),
        stdin: new WritableStream({
          write(bytes) {
            calls.push(["stdin-write", bytes]);
            if (inputFailure) throw inputFailure;
          },
          close() {
            calls.push("stdin-eof");
          },
        }),
        stdout: stream(stdout),
        stderr: stream(stderr),
        async close() {
          calls.push("child-close");
          if (cleanupError) throw cleanupError;
        },
      };
    },
  };
  return { agent, calls };
}

test("Python selection imports ZIP bytes and invokes the installed interpreter with literal argv", async () => {
  const { agent, calls } = harness();
  const status = await runProgram(agent, pythonFile, '["literal $HOME", "--x"]', {
    format: "python",
    inputText: "abc",
    onOutput() {},
  });
  assert.equal(status, success);
  const write = calls.find((entry) => entry[0] === "write");
  assert.equal(write[1], "/root/application.pyz");
  assert.deepEqual(write[2], zip);
  const exec = calls.find((entry) => entry[0] === "exec");
  assert.deepEqual(exec[1], [
    "/usr/bin/python3",
    "-I",
    "/root/application.pyz",
    "literal $HOME",
    "--x",
  ]);
  assert.equal(exec[2].stdinMode, "streaming");
  assert.equal(exec[2].cwd, "/root");
  assert.equal(calls.at(-1), "child-close");
});

test("format selection never guesses from filenames, and invalid formats perform no Linux I/O", async () => {
  const { agent, calls } = harness();
  await assert.rejects(runProgram(agent, pythonFile, "[]", { onOutput() {} }), /WebAssembly/);
  await assert.rejects(
    runProgram(agent, file, "[]", { format: "python", onOutput() {} }),
    /ZIP-format/,
  );
  await assert.rejects(
    runProgram(agent, file, "[]", { format: "auto", onOutput() {} }),
    /unsupported/,
  );
  const shebang = new TextEncoder().encode("#!/usr/bin/python3\nPK\x03\x04");
  await assert.rejects(
    runProgram(agent, { size: shebang.length, arrayBuffer: async () => shebang.buffer }, "[]", {
      format: "python",
      onOutput() {},
    }),
    /ZIP-format/,
  );
  assert.deepEqual(calls, []);
});

test("Python interpreter errors retain output and nonzero status, with process cleanup", async () => {
  const status = { success: false, code: 1, signal: null };
  const diagnostic = "invalid Python archive\n";
  const { agent, calls } = harness({ status, stderr: [new TextEncoder().encode(diagnostic)] });
  let output = "";
  assert.equal(
    await runProgram(agent, pythonFile, "[]", {
      format: "python",
      onOutput(_name, text) {
        output += text;
      },
    }),
    status,
  );
  assert.equal(output, diagnostic);
  assert.equal(calls.at(-1), "child-close");
});

test("binary stdin streams exact chunks without arrayBuffer or text conversion", async () => {
  const { agent, calls } = harness();
  const chunks = [Uint8Array.of(0, 255), Uint8Array.of(128, 1, 0, 254)];
  const inputFile = {
    size: 6,
    stream: () => stream(chunks),
    arrayBuffer() {
      throw new Error("must stream input");
    },
  };
  await runProgram(agent, file, "[]", { inputFile, inputText: null, onOutput() {} });
  assert.deepEqual(
    calls.filter((entry) => entry[0] === "stdin-write").map((entry) => entry[1]),
    chunks,
  );
  assert.equal(calls.filter((entry) => entry[0] === "write").length, 1); // executable only
  assert.ok(calls.includes("stdin-eof"));
  assert.equal(calls.at(-1), "child-close");
});

test("empty binary stdin sends EOF and does not use text fallback", async () => {
  const { agent, calls } = harness();
  await runProgram(agent, file, "[]", {
    inputFile: new Blob([]),
    inputText: "ignored",
    onOutput() {},
  });
  assert.equal(calls.filter((entry) => entry[0] === "stdin-write").length, 0);
  assert.ok(calls.includes("stdin-eof"));
});

test("missing or invalid binary input rejects before program import", async () => {
  const { agent, calls } = harness();
  for (const inputFile of [
    null,
    {},
    { size: -1, stream() {} },
    { size: 2 ** 53, stream() {} },
    { size: 1 },
  ])
    await assert.rejects(
      runProgram(agent, file, "[]", { inputFile, onOutput() {} }),
      /standard-input file/,
    );
  assert.deepEqual(calls, []);
});

test("binary input source failure is reported after child cleanup", async () => {
  const { agent, calls } = harness();
  const reason = new Error("input file read failed");
  const inputFile = {
    size: 1,
    stream: () =>
      new ReadableStream({
        start(controller) {
          controller.error(reason);
        },
      }),
  };
  await assert.rejects(
    runProgram(agent, file, "[]", { inputFile, onOutput() {} }),
    (error) => error === reason,
  );
  assert.equal(calls.at(-1), "child-close");
});

test("binary prefix EPIPE cancels the file source while retaining the real status", async () => {
  const reason = Object.assign(new Error("filter consumed a prefix"), { code: "EPIPE" });
  const { agent, calls } = harness({ inputFailure: reason });
  let cancelled;
  const inputFile = {
    size: 2,
    stream: () =>
      new ReadableStream(
        {
          pull(controller) {
            controller.enqueue(Uint8Array.of(255));
          },
          cancel(error) {
            cancelled = error;
          },
        },
        { highWaterMark: 0 },
      ),
  };
  const status = await runProgram(agent, file, "[]", { inputFile, onOutput() {} });
  assert.equal(status.success, true);
  assert.equal(cancelled, reason);
  assert.equal(calls.at(-1), "child-close");
});

test("cancelling a waiting binary input cancels its source and disposes the child", async () => {
  const { agent, calls } = harness();
  const controller = new AbortController();
  const started = Promise.withResolvers();
  let cancelled;
  const inputFile = {
    size: 1,
    stream() {
      started.resolve();
      return new ReadableStream({
        pull() {
          return new Promise(() => {});
        },
        cancel(reason) {
          cancelled = reason;
        },
      });
    },
  };
  const reason = new Error("stop file input");
  const running = runProgram(agent, file, "[]", {
    inputFile,
    signal: controller.signal,
    onOutput() {},
  });
  const rejected = assert.rejects(running, (error) => error === reason);
  await started.promise;
  controller.abort(reason);
  await rejected;
  assert.equal(cancelled, reason);
  assert.equal(calls.at(-1), "child-close");
});

test("program arguments use literal JSON strings, bounded size and no NULs", () => {
  assert.deepEqual(programArguments('["hello world", "$(not-a-shell)", "中文"]'), [
    "hello world",
    "$(not-a-shell)",
    "中文",
  ]);
  for (const text of [
    "{}",
    "[1]",
    '["\\u0000"]',
    JSON.stringify(Array(65).fill("")),
    " ".repeat(8193),
    "not JSON",
  ])
    assert.throws(() => programArguments(text));
  assert.equal(outputTail("a".repeat(65536), "z".repeat(10)), "a".repeat(65526) + "z".repeat(10));
});

test("invalid files and arguments are rejected before writing Linux files", async () => {
  const { agent, calls } = harness();
  const options = { onOutput() {} };
  for (const selected of [
    undefined,
    { ...file, size: maximumProgramBytes + 1 },
    { ...file, size: 7 },
    { ...file, size: 9 },
    { size: 8, arrayBuffer: async () => new Uint8Array(8).buffer },
  ])
    await assert.rejects(runProgram(agent, selected, "[]", options));
  await assert.rejects(runProgram(agent, file, "[null]", options));
  assert.deepEqual(calls, []);
});

test("program import forwards signal, executable mode and exact argv without a shell", async () => {
  const { agent, calls } = harness();
  const signal = new AbortController().signal;
  assert.equal(
    await runProgram(agent, file, '["literal $HOME"]', { signal, onOutput() {} }),
    success,
  );
  assert.deepEqual(calls, [
    ["write", "/root/application.wasm", wasm, { mode: 0o700, signal }],
    ["chmod", "/root/application.wasm", 0o700],
    [
      "exec",
      ["/root/application.wasm", "literal $HOME"],
      { cwd: "/root", signal, stdinMode: "streaming" },
    ],
    "stdin-eof",
    "child-close",
  ]);
});

test("stdout and stderr are streamed concurrently with independent UTF-8 decoders", async () => {
  const euro = new TextEncoder().encode("€");
  const { agent, calls } = harness({
    stdout: [euro.slice(0, 1), euro.slice(1)],
    stderr: [new TextEncoder().encode("stderr")],
  });
  const output = { stdout: "", stderr: "" };
  await runProgram(agent, file, "[]", {
    onOutput(name, text) {
      output[name] += text;
    },
  });
  assert.deepEqual(output, { stdout: "€", stderr: "stderr" });
  assert.equal(calls.at(-1), "child-close");
});

test("nonzero status is preserved while the child is still disposed", async () => {
  const status = { success: false, code: 37, signal: null };
  const { agent, calls } = harness({ status });
  assert.equal(await runProgram(agent, file, "[]", { onOutput() {} }), status);
  assert.equal(calls.at(-1), "child-close");
});

test("abort before import or after file read prevents writes and process creation", async () => {
  for (const preAborted of [true, false]) {
    const { agent, calls } = harness();
    const controller = new AbortController();
    const reason = new Error("cancel import");
    if (preAborted) controller.abort(reason);
    const selected = {
      ...file,
      async arrayBuffer() {
        controller.abort(reason);
        return wasm.buffer;
      },
    };
    await assert.rejects(
      runProgram(agent, selected, "[]", { signal: controller.signal, onOutput() {} }),
      (error) => error === reason,
    );
    assert.deepEqual(calls, []);
  }
});

test("output callback errors preserve the primary failure and await child cleanup", async () => {
  const primary = new Error("render failure");
  const cleanupError = new Error("close failure");
  for (const failure of [undefined, cleanupError]) {
    const { agent, calls } = harness({ stdout: [wasm], cleanupError: failure });
    await assert.rejects(
      runProgram(agent, file, "[]", {
        onOutput() {
          throw primary;
        },
      }),
      (error) =>
        failure
          ? error instanceof AggregateError &&
            error.cause === primary &&
            error.errors[0] === primary &&
            error.errors[1] === failure
          : error === primary,
    );
    assert.equal(calls.at(-1), "child-close");
  }
});

test("write failures do not chmod or start a program", async () => {
  const reason = new Error("disk full");
  const { agent, calls } = harness({ writeError: reason });
  await assert.rejects(
    runProgram(agent, file, "[]", { onOutput() {} }),
    (error) => error === reason,
  );
  assert.equal(calls.length, 1);
});

test("active cancellation forwards the exact reason and waits for process disposal", async () => {
  const { agent } = harness();
  const controller = new AbortController();
  const started = Promise.withResolvers();
  const status = Promise.withResolvers();
  const closing = Promise.withResolvers();
  const released = Promise.withResolvers();
  const reason = new Error("application cancelled");
  agent.exec = async (_argv, { signal }) => {
    assert.equal(signal, controller.signal);
    const abort = () => status.reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    started.resolve();
    return {
      status: status.promise,
      stdin: new WritableStream(),
      stdout: stream(),
      stderr: stream(),
      async close() {
        signal.removeEventListener("abort", abort);
        closing.resolve();
        await released.promise;
      },
    };
  };
  let settled = false;
  const running = runProgram(agent, file, "[]", { signal: controller.signal, onOutput() {} });
  const rejected = assert.rejects(running, (error) => error === reason);
  void running.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await started.promise;
  controller.abort(reason);
  await closing.promise;
  assert.equal(settled, false, "do not enable another launch while cleanup is pending");
  released.resolve();
  await rejected;
  assert.equal(settled, true);
});

test("stdin text is UTF-8 encoded including NUL bytes and followed by EOF", async () => {
  const { agent, calls } = harness();
  const inputText = "stdin → 中文\0\n";
  await runProgram(agent, file, "[]", { inputText, onOutput() {} });
  const written = calls.find((entry) => Array.isArray(entry) && entry[0] === "stdin-write");
  assert.deepEqual(written[1], new TextEncoder().encode(inputText));
  assert.ok(calls.indexOf(written) < calls.indexOf("stdin-eof"));
  assert.equal(calls.at(-1), "child-close");
});

test("invalid or oversized stdin is rejected before importing a program", async () => {
  const { agent, calls } = harness();
  for (const inputText of [null, 3, {}, "x".repeat(65537)])
    await assert.rejects(
      runProgram(agent, file, "[]", { inputText, onOutput() {} }),
      /standard input/,
    );
  assert.deepEqual(calls, []);
});

test("stdin transport failures are preserved and dispose the child", async () => {
  const reason = new Error("input transport failed");
  const { agent, calls } = harness({ inputFailure: reason });
  await assert.rejects(
    runProgram(agent, file, "[]", { inputText: "data", onOutput() {} }),
    (error) => error === reason,
  );
  assert.equal(calls.at(-1), "child-close");
});

test("a filter closing stdin early still requires its real successful or nonzero exit", async () => {
  for (const status of [success, { success: false, code: 37, signal: null }]) {
    const inputFailure = Object.assign(new Error("pipe closed"), { code: "EPIPE" });
    const { agent, calls } = harness({ inputFailure, status });
    assert.equal(await runProgram(agent, file, "[]", { inputText: "data", onOutput() {} }), status);
    assert.equal(calls.at(-1), "child-close");
  }
});

test(
  "stdout is drained while stdin is blocked, rather than waiting for input EOF",
  { timeout: 1000 },
  async () => {
    const { agent } = harness();
    const drained = Promise.withResolvers();
    const exited = Promise.withResolvers();
    let eof = false;
    agent.exec = async () => ({
      status: exited.promise,
      stdin: new WritableStream({
        async write() {
          await drained.promise;
        },
        close() {
          eof = true;
          exited.resolve(success);
        },
      }),
      stdout: stream([new TextEncoder().encode("drain output first")]),
      stderr: stream(),
      async close() {},
    });
    const result = await runProgram(agent, file, "[]", {
      inputText: "input",
      onOutput(_name, text) {
        if (text === "drain output first") drained.resolve();
      },
    });
    assert.equal(result, success);
    assert.equal(eof, true);
  },
);
