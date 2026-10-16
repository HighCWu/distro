// SPDX-License-Identifier: MIT
import type { GuestAgent, NetworkAttachment } from "../src/index.ts";
import { collect } from "./helpers.ts";
import type { RuntimeAssertions } from "./agent-wasm64-suite.ts";

export function hasTcpListener(table: string, port: number): boolean {
  const suffix = `:${port.toString(16).toUpperCase().padStart(4, "0")}`;
  return table.split("\n").some((line) => {
    const fields = line.trim().split(/\s+/);
    return fields[1]?.toUpperCase().endsWith(suffix) && fields[3] === "0A";
  });
}

export async function checkPublicNetwork(
  agent: GuestAgent,
  attachment: NetworkAttachment,
  assert: RuntimeAssertions,
) {
  const body = "native wasm64 public network passed\n";
  await agent.fs.mkdir("/tmp/public-www");
  await agent.fs.writeTextFile("/tmp/public-www/index.html", body);
  const server = await agent.exec(["httpd", "-f", "-p", "18080", "-h", "/tmp/public-www"]);
  const stdout = collect(server.stdout);
  const stderr = collect(server.stderr);
  void stdout.catch(() => {});
  void stderr.catch(() => {});
  try {
    // Observe an actual LISTEN socket, not a guessed sleep or successful exec.
    const deadline = performance.now() + 10_000;
    while (!hasTcpListener(await agent.fs.readTextFile("/proc/net/tcp"), 18080)) {
      if (performance.now() >= deadline)
        throw new Error("native HTTP listener did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const connection = await attachment.connect({
      port: 18080,
      signal: AbortSignal.timeout(10_000),
    });
    try {
      const response = collect(connection.readable);
      void response.catch(() => {});
      const writer = connection.writable.getWriter();
      try {
        await writer.write(
          new TextEncoder().encode("GET /index.html HTTP/1.0\r\nHost: linux-wasm\r\n\r\n"),
        );
        await writer.close();
      } finally {
        writer.releaseLock();
      }
      const text = new TextDecoder().decode(await response);
      assert.equal(/^HTTP\/1\.[01] 200 /.test(text), true);
      const separator = text.indexOf("\r\n\r\n");
      assert.notEqual(separator, -1);
      assert.equal(text.slice(separator + 4), body);
    } finally {
      connection.close();
    }
    await server.kill("SIGTERM");
    assert.deepEqual(await server.status, { success: false, code: 0, signal: "SIGTERM" });
    assert.equal((await stdout).byteLength, 0);
    assert.equal((await stderr).byteLength, 0);
  } finally {
    await server.close();
  }
}
