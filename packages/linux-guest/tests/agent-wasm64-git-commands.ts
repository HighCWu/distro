// SPDX-License-Identifier: MIT
import type { GuestAgent } from "../src/index.ts";
import type { RuntimeAssertions } from "./agent-wasm64-suite.ts";

export type GitRootClient = Pick<GuestAgent, "run"> & {
  fs: Pick<GuestAgent["fs"], "readFile" | "writeFile" | "chmod">;
};

export const gitRootPayload = Uint8Array.from({ length: 65553 }, (_, i) => i & 255);
export const gitRootFile = "payload ' $HOME → data.bin";
export const gitRootHookMarker = "Git root pre-commit hook\n";
export const gitRootEnvironment = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Linux/Wasm developer",
  GIT_AUTHOR_EMAIL: "developer@example.test",
  GIT_COMMITTER_NAME: "Linux/Wasm developer",
  GIT_COMMITTER_EMAIL: "developer@example.test",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00+0000",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00+0000",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
};

export function gitRootPaths(directory: string) {
  return {
    repo: `${directory}/project ' $HOME → repo`,
    clone: `${directory}/clone ' $HOME → repo`,
    marker: `${directory}/pre-commit ' marker`,
  };
}

// Execute the same ordinary Git commands on the target and in host fixture
// validation. Only the hook itself uses a shell; its literal path is quoted.
export async function verifyGitApplication(
  agent: GitRootClient,
  directory: string,
  phase: "write" | "read",
  expectedHead: string | undefined,
  assert: Pick<RuntimeAssertions, "equal" | "deepEqual">,
) {
  const paths = gitRootPaths(directory);
  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  async function git(args: string[]) {
    const result = await agent.run(["git", ...args], { env: gitRootEnvironment });
    assert.deepEqual(result.status, { success: true, code: 0, signal: null });
    assert.equal(result.stderr.byteLength, 0);
    return result.stdout;
  }
  const inRepo = (args: string[]) => git(["-C", paths.repo, ...args]);
  const quiet = async (args: string[]) => assert.equal((await inRepo(args)).byteLength, 0);
  if (phase === "write") {
    assert.equal(expectedHead, undefined);
    assert.equal(
      (await git(["init", "--quiet", "--initial-branch=main", "--object-format=sha1", paths.repo]))
        .byteLength,
      0,
    );
    await agent.fs.writeFile(`${paths.repo}/${gitRootFile}`, gitRootPayload);
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const hook = new TextEncoder().encode(
      `#!/bin/sh\nprintf '%s\\n' 'Git root pre-commit hook' > ${quote(paths.marker)}\n`,
    );
    await agent.fs.writeFile(`${paths.repo}/.git/hooks/pre-commit`, hook);
    await agent.fs.chmod(`${paths.repo}/.git/hooks/pre-commit`, 0o755);
    await quiet(["add", "--", gitRootFile]);
    await quiet([
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--quiet",
      "-m",
      "literal $HOME → commit",
    ]);
    await quiet(["-c", "pack.threads=2", "repack", "-adq"]);
  }
  await quiet(["status", "--porcelain=v1"]);
  assert.deepEqual(await agent.fs.readFile(`${paths.repo}/${gitRootFile}`), gitRootPayload);
  assert.deepEqual(await inRepo(["cat-file", "blob", `HEAD:${gitRootFile}`]), gitRootPayload);
  assert.equal(text(await agent.fs.readFile(paths.marker)), gitRootHookMarker);
  await quiet(["fsck", "--strict"]);
  const head = text(await inRepo(["rev-parse", "--verify", "HEAD"])).trimEnd();
  assert.equal(/^[0-9a-f]{40}$/.test(head), true);
  if (phase === "read") {
    assert.equal(head, expectedHead);
    assert.equal(
      (await git(["clone", "--quiet", "--no-local", paths.repo, paths.clone])).byteLength,
      0,
    );
    assert.equal(
      text(await git(["-C", paths.clone, "rev-parse", "--verify", "HEAD"])),
      `${head}\n`,
    );
    assert.deepEqual(await agent.fs.readFile(`${paths.clone}/${gitRootFile}`), gitRootPayload);
    assert.deepEqual(
      await git(["-C", paths.clone, "cat-file", "blob", `HEAD:${gitRootFile}`]),
      gitRootPayload,
    );
    assert.equal((await git(["-C", paths.clone, "fsck", "--strict"])).byteLength, 0);
    assert.equal((await git(["-C", paths.clone, "status", "--porcelain=v1"])).byteLength, 0);
  }
  return head;
}
