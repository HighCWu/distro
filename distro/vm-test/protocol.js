export const PASS = "::vm-test::pass";
export const FAIL = "::vm-test::fail";

// Owned decoded strings survive reuse of the Wasm buffers. Complete LF-ended
// lines also prevent raw TTY carriage returns from erasing Nix log records.
export function writeConsoleLines(output, lines, consumeLine) {
  for (const line of lines) {
    output.write(`${line}\n`);
    consumeLine(line);
  }
}

export class LineDecoder {
  #buffer = "";
  #decoder = new TextDecoder();

  write(chunk) {
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    return this.#lines(false);
  }

  close() {
    this.#buffer += this.#decoder.decode();
    return this.#lines(true);
  }

  #lines(flush) {
    const lines = [];
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) break;
      lines.push(this.#buffer.slice(0, newline).replace(/\r$/, ""));
      this.#buffer = this.#buffer.slice(newline + 1);
    }
    if (flush && this.#buffer !== "") {
      lines.push(this.#buffer.replace(/\r$/, ""));
      this.#buffer = "";
    }
    return lines;
  }
}

export function parseResult(line) {
  if (line === PASS) return { passed: true };
  if (line === FAIL) return { passed: false, reason: "guest reported failure" };
  if (line.startsWith(`${FAIL}: `)) {
    return { passed: false, reason: line.slice(FAIL.length + 2) };
  }
  return undefined;
}
