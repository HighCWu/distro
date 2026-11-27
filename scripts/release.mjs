#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { nextVersion, readWorkspacePackages, stageVersionBump } from "./version-bump.mjs";

const bump = process.argv[2];
if (!["major", "minor", "patch"].includes(bump)) {
  console.error("usage: pnpm release <major|minor|patch>");
  process.exit(1);
}

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(" ")}`);
  return execFileSync(command, args, { encoding: "utf8", stdio: "inherit", ...options });
}

function output(command, args) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

if (output("git", ["status", "--porcelain"])) fail("worktree is not clean");
if (output("git", ["branch", "--show-current"]) !== "main") fail("releases must be made from main");

run("git", ["fetch", "origin", "main", "--tags"]);
if (output("git", ["rev-parse", "HEAD"]) !== output("git", ["rev-parse", "origin/main"])) {
  fail("main is not synchronized with origin/main");
}

const packages = readWorkspacePackages();
const versions = new Set(packages.map(({ manifest }) => manifest.version));
if (versions.size !== 1) fail(`workspace packages are not in lockstep: ${[...versions].join(", ")}`);
const plannedVersion = nextVersion([...versions][0], bump);
const tag = `v${plannedVersion}`;

if (spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/tags/${tag}`]).status === 0) {
  fail(`tag ${tag} already exists`);
}

let staged;
try {
  staged = stageVersionBump({ bump });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

run("git", ["add", "--", ...staged.changedFiles]);
run("git", ["diff", "--cached", "--check"]);
run("git", ["commit", "-m", `Release ${tag}`]);
run("git", ["tag", "--annotate", tag, "--message", `Release ${tag}`]);

try {
  run("git", ["push", "--atomic", "origin", "HEAD:refs/heads/main", `refs/tags/${tag}`]);
} catch {
  fail(`push failed; the local release commit and ${tag} were kept for recovery`);
}

console.log(`Released ${tag}`);
