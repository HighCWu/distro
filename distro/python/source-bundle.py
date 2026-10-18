# SPDX-License-Identifier: MIT
"""Archive exact selected source inputs, not a compliance certification."""
import argparse
import gzip
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile


NAMES = ("python", "zlib", "bzip2", "xz", "sqlite3", "readline", "ncurses", "openssl")


def export(spec_path, materials, destination):
    spec = json.loads(spec_path.read_text())
    build = json.loads((materials / "build.json").read_text())
    if spec["schemaVersion"] != 1 or build["schemaVersion"] != 1:
        raise ValueError("unsupported source or build schema")
    for field in ("addressBits", "maximumMemoryBytes"):
        if spec[field] != build[field]:
            raise ValueError("source/build platform mismatch: " + field)
    components = spec["components"]
    if tuple(item["name"] for item in components) != NAMES:
        raise ValueError("all eight selected components must be present in order")
    identities = [build["sourceIdentity"]] + [item["sourceIdentity"] for item in build["dependencies"]]
    if identities != [item["sourceIdentity"] for item in components]:
        raise ValueError("selected source identities differ from configured interpreter")
    subprocess.run(["sha256sum", "--check", "SHA256SUMS"], cwd=materials, check=True)
    index = {key: spec[key] for key in ("schemaVersion", "addressBits", "maximumMemoryBytes")}
    index["scope"] = "Exact selected sources, recipes and ordered patches; not complete corresponding source, an SBOM or an offline rebuild environment"
    index["components"] = []
    inputs = [materials]
    for item in components:
        source = Path(item["sourcePath"])
        recipe = Path(item["recipeDirectory"])
        patches = [Path(path) for path in item["patchPaths"]]
        if source.name != item["sourceIdentity"] or not source.is_dir():
            raise ValueError("missing or mismatched source: " + item["name"])
        if not (recipe / "package.nix").is_file():
            raise ValueError("missing integration recipe: " + item["name"])
        inputs.extend((source, recipe))
        if any(not path.is_file() or path.stat().st_size == 0 for path in patches):
            raise ValueError("missing or empty configured patch: " + item["name"])
        index["components"].append({
            "name": item["name"], "sourceIdentity": item["sourceIdentity"],
            "patches": [f"patches/{item['name']}/{number:03d}.patch" for number in range(len(patches))],
        })
    python = components[0]
    if (Path(python["recipeDirectory"]) / "package.nix").read_bytes() != (materials / "package.nix").read_bytes():
        raise ValueError("Python recipe differs from configured interpreter")
    if len(python["patchPaths"]) != len(build["patches"]):
        raise ValueError("Python patch count differs from configured interpreter")
    for number, path in enumerate(python["patchPaths"]):
        if Path(path).read_bytes() != (materials / "patches" / f"{number:03d}.patch").read_bytes():
            raise ValueError("Python ordered patch differs from configured interpreter")
    if any(destination.resolve().is_relative_to(path.resolve()) for path in inputs):
        raise ValueError("archive must be outside all collected input directories")

    def normalized(member):
        # Store regular files independently even when Nix store optimisation
        # has hardlinked equal files across inputs. Source symlinks remain
        # symlinks; no filesystem target is followed during tree traversal.
        archive.inodes.clear()
        member.uid = member.gid = 0
        member.uname = member.gname = ""
        member.mtime = 1
        return member

    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=destination.parent, prefix=".python-sources-", delete=False) as output:
            temporary = Path(output.name)
            with gzip.GzipFile(filename="", mode="wb", fileobj=output, mtime=0) as compressed:
                with tarfile.open(mode="w", fileobj=compressed, format=tarfile.GNU_FORMAT, dereference=False) as archive:
                    archive.add(materials, arcname="build-materials", filter=normalized)
                    for item in components:
                        name = item["name"]
                        archive.add(Path(item["sourcePath"]).resolve(), arcname="sources/" + name, filter=normalized)
                        archive.add(Path(item["recipeDirectory"]).resolve(), arcname="recipes/" + name, filter=normalized)
                        for number, path in enumerate(item["patchPaths"]):
                            # A patch may already occur in recipes/ with the same
                            # inode. Store independent bytes, never an archive
                            # hardlink or a store-absolute source symlink.
                            data = Path(path).read_bytes()
                            member = tarfile.TarInfo(f"patches/{name}/{number:03d}.patch")
                            member.size = len(data)
                            member.mode = 0o644
                            archive.addfile(normalized(member), io.BytesIO(data))
                    # The public index records identities, not machine-local input paths.
                    data = (json.dumps(index, indent=2, sort_keys=True) + "\n").encode()
                    member = tarfile.TarInfo("selected-sources.json")
                    member.size = len(data)
                    member.mode = 0o644
                    archive.addfile(normalized(member), io.BytesIO(data))
            output.flush()
            os.fchmod(output.fileno(), 0o644)
        os.replace(temporary, destination)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("spec", type=Path)
    parser.add_argument("materials", type=Path)
    parser.add_argument("archive", type=Path)
    args = parser.parse_args()
    export(args.spec, args.materials, args.archive)
