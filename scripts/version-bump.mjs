import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export function nextVersion(version, spec) {
  const currentMatch = SEMVER_RE.exec(version);
  if (!currentMatch) throw new Error(`unsupported version ${JSON.stringify(version)}`);
  let [, major, minor, patch] = currentMatch.map(Number);
  if (spec === "major") {
    return `${major + 1}.0.0`;
  }
  if (spec === "minor") {
    return `${major}.${minor + 1}.0`;
  }
  if (spec === "patch") {
    return `${major}.${minor}.${patch + 1}`;
  }
  const explicitMatch = SEMVER_RE.exec(spec ?? "");
  if (!explicitMatch) {
    throw new Error(
      `unsupported version bump ${JSON.stringify(spec)} (expected major, minor, patch, or X.Y.Z)`,
    );
  }
  if (spec === version) {
    throw new Error(`target version ${version} matches current version`);
  }
  return spec;
}

export function readWorkspacePackages(rootDir = process.cwd()) {
  const workspace = readFileSync(resolve(rootDir, "pnpm-workspace.yaml"), "utf8");
  const packageDirectories = [...workspace.matchAll(/^\s*-\s+([^#\s]+)\s*$/gm)].map(
    (match) => match[1],
  );
  return packageDirectories
    .map((directory) => {
      const path = resolve(rootDir, directory, "package.json");
      return { path, manifest: JSON.parse(readFileSync(path, "utf8")) };
    })
    .filter(({ manifest }) => typeof manifest.version === "string");
}

export function stageVersionBump({
  rootDir = process.cwd(),
  bump,
  dryRun = false,
  date = new Date().toISOString().slice(0, 10),
}) {
  const packages = readWorkspacePackages(rootDir);
  if (packages.length === 0) {
    throw new Error("no versioned workspace packages found");
  }
  const versions = new Set(packages.map(({ manifest }) => manifest.version));
  if (versions.size !== 1) {
    throw new Error(`workspace packages are not in lockstep: ${[...versions].join(", ")}`);
  }
  const previousVersion = [...versions][0];
  const version = nextVersion(previousVersion, bump);

  const changelogPath = resolve(rootDir, "CHANGELOG.md");
  const changelog = readFileSync(changelogPath, "utf8");
  const heading = "## [Unreleased]";
  const headingIndex = changelog.indexOf(heading);
  if (headingIndex === -1) throw new Error("CHANGELOG.md has no [Unreleased] heading");
  if (changelog.indexOf(heading, headingIndex + heading.length) !== -1) {
    throw new Error("CHANGELOG.md has more than one [Unreleased] heading");
  }
  const sectionStart = headingIndex + heading.length;
  const nextHeading = changelog.slice(sectionStart).search(/^## \[/m);
  const sectionEnd = nextHeading === -1 ? changelog.length : sectionStart + nextHeading;
  if (!changelog.slice(sectionStart, sectionEnd).trim()) {
    throw new Error("CHANGELOG.md [Unreleased] section is empty");
  }

  if (!dryRun) {
    for (const pkg of packages) {
      pkg.manifest.version = version;
      writeFileSync(pkg.path, `${JSON.stringify(pkg.manifest, null, 2)}\n`);
    }
    writeFileSync(
      changelogPath,
      changelog.replace(heading, `${heading}\n\n## [${version}] - ${date}`),
    );
  }

  return {
    previousVersion,
    version,
    changedFiles: [changelogPath, ...packages.map(({ path }) => path)],
  };
}
