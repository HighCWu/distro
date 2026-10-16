// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { descriptorCheckScript } from "./exec-file-descriptors-runtime.ts";

test("native descriptor probe detects a real inherited fd, not just a pathname", () => {
  const directory = mkdtempSync(join(tmpdir(), "linux-wasm-exec-fds-"));
  const path = join(directory, "held");
  const fd = openSync(path, "w+");
  try {
    for (const position of [1, 2]) {
      const paths = position === 1 ? [path, path + "-other"] : [path + "-other", path];
      for (const inherited of [false, true]) {
        const result = spawnSync("sh", ["-c", descriptorCheckScript, "probe", ...paths], {
          encoding: "utf8",
          timeout: 5000,
          stdio: inherited ? ["ignore", "pipe", "pipe", fd] : ["ignore", "pipe", "pipe"],
        });
        assert.equal(result.error, undefined);
        assert.equal(result.signal, null);
        assert.equal(result.status, inherited ? 21 : 0, result.stderr);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, inherited ? `inherited SDK descriptor: ${path}\n` : "");
      }
    }
  } finally {
    closeSync(fd);
    rmSync(directory, { recursive: true });
  }
});
