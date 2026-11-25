#!/usr/bin/env node
import {
  bootMachine,
  closeDevice,
  consoleDevice,
  entropyDevice,
  workerDevice,
  type Machine,
  type VirtioDevice,
} from "@lowland/kernel";
import { availableParallelism } from "node:os";
import { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";
import { configureShares, type ShareArgument } from "./shares.ts";

function assert(cond: unknown, message = "Assertion failed"): asserts cond {
  if (!cond) throw new Error(message);
}

const cpus = availableParallelism();

const parsed = parseArgs({
  args: process.argv.slice(2),
  allowNegative: true,
  tokens: true,
  options: {
    cmdline: {
      short: "c",
      type: "string",
      default: "",
    },
    cpus: {
      short: "j",
      type: "string",
      default: cpus.toString(),
    },
    help: {
      short: "h",
      type: "boolean",
      default: false,
    },
    console: {
      type: "boolean",
      default: true,
    },
    entropy: {
      type: "boolean",
      default: true,
    },
    disk: {
      type: "string",
      multiple: true,
    },
    "disk-ro": {
      type: "string",
      multiple: true,
    },
    share: {
      type: "string",
      multiple: true,
    },
    "share-ro": {
      type: "string",
      multiple: true,
    },
  },
});
const args = parsed.values;

if (args.help) {
  console.log(`usage: run.ts [options]

options:
  -c, --cmdline <string>  Command line arguments to pass to the kernel
  -j, --cpus <number>     Number of CPUs to use (default: number of CPUs on the machine)
      --no-console        Don't attach a console device
      --no-entropy        Don't attach an entropy device
      --disk <string>     Local disk image path or read-only HTTP(S) Range URL (repeatable)
                          HTTP images require a strong ETag and byte-range support
      --disk-ro <string>  Open a local disk image or HTTP(S) Range URL read-only (repeatable)
                          Disks are attached in command-line order
      --share HOST:GUEST  Mount a host directory read-write (can be specified multiple times)
      --share-ro HOST:GUEST
                          Mount a host directory read-only (can be specified multiple times)
  -h, --help              Show this help message
`);
  process.exit(0);
}

assert(!Number.isNaN(parseInt(args.cpus, 10)), "cpus must be a number");

const devices = [];
let restoreTerminal = () => {};

const shareArguments: ShareArgument[] = [];
for (const token of parsed.tokens) {
  if (token.kind !== "option" || (token.name !== "share" && token.name !== "share-ro")) continue;
  assert(token.value !== undefined, `--${token.name} requires HOST:GUEST`);
  shareArguments.push({ value: token.value, readOnly: token.name === "share-ro" });
}
const shares = configureShares(shareArguments);
devices.push(...shares.devices);

if (args.console) {
  if (process.stdin.isTTY) {
    let raw = false;

    restoreTerminal = () => {
      if (!raw) return;
      raw = false;
      process.stdin.setRawMode(false);
    };

    const exitFromSignal = (signal: NodeJS.Signals, code: number) => {
      process.on(signal, () => {
        restoreTerminal();
        process.exit(code);
      });
    };

    process.stdin.setRawMode(true);
    raw = true;

    process.on("exit", restoreTerminal);
    exitFromSignal("SIGHUP", 129);
    exitFromSignal("SIGINT", 130);
    exitFromSignal("SIGQUIT", 131);
    exitFromSignal("SIGTERM", 143);
  }

  const device = consoleDevice(
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  );
  devices.push(device);

  if (process.stdout.isTTY) {
    const resize = () => {
      const { columns, rows } = process.stdout;
      if (columns > 0 && rows > 0) device.resize(columns, rows);
    };
    resize();
    process.stdout.on("resize", resize);
  }
}

if (args.entropy) {
  devices.push(entropyDevice());
}

const openDisks = new Set<VirtioDevice>();
const diskTerminations: Promise<void>[] = [];
let machine: Machine;
try {
  for (const token of parsed.tokens) {
    if (token.kind !== "option" || (token.name !== "disk" && token.name !== "disk-ro")) continue;
    assert(token.value !== undefined, `--${token.name} requires a disk image`);
    const worker = new Worker(new URL("./disk-worker.ts", import.meta.url), {
      workerData: { path: token.value, readOnly: token.name === "disk-ro" },
    });
    let device: VirtioDevice;
    try {
      device = await workerDevice(worker);
    } catch (error) {
      await worker.terminate().catch(() => {});
      throw error;
    }
    openDisks.add(device);
    const termination = device.closed.finally(() => {
      openDisks.delete(device);
      return worker.terminate();
    });
    void termination.catch(() => {});
    diskTerminations.push(termination);
    devices.push(device);
  }

  machine = await bootMachine({
    args: ["root=/dev/vda", "rootwait", "init=/init", args.cmdline, shares.cmdline].filter(Boolean),
    cpus: parseInt(args.cpus, 10),
    plugins: devices,
  });
} catch (error) {
  // bootMachine may already have closed some devices before rejecting.
  await Promise.allSettled([...openDisks].map(closeDevice));
  await Promise.allSettled(diskTerminations);
  throw error;
}

const bootConsole = machine.bootConsole
  .pipeTo(Writable.toWeb(process.stderr) as WritableStream<Uint8Array>, {
    preventClose: true,
  })
  .catch(() => {});

try {
  await machine.closed;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  restoreTerminal();
  if (args.console) process.stdin.pause();
  await bootConsole;
  await Promise.allSettled(diskTerminations);
}
