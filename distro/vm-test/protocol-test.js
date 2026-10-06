import assert from "node:assert/strict";
import test from "node:test";
import { Writable } from "node:stream";
import { LineDecoder, parseResult, writeConsoleChunk } from "./protocol.js";

const encoder = new TextEncoder();

test("queued console output survives reuse of borrowed shared-memory bytes", () => {
  const borrowed = new Uint8Array(new SharedArrayBuffer(6));
  borrowed.set(encoder.encode("hello\n"));
  let complete;
  let printed;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      complete = () => {
        printed = Buffer.from(chunk).toString();
        callback();
      };
    },
  });

  writeConsoleChunk(output, borrowed);
  borrowed.fill(0);
  complete();
  assert.equal(printed, "hello\n");
  output.end();
});

test("decodes records split across arbitrary chunks", () => {
  const decoder = new LineDecoder();
  const lines = [
    ...decoder.write(encoder.encode("booting\n::vm-")),
    ...decoder.write(encoder.encode("test::pass\r")),
    ...decoder.write(encoder.encode("\n")),
  ];

  assert.deepEqual(lines, ["booting", "::vm-test::pass"]);
  assert.deepEqual(parseResult(lines[1]), { passed: true });
});

test("preserves a guest failure explanation", () => {
  assert.deepEqual(parseResult("::vm-test::fail: getcwd returned /"), {
    passed: false,
    reason: "getcwd returned /",
  });
});

test("ignores marker-like workload output", () => {
  assert.equal(parseResult("prefix ::vm-test::pass"), undefined);
  assert.equal(parseResult("::vm-test::failure"), undefined);
});
