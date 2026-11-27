import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { nextVersion, stageVersionBump } from "./version-bump.mjs";

test("nextVersion handles semver bumps, explicit versions, and invalid specs", () => {
  assert.equal(nextVersion("1.2.3", "patch"), "1.2.4");
  assert.equal(nextVersion("1.2.3", "minor"), "1.3.0");
  assert.equal(nextVersion("1.2.3", "major"), "2.0.0");
  assert.equal(nextVersion("1.2.3", "2.5.0"), "2.5.0");
  assert.throws(() => nextVersion("1.2.3", "1.2.3"), /matches current version/);
  assert.throws(() => nextVersion("1.2.3", "invalid"), /unsupported version bump/);
});

test("stageVersionBump stages lockstep package versions and CHANGELOG.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "distro-version-bump-"));
  try {
    mkdirSync(join(dir, "packages/a"), { recursive: true });
    mkdirSync(join(dir, "packages/b"), { recursive: true });
    mkdirSync(join(dir, "packages/private"), { recursive: true });
    writeFileSync(
      join(dir, "pnpm-workspace.yaml"),
      "packages:\n  - packages/a\n  - packages/b\n  - packages/private\n",
    );
    writeFileSync(
      join(dir, "packages/a/package.json"),
      `${JSON.stringify({ name: "a", version: "0.1.0" })}\n`,
    );
    writeFileSync(
      join(dir, "packages/b/package.json"),
      `${JSON.stringify({ name: "b", version: "0.1.0" })}\n`,
    );
    writeFileSync(
      join(dir, "packages/private/package.json"),
      `${JSON.stringify({ name: "priv" })}\n`,
    );
    writeFileSync(
      join(dir, "CHANGELOG.md"),
      "# Changelog\n\n## [Unreleased]\n\n- Added feature\n",
    );

    const dry = stageVersionBump({
      rootDir: dir,
      bump: "minor",
      dryRun: true,
      date: "2026-11-27",
    });
    assert.equal(dry.previousVersion, "0.1.0");
    assert.equal(dry.version, "0.2.0");
    assert.equal(
      JSON.parse(readFileSync(join(dir, "packages/a/package.json"), "utf8")).version,
      "0.1.0",
    );

    const cli = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./bump-version.mjs", import.meta.url)), "patch", "--dry-run"],
      { cwd: dir, encoding: "utf8" },
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /Would bump 0\.1\.0 -> 0\.1\.1/);

    const staged = stageVersionBump({
      rootDir: dir,
      bump: "minor",
      dryRun: false,
      date: "2026-11-27",
    });
    assert.equal(staged.version, "0.2.0");
    assert.equal(
      JSON.parse(readFileSync(join(dir, "packages/a/package.json"), "utf8")).version,
      "0.2.0",
    );
    assert.equal(
      JSON.parse(readFileSync(join(dir, "packages/b/package.json"), "utf8")).version,
      "0.2.0",
    );
    assert.equal(
      readFileSync(join(dir, "CHANGELOG.md"), "utf8"),
      "# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-11-27\n\n- Added feature\n",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
