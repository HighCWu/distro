// SPDX-License-Identifier: MIT
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";

const [installation, ...dependencies] = process.argv.slice(2);
if (
  !installation ||
  dependencies.length !== 3 ||
  ![installation, ...dependencies].every(isAbsolute)
)
  throw new Error("usage: relocate-metadata.mjs ABSOLUTE-INSTALLATION CURL OPENSSL ZLIB");
const directory = join(installation, "lib/pkgconfig");
const names = readdirSync(directory).filter((name) => name.endsWith(".pc"));
for (const name of ["libcurl.pc", "openssl.pc", "libssl.pc", "libcrypto.pc", "zlib.pc"])
  if (!names.includes(name)) throw new Error(`missing installed metadata: ${name}`);
const rewritten = names.map((name) => {
  let contents = readFileSync(join(directory, name), "utf8")
    .split("\n")
    .filter((line) => !/^(prefix|exec_prefix|libdir|includedir)=/.test(line))
    .join("\n");
  for (const dependency of dependencies) {
    const escaped = dependency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    contents = contents.replace(
      new RegExp(`${escaped}/+(lib|include)(?=/|\\s|$)`, "g"),
      (_, directory) => (directory === "lib" ? "${libdir}" : "${includedir}"),
    );
  }
  // The runtime recipe may already have normalized known build roots to FHS.
  // A root prefix of / can produce //lib or //include; accept only these
  // known directories, not arbitrary absolute paths or similarly named roots.
  contents = contents
    .replace(/-L\/+lib(?=\s|$)/g, "-L${libdir}")
    .replace(/-I\/+include(?=\s|$)/g, "-I${includedir}");
  const unrelocated = contents
    .split("\n")
    .filter((line) => line.includes("/nix/store/") || /-[IL]\//.test(line));
  if (unrelocated.length)
    throw new Error(`unrelocated path in installed metadata: ${name}\n${unrelocated.join("\n")}`);
  return [
    name,
    "prefix=${pcfiledir}/../..\nexec_prefix=${prefix}\nlibdir=${prefix}/lib\nincludedir=${prefix}/include\n" +
      contents,
  ];
});
// Validate the whole set before changing any metadata file.
for (const [name, contents] of rewritten) writeFileSync(join(directory, name), contents);
