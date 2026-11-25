// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

export const NINEP_PORT = 18109;

export async function startNinepMemory(vsock, linuxModule, signal) {
  const { serveNinep } = await import(new URL("./virtio/ninep/host.js", linuxModule));
  const { importNinepDirectorySnapshot } = await import(
    new URL("./virtio/ninep/node-directory-snapshot.js", linuxModule)
  );
  signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "linux-wasm-ninep-snapshot-"));
  let fs;
  try {
    await mkdir(join(directory, "project"));
    await writeFile(join(directory, "project", "input.txt"), "linux-wasm 9p transport\n");
    fs = await importNinepDirectorySnapshot(directory, { maxBytes: 256, maxEntries: 4 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  signal.throwIfAborted();
  const server = serveNinep(vsock, { port: NINEP_PORT });
  try {
    fs.writeFile("/message.txt", "linux-wasm 9p transport\n");
    const session = server.add(fs, { readOnly: false });
    if (session.name !== "fs1") throw new Error("unexpected first 9P memory export name");

    const { promise: completed, resolve, reject } = Promise.withResolvers();
    const abort = () => reject(signal.reason);
    let attached = false;
    signal.addEventListener("abort", abort, { once: true });
    session.onConnection = (connected) => {
      if (connected) {
        attached = true;
        console.log("9p memory host: Linux attached the first export");
        return;
      }
      if (!attached) return;
      try {
        signal.throwIfAborted();
        const written = fs.readFile("/written.bin");
        if (
          written.length !== 12546 ||
          written.some((byte, index) => byte !== (index * 37 + 11) % 251)
        ) {
          throw new Error("9P memory export has incorrect written bytes");
        }
        console.log("9p memory host: exact written file verified after Linux detached");
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    return {
      completed,
      close() {
        signal.removeEventListener("abort", abort);
        session.onConnection = undefined;
        server.close();
      },
    };
  } catch (error) {
    server.close();
    throw error;
  }
}

export async function exerciseNinep(listener, serverExecutable, exportPath, signal) {
  let stream;
  let child;
  let exportDirectory;
  let failed = false;
  let listenerClosed = false;
  const tasks = [];

  function closeListener() {
    if (listenerClosed) return;
    listenerClosed = true;
    listener.close();
  }

  function stop() {
    closeListener();
    stream?.close();
    if (child?.pid && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }

  signal.addEventListener("abort", stop, { once: true });
  try {
    signal.throwIfAborted();
    exportDirectory = await mkdtemp(join(tmpdir(), "linux-wasm-ninep-"));
    await copyFile(join(exportPath, "message.txt"), join(exportDirectory, "message.txt"));
    signal.throwIfAborted();
    stream = await listener.accept();
    signal.throwIfAborted();
    if (!stream) throw new Error("9P listener closed before accepting a stream");
    closeListener();
    // Test-only preamble consumed before Linux acquires the 9P descriptor.
    await stream.write(new TextEncoder().encode(`${exportDirectory}\n`));
    signal.throwIfAborted();

    // FD mode serves exactly the accepted connection. Keep logs out of the
    // binary 9P response stream.
    child = spawn(
      serverExecutable,
      [
        "-f",
        "-n",
        "-S",
        "-U",
        userInfo().username,
        "-r",
        "0",
        "-w",
        "1",
        "-L",
        "stderr",
        "-e",
        exportDirectory,
      ],
      {
        stdio: ["pipe", "pipe", "inherit"],
      },
    );
    let guestEof = false;
    let sentRequest = false;
    let sentReply = false;
    tasks.push(
      new Promise((resolve, reject) => {
        child.on("error", reject);
        child.once("exit", (code, bySignal) => {
          if (code !== 0) {
            reject(new Error(`diod exited with ${bySignal ?? `status ${code}`}`));
          } else if (!guestEof) {
            reject(new Error("diod exited before the Linux stream reached EOF"));
          } else {
            resolve();
          }
        });
      }),
    );
    tasks.push(new Promise((resolve) => child.once("close", resolve)));

    async function* requests() {
      while (true) {
        signal.throwIfAborted();
        const chunk = await stream.read();
        signal.throwIfAborted();
        if (chunk.length === 0) {
          guestEof = true;
          return;
        }
        sentRequest = true;
        yield chunk;
      }
    }

    tasks.push(pipeline(requests(), child.stdin));
    tasks.push(
      (async () => {
        for await (const chunk of child.stdout) {
          await stream.write(chunk);
          sentReply = true;
        }
      })(),
    );
    await Promise.all(tasks);
    signal.throwIfAborted();
    if (!sentRequest || !sentReply) throw new Error("diod did not exchange 9P traffic");
    const written = await readFile(join(exportDirectory, "written.bin"));
    const expected = Buffer.from(
      Uint8Array.from({ length: 12546 }, (_, index) => (index * 37 + 11) % 251),
    );
    if (!written.equals(expected)) throw new Error("9P host output file has incorrect bytes");
    console.log("9p host: exact written file verified after disconnect");
    console.log("9p host: Linux stream reached EOF and diod exited successfully");
  } catch (error) {
    failed = true;
    signal.throwIfAborted();
    throw error;
  } finally {
    signal.removeEventListener("abort", stop);
    stop();
    await Promise.allSettled(tasks);
    if (exportDirectory) {
      try {
        await rm(exportDirectory, { recursive: true, force: true });
      } catch (error) {
        if (!failed) throw error;
      }
    }
  }
}
