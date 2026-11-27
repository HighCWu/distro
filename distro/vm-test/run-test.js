#!/usr/bin/env node

import { fstatSync, fsyncSync, openSync, readFileSync, readSync, writeSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { LineDecoder, parseResult, writeConsoleLines } from "./protocol.js";
import { closeTestResources } from "./shutdown.js";

let cpus = 1;
let snapshotFirstDisk = false;
let readOnlyDisks = false;
let vsockRoundtrip = false;
let ninepServer;
let ninepExport;
let ninepMemory = false;
const positional = [];
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--cpus") {
    cpus = Number(args[++index]);
  } else if (args[index] === "--snapshot-first-disk") {
    snapshotFirstDisk = true;
  } else if (args[index] === "--readonly-disks") {
    readOnlyDisks = true;
  } else if (args[index] === "--vsock-roundtrip") {
    vsockRoundtrip = true;
  } else if (args[index] === "--ninep") {
    ninepServer = args[++index];
    ninepExport = args[++index];
    if (!ninepServer || !ninepExport) throw new Error("--ninep requires a server and export path");
  } else if (args[index] === "--ninep-memory") {
    ninepMemory = true;
  } else {
    positional.push(args[index]);
  }
}
const [linuxPath, initramfsPath, ...diskPaths] = positional;
const vsockModes = Number(vsockRoundtrip) + Number(Boolean(ninepServer)) + Number(ninepMemory);
if (
  !linuxPath ||
  !initramfsPath ||
  !Number.isSafeInteger(cpus) ||
  cpus < 1 ||
  (vsockModes !== 0 && diskPaths.length !== 0) ||
  vsockModes > 1
) {
  throw new Error(
    "usage: run-test.js [--cpus <count>] [--vsock-roundtrip | --ninep <server> <export> | --ninep-memory] <linux-module> <initramfs> [disk ...]",
  );
}

const ninep = ninepServer || ninepMemory ? await import("./ninep-host.js") : null;
const linuxModule = pathToFileURL(linuxPath);
const { blockDevice, bootMachine, consoleDevice, entropyDevice, vsockDevice } = await import(
  linuxModule.href
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
let userConsoleClosed = false;
let machine;
let initialMemoryBytes;
let observingMemoryGrowth = false;
let memoryGrowthStage = 0;
let previousMemoryBytes;
let vsock;
let vsockListener;
let ninepMemoryHost;
let vsockTask;
let vsockTimer;
let vsockHostPassed = false;
let vsockUserPassed = false;
const vsockAbort = new AbortController();

const KERNEL_MEMORY_MAXIMUM_BYTES = 0xffff * 0x10000;
const MAXIMUM_EXPECTED_INITIAL_MEMORY_BYTES = 16 * 0x100000;

function finish(value) {
  // A pass wakes the runner so shutdown can begin; it does not erase errors
  // subsequently observed while the device and console queues are draining.
  if (!value.passed) runtimeFailure ??= value;
  if (settled) return;
  if (value.passed && vsock) {
    vsockUserPassed = true;
    if (!vsockHostPassed) return;
  }
  settled = true;
  resolveResult(value);
}

const VSOCK_FIXTURE_PORT = 4050;
const VSOCK_FIXTURE_TIMEOUT_MS = 60_000;
const VSOCK_REQUESTS = [
  [0x41, 0, 0x18, 0xff, 0x5a, 0x10, 0x80, 0x33],
  [0x42, 0x01, 0, 0xd2, 0x80, 0x7f, 0x29, 0xfe],
];
const VSOCK_REPLIES = [
  [0x61, 0x55, 0, 0x80, 0x31, 0xee, 0x05, 0x9a],
  [0x62, 0, 0x44, 0xda, 0x02, 0x77, 0xa9, 0x01],
];
const VSOCK_FINAL_REPLY = [0x6a, 0x09, 0xff, 0, 0x33, 0x88, 0x17, 0xde];

function observeVsock(exercise) {
  vsockTask = exercise
    .then(() => {
      vsockHostPassed = true;
      if (vsockUserPassed) finish({ passed: true });
    })
    .catch((error) => {
      finish({ passed: false, reason: String(error) });
    });
}

async function readVsockFixtureBytes(stream, expected, stage) {
  const actual = await stream.readExactly(expected.length);
  if (actual.length !== expected.length || expected.some((value, index) => actual[index] !== value))
    throw new Error(`vsock roundtrip: unexpected bytes for ${stage}`);
}

async function exerciseVsock(listener) {
  const streams = [];
  try {
    for (let index = 0; index < 2; index++) {
      const stream = await listener.accept();
      if (!stream) throw new Error("vsock roundtrip: listener closed before both accepts");
      streams.push(stream);
    }
    await Promise.all(
      streams.map((stream, index) =>
        readVsockFixtureBytes(stream, VSOCK_REQUESTS[index], `stream ${index + 1} request`),
      ),
    );
    console.log("vsock host: accepted two streams and verified distinct requests");

    async function checkEof() {
      if ((await streams[0].read()).length !== 0)
        throw new Error("vsock roundtrip: expected EOF after stream 1 acknowledgment");
    }
    async function sendReplies() {
      // Reverse the response order to expose mixing between accepted streams.
      await streams[1].write(Uint8Array.from(VSOCK_REPLIES[1]));
      await streams[0].write(Uint8Array.from(VSOCK_REPLIES[0]));
    }
    await Promise.all([
      readVsockFixtureBytes(streams[0], [0xa1, 0x24], "stream 1 acknowledgment"),
      readVsockFixtureBytes(streams[0], [0x75], "stream 1 queued suffix"),
      checkEof(),
      readVsockFixtureBytes(streams[1], [0xb2], "stream 2 acknowledgment"),
      sendReplies(),
    ]);
    console.log("vsock host: both replies acknowledged on their original streams");
    console.log("vsock host: concurrent reads preserved stream 1 acknowledgment, suffix and EOF");
    await streams[0].write(Uint8Array.from(VSOCK_FINAL_REPLY));
    console.log("vsock host: sent final frame on stream 1 after EOF");
  } finally {
    listener.close();
    for (const stream of streams) stream.close();
  }
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

  const resize = /^::vm-test::resize:(\d+):(\d+)$/.exec(line);
  if (resize) {
    consoleDev.resize(Number(resize[1]), Number(resize[2]));
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

function reportConsoleClosedBeforeResult() {
  if (!settled) {
    finish({
      passed: false,
      reason: "guest console closed before reporting a result",
    });
  }
}

function observeConsoleClosedWithoutResult() {
  if (!machine) {
    userConsoleClosed = true;
    return;
  }
  void machine.closed.then(reportConsoleClosedBeforeResult, () => {});
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
        observeConsoleClosedWithoutResult();
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
const consoleDev = consoleDevice(input.readable, consoleOutput({ failWhenClosed: true }));
const devices = [consoleDev, entropyDevice()];

const disks = [];
let startupFailed = false;
try {
  if (vsockModes !== 0) {
    vsock = vsockDevice();
    if (ninepMemory) {
      ninepMemoryHost = await ninep.startNinepMemory(vsock, linuxModule, vsockAbort.signal);
      observeVsock(ninepMemoryHost.completed);
    } else {
      vsockListener = vsock.listen(ninep ? ninep.NINEP_PORT : VSOCK_FIXTURE_PORT);
    }
    devices.push(vsock);
  }
  for (const [diskIndex, diskPath] of diskPaths.entries()) {
    if (snapshotFirstDisk && diskIndex === 0) {
      const { snapshot_block_device } = await import(
        new URL("./immutable-image.js", linuxModule).href
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

if (machine) {
  initialMemoryBytes = machine.memory.buffer.byteLength;
  if (userConsoleClosed && !settled) observeConsoleClosedWithoutResult();
}

if (machine && vsock) {
  vsockTimer = setTimeout(() => {
    finish({ passed: false, reason: "vsock fixture timed out after 60 seconds" });
  }, VSOCK_FIXTURE_TIMEOUT_MS);
  if (vsockListener) {
    observeVsock(
      ninep
        ? ninep.exerciseNinep(vsockListener, ninepServer, ninepExport, vsockAbort.signal)
        : exerciseVsock(vsockListener),
    );
  }
}

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
clearTimeout(vsockTimer);
if (!outcome.passed) vsockAbort.abort();
let cleanupFailed = false;
shuttingDown = true;
try {
  ninepMemoryHost?.close();
} catch (error) {
  console.error(`::vm-test::fail: 9P memory host cleanup failed: ${error}`);
  cleanupFailed = true;
}
try {
  await closeTestResources(machine, disks);
} catch (error) {
  console.error(`::vm-test::fail: runner cleanup failed: ${error}`);
  cleanupFailed = true;
}
if (vsock) {
  try {
    vsock.close();
    await vsock.closed;
    await vsockTask;
  } catch (error) {
    console.error(`::vm-test::fail: vsock fixture cleanup failed: ${error}`);
    cleanupFailed = true;
  }
}

const finalOutcome = runtimeFailure ?? outcome;
if (!finalOutcome.passed) console.error(`vm test failed: ${finalOutcome.reason}`);
const passed = finalOutcome.passed && !startupFailed && !cleanupFailed;
if (passed && vsockRoundtrip) console.log("vsock runtime: machine and device shutdown complete");
if (passed && ninepServer) console.log("9p runtime: machine, device and server shutdown complete");
if (passed && ninepMemory) {
  console.log("9p memory runtime: machine, device and server shutdown complete");
}
process.exitCode = passed ? 0 : 1;
