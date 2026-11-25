// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";

export const NINEP_PORT = 18109;

export async function exerciseNinep(listener, serverExecutable, exportPath, signal) {
  let stream;
  let child;
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
    stream = await listener.accept();
    signal.throwIfAborted();
    if (!stream) throw new Error("9P listener closed before accepting a stream");
    closeListener();

    // FD mode serves exactly the accepted connection. Keep logs out of the
    // binary 9P response stream.
    child = spawn(
      serverExecutable,
      ["-f", "-n", "-S", "-r", "0", "-w", "1", "-L", "stderr", "-e", exportPath],
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
    console.log("9p host: Linux stream reached EOF and diod exited successfully");
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    signal.removeEventListener("abort", stop);
    stop();
    await Promise.allSettled(tasks);
  }
}
