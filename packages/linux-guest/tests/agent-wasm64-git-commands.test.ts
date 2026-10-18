// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  gitRootEnvironment,
  gitRootFile,
  gitRootPaths,
  verifyGitApplication,
} from "./agent-wasm64-git-commands.ts";
import type { GitRootClient } from "./agent-wasm64-git-commands.ts";

// Native execution validates the shared workload, not Linux/Wasm execution.
for (const mode of ["valid", "worktree", "head", "pack", "hook", "missing"] as const) {
  test(`native Git public-root command contract: ${mode}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "native-git-root-"));
    const agent: GitRootClient = {
      async run(argv, options) {
        const result = spawnSync(argv[0]!, argv.slice(1), {
          cwd: options?.cwd ?? directory,
          env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory, ...options?.env },
          timeout: 15000,
        });
        assert.ifError(result.error);
        assert.equal(result.signal, null);
        assert.notEqual(result.status, null);
        return {
          status: { success: result.status === 0, code: result.status!, signal: null },
          stdout: new Uint8Array(result.stdout),
          stderr: new Uint8Array(result.stderr),
        };
      },
      fs: {
        async readFile(path) {
          return new Uint8Array(await readFile(path));
        },
        async writeFile(path, data) {
          assert.ok(data instanceof Uint8Array);
          await writeFile(path, data);
        },
        async chmod(path, mode) {
          await chmod(path, mode);
        },
      },
    };
    try {
      const head = await verifyGitApplication(agent, directory, "write", undefined, assert);
      const paths = gitRootPaths(directory);
      if (mode === "worktree") writeFileSync(`${paths.repo}/${gitRootFile}`, new Uint8Array([0]));
      if (mode === "head") {
        const result = await agent.run(
          [
            "git",
            "-C",
            paths.repo,
            "-c",
            "commit.gpgSign=false",
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "unexpected",
          ],
          { env: gitRootEnvironment },
        );
        assert.equal(result.status.success, true);
      }
      if (mode === "pack") {
        const pack = readdirSync(`${paths.repo}/.git/objects/pack`).find((name) =>
          name.endsWith(".pack"),
        );
        assert.ok(pack);
        await chmod(`${paths.repo}/.git/objects/pack/${pack}`, 0o644);
        writeFileSync(`${paths.repo}/.git/objects/pack/${pack}`, new Uint8Array([0]));
      }
      if (mode === "hook") writeFileSync(paths.marker, "wrong marker\n");
      if (mode === "missing") rmSync(paths.repo, { recursive: true });
      const verify = () => verifyGitApplication(agent, directory, "read", head, assert);
      if (mode === "valid") assert.equal(await verify(), head);
      else await assert.rejects(verify);
    } finally {
      // Only this test's freshly allocated temporary directory is removed.
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
