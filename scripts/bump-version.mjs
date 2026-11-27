#!/usr/bin/env node

import { stageVersionBump } from "./version-bump.mjs";

const args = process.argv.slice(2);
let dryRun = false;
let bump;

for (const arg of args) {
  if (arg === "--dry-run") {
    dryRun = true;
  } else if (!bump) {
    bump = arg;
  } else {
    console.error("usage: pnpm version:bump <major|minor|patch|X.Y.Z> [--dry-run]");
    process.exit(1);
  }
}

if (!bump) {
  console.error("usage: pnpm version:bump <major|minor|patch|X.Y.Z> [--dry-run]");
  process.exit(1);
}

try {
  const result = stageVersionBump({ bump, dryRun });
  const mode = dryRun ? "Would bump" : "Staged bump";
  console.log(`${mode} ${result.previousVersion} -> ${result.version}`);
  for (const file of result.changedFiles) {
    console.log(`  ${file}`);
  }
} catch (error) {
  console.error(`version-bump: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
