#!/usr/bin/env node

import { fstatSync, fsyncSync, openSync, readFileSync, readSync, writeSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { LineDecoder, parseResult, writeConsoleLines } from "./protocol.js";
import { closeTestResources } from "./shutdown.js";

let cpus = 1;
let snapshotFirstDisk = false;
let readOnlyDisks = false;
const positional = [];
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--cpus") {
    cpus = Number(args[++index]);
  } else if (args[index] === "--snapshot-first-disk") {
    snapshotFirstDisk = true;
  } else if (args[index] === "--readonly-disks") {
    readOnlyDisks = true;
  } else {
    positional.push(args[index]);
  }
}
const [linuxPath, initramfsPath, ...diskPaths] = positional;
if (!linuxPath || !initramfsPath || !Number.isSafeInteger(cpus) || cpus < 1) {
  throw new Error("usage: run-test.js [--cpus <count>] <linux-module> <initramfs> [disk ...]");
}

const { blockDevice, bootMachine, consoleDevice, entropyDevice } = await import(
  pathToFileURL(linuxPath).href
);
// Fail before acquiring disk handles or constructing devices for a missing image.
const initcpio = readFileSync(initramfsPath);

let resolveResult;
const result = new Promise((resolve) => {
  resolveResult = resolve;
});
let settled = false;
let runtimeFailure;
let shuttingDown = false;
let machine;
let initialMemoryBytes;
let observingMemoryGrowth = false;
let memoryGrowthStage = 0;
let previousMemoryBytes;

const KERNEL_MEMORY_MAXIMUM_BYTES = 0xffff * 0x10000;
const MAXIMUM_EXPECTED_INITIAL_MEMORY_BYTES = 16 * 0x100000;

function finish(value) {
  // A pass wakes the runner so shutdown can begin; it does not erase errors
  // subsequently observed while the device and console queues are draining.
  if (!value.passed) runtimeFailure ??= value;
  if (settled) return;
  settled = true;
  resolveResult(value);
}

function consumeLine(line, acceptTestResult = true) {
  if (!acceptTestResult) {
    if (line.includes("Kernel panic - not syncing")) finish({ passed: false, reason: line });
    return;
  }
  if (line === "::kernel-memory::ready") {
    observingMemoryGrowth = true;
    console.log(`kernel memory after spawn: ${initialMemoryBytes} bytes`);
    if (initialMemoryBytes >= MAXIMUM_EXPECTED_INITIAL_MEMORY_BYTES) {
      finish({
        passed: false,
        reason: `kernel memory started at ${initialMemoryBytes} bytes instead of growing on demand`,
      });
      return;
    }
    observeMemoryGrowth(0);
    return;
  }
  if (line === "::kernel-memory::sequential") {
    observeMemoryGrowth(1);
    return;
  }

  const testResult = parseResult(line);
  if (testResult) {
    if (observingMemoryGrowth && testResult.passed) observeMemoryGrowth(2);
    finish(testResult);
  } else if (line.includes("Kernel panic - not syncing")) {
    finish({ passed: false, reason: line });
  }
}

function observeMemoryGrowth(stage) {
  if (!machine) {
    finish({ passed: false, reason: "guest reported before machine initialization completed" });
    return;
  }
  if (stage !== memoryGrowthStage) {
    finish({ passed: false, reason: `unexpected kernel memory stage ${stage}` });
    return;
  }

  const current = machine.memory.buffer.byteLength;
  const names = ["ready", "sequential", "concurrent"];
  console.log(`kernel memory after ${names[stage]} stage: ${current} bytes`);
  if (stage > 0 && current <= previousMemoryBytes) {
    finish({
      passed: false,
      reason: `kernel memory did not grow: ${previousMemoryBytes} -> ${current} bytes`,
    });
    return;
  }
  if (current >= KERNEL_MEMORY_MAXIMUM_BYTES) {
    finish({ passed: false, reason: "kernel memory jumped to its maximum" });
    return;
  }

  previousMemoryBytes = current;
  memoryGrowthStage++;
  if (stage < 2) void inputWriter.write(new Uint8Array([0x0a]));
}

function consoleOutput({ failWhenClosed, acceptTestResult = true }) {
  const decoder = new LineDecoder();
  const consume = (lines) =>
    writeConsoleLines(process.stdout, lines, (line) => consumeLine(line, acceptTestResult));
  return new WritableStream({
    write(chunk) {
      consume(decoder.write(chunk));
    },
    close() {
      consume(decoder.close());
      if (failWhenClosed && !settled) {
        finish({
          passed: false,
          reason: "guest console closed before reporting a result",
        });
      }
    },
    abort(error) {
      consume(decoder.close());
      // The console device uses a reasonless abort for intentional shutdown.
      if (!shuttingDown || error !== undefined)
        finish({ passed: false, reason: `user console failed: ${error}` });
    },
  });
}

const input = new TransformStream();
const inputWriter = input.writable.getWriter();
const devices = [
  consoleDevice(input.readable, consoleOutput({ failWhenClosed: true })),
  entropyDevice(),
];

const disks = [];
let startupFailed = false;
try {
  for (const [diskIndex, diskPath] of diskPaths.entries()) {
    if (snapshotFirstDisk && diskIndex === 0) {
      const { snapshot_block_device } = await import(
        new URL("./immutable-image.js", pathToFileURL(linuxPath)).href
      );
      devices.push(snapshot_block_device(readFileSync(diskPath)));
      continue;
    }
    const disk = openSync(diskPath, readOnlyDisks ? "r" : "r+");
    disks.push(disk);
    const { size } = fstatSync(disk);
    devices.push(
      blockDevice({
        capacity: size,
        read: async (offset, data) => {
          let read = 0;
          while (read < data.length) {
            const length = readSync(disk, data, read, data.length - read, offset + read);
            if (length === 0) break;
            read += length;
          }
          return read;
        },
        write: readOnlyDisks
          ? undefined
          : async (offset, data) => {
              let written = 0;
              while (written < data.length) {
                written += writeSync(disk, data, written, data.length - written, offset + written);
              }
              return written;
            },
        flush: readOnlyDisks ? undefined : async () => fsyncSync(disk),
      }),
    );
  }

  machine = await bootMachine({
    cpus,
    plugins: devices,
    initcpio,
  });
} catch (error) {
  startupFailed = true;
  console.error(`::vm-test::fail: runner startup failed: ${error}`);
  finish({ passed: false, reason: `machine failed to boot: ${error}` });
}

if (machine) initialMemoryBytes = machine.memory.buffer.byteLength;

void machine?.bootConsole
  .pipeTo(consoleOutput({ failWhenClosed: false, acceptTestResult: false }))
  .catch((error) => {
    if (!shuttingDown || error !== undefined)
      finish({ passed: false, reason: `boot console failed: ${error}` });
  });
void machine?.closed.catch((error) => {
  finish({ passed: false, reason: `machine failed: ${error}` });
});

const outcome = await result;
let cleanupFailed = false;
shuttingDown = true;
try {
  await closeTestResources(machine, disks);
} catch (error) {
  console.error(`::vm-test::fail: runner cleanup failed: ${error}`);
  cleanupFailed = true;
}

const finalOutcome = runtimeFailure ?? outcome;
if (!finalOutcome.passed) console.error(`vm test failed: ${finalOutcome.reason}`);
process.exitCode = finalOutcome.passed && !startupFailed && !cleanupFailed ? 0 : 1;
