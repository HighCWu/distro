// SPDX-License-Identifier: MIT
// Development server only: no build-on-demand, uploads, or directory listing.
import { createServer } from "node:http";
import { createReadStream, realpathSync, statSync } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBundle } from "./integrity.mjs";

const root = realpathSync(dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.PORT ?? 0);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("invalid PORT");
// Fail before accepting requests; never regenerate a damaged bundle's manifest.
try {
  console.log(`Verified ${await verifyBundle(root)} bundle files (SHA-256)`);
} catch (error) {
  console.error(`Bundle verification failed: ${error.message}`);
  process.exit(1);
}
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
};
const server = createServer((request, response) => {
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  } catch {
    response.writeHead(400).end();
    return;
  }
  const path = resolve(root, pathname === "/" ? "index.html" : pathname.slice(1));
  if (!path.startsWith(root + sep)) {
    response.writeHead(403).end();
    return;
  }
  let target;
  let size;
  try {
    target = realpathSync(path);
    if (!target.startsWith(root + sep)) {
      response.writeHead(403).end();
      return;
    }
    const info = statSync(target);
    if (!info.isFile()) {
      response.writeHead(404).end();
      return;
    }
    size = info.size;
  } catch {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    "Content-Type": mime[extname(target)] ?? "application/octet-stream",
    "Content-Length": size,
  });
  if (request.method === "HEAD") response.end();
  else
    createReadStream(target)
      .on("error", () => response.destroy())
      .pipe(response);
});
server.listen(port, "127.0.0.1", () =>
  console.log(`Listening on http://127.0.0.1:${server.address().port}`),
);
