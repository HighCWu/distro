// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";
import { createReadStream, realpathSync } from "node:fs";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const manifestName = "checksums.json";

export async function bundleManifest(root) {
  const files = [];
  async function walk(relative) {
    const names = await readdir(join(root, relative));
    names.sort();
    for (const name of names) {
      const path = relative ? `${relative}/${name}` : name;
      if (path === manifestName) continue;
      const absolute = join(root, path);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`bundle contains a symbolic link: ${path}`);
      if (stat.isDirectory()) await walk(path);
      else if (stat.isFile()) {
        const hash = createHash("sha256");
        for await (const bytes of createReadStream(absolute)) hash.update(bytes);
        files.push({ path, size: stat.size, sha256: hash.digest("hex") });
      } else throw new Error(`bundle contains a non-regular file: ${path}`);
    }
  }
  await walk("");
  return { schemaVersion: 1, algorithm: "sha256", files };
}

export async function verifyBundle(root) {
  const path = join(root, manifestName);
  if (!(await lstat(path)).isFile() || (await lstat(path)).isSymbolicLink())
    throw new Error("bundle checksum manifest must be a regular file");
  const recorded = JSON.parse(await readFile(path, "utf8"));
  const actual = await bundleManifest(root);
  // Compare the complete inventory, not paths supplied by an untrusted manifest.
  if (!isDeepStrictEqual(recorded, actual))
    throw new Error(
      "bundle integrity mismatch: files are missing, added, modified, or the manifest is invalid",
    );
  return actual.files.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const mode = process.argv[2] ?? "--check";
    if (!["--check", "--write"].includes(mode) || process.argv.length > 4)
      throw new Error("usage: node integrity.mjs [--check|--write] [bundle-directory]");
    const root = resolve(process.argv[3] ?? dirname(fileURLToPath(import.meta.url)));
    if (mode === "--write") {
      const contents = JSON.stringify(await bundleManifest(root), null, 2) + "\n";
      // Build output is new; never overwrite an existing manifest or symlink.
      await writeFile(join(root, manifestName), contents, { flag: "wx" });
    } else console.log(`Verified ${await verifyBundle(root)} bundle files (SHA-256)`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
