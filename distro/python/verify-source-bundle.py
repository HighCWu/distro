# SPDX-License-Identifier: MIT
"""Compare selected archive members to their exact inputs without extraction."""
import argparse
import gzip
import json
import os
from pathlib import Path
import stat
import tarfile


NAMES = ("python", "zlib", "bzip2", "xz", "sqlite3", "readline", "ncurses", "openssl")
SCOPE = "Exact selected sources, recipes and ordered patches; not complete corresponding source, an SBOM or an offline rebuild environment"


def verify(spec_path, materials, archive_path):
    spec = json.loads(spec_path.read_text())
    build = json.loads((materials / "build.json").read_text())
    if spec["schemaVersion"] != 1 or build["schemaVersion"] != 1:
        raise ValueError("unsupported source or build schema")
    components = spec["components"]
    if tuple(item["name"] for item in components) != NAMES:
        raise ValueError("all eight selected components must be present in order")
    if [item["sourceIdentity"] for item in components] != [build["sourceIdentity"]] + [item["sourceIdentity"] for item in build["dependencies"]]:
        raise ValueError("source identities differ from configured interpreter")
    expected_index = {key: spec[key] for key in ("schemaVersion", "addressBits", "maximumMemoryBytes")}
    for key in ("addressBits", "maximumMemoryBytes"):
        if build[key] != spec[key]:
            raise ValueError("source/build platform mismatch: " + key)
    expected_index["scope"] = SCOPE
    expected_index["components"] = []
    expected = {}

    def unreadable(error):
        raise error

    def tree(path, prefix):
        root = path.resolve(strict=True)
        if not root.is_dir():
            raise ValueError("expected an input directory: " + prefix)
        expected[prefix] = (root, None)
        for directory, directories, files in os.walk(root, followlinks=False, onerror=unreadable):
            for name in directories + files:
                item = Path(directory) / name
                expected[prefix + "/" + item.relative_to(root).as_posix()] = (item, None)

    tree(materials, "build-materials")
    for item in components:
        name = item["name"]
        source = Path(item["sourcePath"])
        if source.name != item["sourceIdentity"]:
            raise ValueError("source identity mismatch: " + name)
        tree(source, "sources/" + name)
        tree(Path(item["recipeDirectory"]), "recipes/" + name)
        patches = []
        for number, path in enumerate(item["patchPaths"]):
            member = f"patches/{name}/{number:03d}.patch"
            # Configured patches are standalone regular bytes, even when the
            # input path is a symlink. Source tree symlinks are not followed.
            expected[member] = (Path(path).resolve(strict=True), 0o644)
            patches.append(member)
        expected_index["components"].append({"name": name, "sourceIdentity": item["sourceIdentity"], "patches": patches})
    seen = set()
    # Read through tar padding and the gzip trailer, so a second appended
    # archive cannot hide behind the first tar end marker and CRC is checked.
    with gzip.open(archive_path, "rb") as compressed, tarfile.open(fileobj=compressed, mode="r|", ignore_zeros=True) as archive:
        for member in archive:
            name = member.name
            if name in seen:
                raise ValueError("duplicate archive member: " + name)
            seen.add(name)
            if (member.uid, member.gid, member.uname, member.gname, member.mtime) != (0, 0, "", "", 1):
                raise ValueError("unexpected archive metadata: " + name)
            if name == "selected-sources.json":
                if not member.isfile() or member.size > 1024 * 1024 or member.mode != 0o644:
                    raise ValueError("invalid public source index member")
                if json.load(archive.extractfile(member)) != expected_index:
                    raise ValueError("public source index differs from exact inputs")
                continue
            if name not in expected:
                raise ValueError("unexpected archive member: " + name)
            path, forced_mode = expected[name]
            info = path.lstat()
            if member.mode != (forced_mode if forced_mode is not None else stat.S_IMODE(info.st_mode)):
                raise ValueError("mode differs from input: " + name)
            if stat.S_ISLNK(info.st_mode):
                if not member.issym() or member.linkname != os.readlink(path):
                    raise ValueError("symlink differs from input: " + name)
            elif stat.S_ISDIR(info.st_mode):
                if not member.isdir():
                    raise ValueError("directory differs from input: " + name)
            elif stat.S_ISREG(info.st_mode):
                if not member.isfile() or member.size != info.st_size:
                    raise ValueError("file type or size differs from input: " + name)
                with path.open("rb") as original, archive.extractfile(member) as archived:
                    while True:
                        block = original.read(1024 * 1024)
                        if archived.read(len(block) if block else 1) != block:
                            raise ValueError("file bytes differ from input: " + name)
                        if not block:
                            break
            else:
                raise ValueError("unsupported input node: " + name)
    missing = (set(expected) | {"selected-sources.json"}) - seen
    if missing:
        raise ValueError("missing archive members: " + ", ".join(sorted(missing)[:8]))
    return len(seen)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("spec", type=Path)
    parser.add_argument("materials", type=Path)
    parser.add_argument("archive", type=Path)
    args = parser.parse_args()
    count = verify(args.spec, args.materials, args.archive)
    print(f"Verified {count} selected source/archive members against exact inputs without extraction")
