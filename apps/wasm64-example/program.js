// SPDX-License-Identifier: MIT
export const maximumProgramBytes = 16 * 1024 * 1024;
export const maximumOutputCharacters = 65536;
const programPath = "/root/application.wasm";

export function outputTail(previous, text) {
  return (previous + text).slice(-maximumOutputCharacters);
}

export function programArguments(text) {
  if (text.length > 8192) throw new Error("program arguments exceed 8192 characters");
  const args = JSON.parse(text);
  if (
    !Array.isArray(args) ||
    args.length > 64 ||
    args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
  ) {
    throw new Error("program arguments must be a JSON array of at most 64 NUL-free strings");
  }
  return args;
}

/** Import only into this ephemeral Linux root, never onto the HTTP server. */
export async function runProgram(agent, file, argumentText, { signal, onOutput }) {
  signal?.throwIfAborted();
  const args = programArguments(argumentText);
  if (
    !file ||
    !Number.isSafeInteger(file.size) ||
    file.size < 8 ||
    file.size > maximumProgramBytes
  ) {
    throw new Error("select a Linux wasm64 program between 8 bytes and 16 MiB");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  signal?.throwIfAborted();
  if (
    bytes.byteLength !== file.size ||
    ![0, 97, 115, 109, 1, 0, 0, 0].every((byte, index) => bytes[index] === byte)
  ) {
    throw new Error("selected file is not a WebAssembly version 1 binary");
  }
  // This header check is not ABI validation or a trust boundary. Linux's
  // loader must accept the matching SDK ABI before executing the application.
  await agent.fs.writeFile(programPath, bytes, { mode: 0o700, signal });
  signal?.throwIfAborted();
  await agent.fs.chmod(programPath, 0o700);
  signal?.throwIfAborted();
  const child = await agent.exec([programPath, ...args], { cwd: "/root", signal });
  const pump = (stream, name) => {
    const decoder = new TextDecoder();
    return stream.pipeTo(
      new WritableStream({
        write(bytes) {
          onOutput(name, decoder.decode(bytes, { stream: true }));
        },
        close() {
          onOutput(name, decoder.decode());
        },
      }),
    );
  };
  const pending = [];
  let failed = false;
  let primary;
  try {
    // Close stdin immediately; consume both outputs concurrently with status.
    // Unlike run(), no full-output buffer is retained for arbitrary programs.
    pending.push(
      child.status,
      child.stdin.close(),
      pump(child.stdout, "stdout"),
      pump(child.stderr, "stderr"),
    );
    const [status] = await Promise.all(pending);
    return status;
  } catch (error) {
    failed = true;
    primary = error;
    throw error;
  } finally {
    try {
      // Reap and release pipes/slots before the UI allows another launch.
      await child.close();
    } catch (cleanupError) {
      if (failed)
        throw new AggregateError(
          [primary, cleanupError],
          "application execution and cleanup failed",
          { cause: primary },
        );
      throw cleanupError;
    } finally {
      await Promise.allSettled(pending);
    }
  }
}
