// SPDX-License-Identifier: MIT
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";

const html = `<!doctype html><meta charset="utf-8"><title>Private fork latency measurement</title><link rel="icon" href="data:,">
<script type="importmap">{"imports":{"@lowland/bytes":"/kernel/node_modules/@lowland/bytes/dist/index.js"}}</script>
<script type="module" src="/latency-browser-app.js"></script>`;
export function latencyServer(assets) {
  const root = resolve(assets);
  return createServer(async (request, response) => {
    const headers = {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cache-Control": "public, max-age=31536000, immutable",
    };
    try {
      const path = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      if (path === "/") {
        response
          .writeHead(200, {
            ...headers,
            "Cache-Control": "no-store",
            "Content-Type": "text/html; charset=utf-8",
          })
          .end(html);
        return;
      }
      const allowed =
        /^\/(?:kernel\/(?:dist\/|node_modules\/@lowland\/bytes\/dist\/).+\.js|kernel\/vmlinux\.wasm|(?:exit|exec)-(?:1|16|64)\.cpio|manifest\.json|latency-browser-app\.js|runtime-smoke\.js|protocol\.js)$/;
      const file = resolve(root, "." + path);
      if (
        path.split("/").some((part) => part === "." || part === "..") ||
        !allowed.test(path) ||
        !file.startsWith(root + sep)
      ) {
        response.writeHead(403, headers).end();
        return;
      }
      const types = {
        ".js": "text/javascript; charset=utf-8",
        ".json": "application/json",
        ".wasm": "application/wasm",
        ".cpio": "application/octet-stream",
      };
      const bytes = await readFile(file);
      response
        .writeHead(200, {
          ...headers,
          "Content-Type": types[extname(file)],
          "Content-Length": bytes.length,
        })
        .end(bytes);
    } catch {
      response.writeHead(404, headers).end();
    }
  });
}
