# SPDX-License-Identifier: MIT
"""Archive selected SDK materials/sources; not a complete release or SDK."""
import argparse
import gzip
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile


FILES = (
    "installed/bin/wasm-linux-cc", "installed/bin/wasm-linux-c++",
    "installed/bin/wasm-linux-pkg-config", "installed/bin/wasm-linux-configure",
    "installed/bin/wasm-linux-sdk-info", "installed/profile.json",
    "installed/config.site", "installed/linux-wasm.cmake", "installed/linux-wasm.ini",
    "configuration/compiler.cfg", "configuration/clang++.cfg",
    "integration/flake.nix", "integration/flake.lock", "integration/platform.nix",
    "integration/stdenv.nix", "integration/default.nix",
)
TREES = ("licenses", "recipes/sdk", "recipes/llvm-toolchain", "recipes/llvm-runtimes",
         "recipes/musl", "recipes/linux", "recipes/sysroot", "recipes/sysroot-base")
SOURCES = ("linux", "musl", "llvm-toolchain", "llvm-runtimes", "meson")
SCOPE = "Selected SDK configuration, installed entry points, notices and recipes; not complete corresponding source, an SBOM, a relocatable SDK or an offline rebuild environment"


def tree_entries(path, name):
    if path.is_symlink():
        yield name, path, "symlink"
    elif path.is_dir():
        yield name, path, "directory"
        for child in sorted(path.iterdir(), key=lambda item: item.name):
            yield from tree_entries(child, name + "/" + child.name)
    elif path.is_file():
        yield name, path, "file"
    else:
        raise ValueError("unsupported material entry: " + name)


def collect(spec):
    if spec.get("schemaVersion") != 1 or spec.get("addressBits") not in (32, 64):
        raise ValueError("unsupported material schema or address width")
    for key, expected in (("files", FILES), ("trees", TREES), ("sources", SOURCES)):
        if set(spec[key]) != set(expected):
            raise ValueError("incomplete or unexpected material set: " + key)
    profile = json.loads(Path(spec["files"]["installed/profile.json"]).read_text())
    if (profile["schemaVersion"] != 1 or profile["addressBits"] != spec["addressBits"]
            or profile["targetTriple"] != spec["targetTriple"]
            or profile["linearMemory"]["maximumBytes"] != spec["maximumMemoryBytes"]):
        raise ValueError("installed profile differs from selected platform")
    for field, name in (("compilerConfiguration", "configuration/compiler.cfg"),
                        ("configSite", "installed/config.site")):
        if Path(profile["paths"][field]).resolve() != Path(spec["files"][name]).resolve():
            raise ValueError("installed profile path differs: " + field)
    if (Path(profile["paths"]["toolchain"]) / "bin/clang++.cfg").resolve() != Path(spec["files"]["configuration/clang++.cfg"]).resolve():
        raise ValueError("installed C++ configuration path differs")
    if Path(profile["paths"]["licenseTexts"]).resolve() != Path(spec["trees"]["licenses"]).resolve():
        raise ValueError("installed license path differs")
    origins = {}
    for name, value in spec["sources"].items():
        source = Path(value)
        if not source.is_dir() or len(source.name) < 34 or source.name[32] != "-":
            raise ValueError("missing selected source identity: " + name)
        origins[name] = {"hashParts": [source.name[:16], source.name[16:32]], "name": source.name[33:]}
    licenses = json.loads((Path(spec["trees"]["licenses"]) / "sources.json").read_text())
    if licenses["schemaVersion"] != 1 or licenses["sourceStoreIdentities"] != origins:
        raise ValueError("selected source identities differ from installed licenses")
    entries = []
    for name, value in spec["files"].items():
        path = Path(value).resolve(strict=True)
        if not path.is_file() or path.stat().st_size == 0:
            raise ValueError("missing or empty required file: " + name)
        entries.append((name, path, "file"))

    for name, value in spec["trees"].items():
        path = Path(value).resolve(strict=True)
        if not path.is_dir():
            raise ValueError("required tree is not a directory: " + name)
        if name.startswith("recipes/") and not (path / "package.nix").is_file():
            raise ValueError("missing component recipe: " + name)
        entries.extend(tree_entries(path, name))
    metadata = {key: spec[key] for key in ("schemaVersion", "addressBits", "targetTriple", "maximumMemoryBytes")}
    metadata.update(scope=SCOPE, sourceStoreIdentities=origins)
    return sorted(entries), (json.dumps(metadata, sort_keys=True, indent=2) + "\n").encode()


def collect_sources(spec):
    # Start with the same independently selected installed materials and source
    # identities. Equal source roots (not merely equal basenames) are stored once.
    entries, metadata = collect(spec)
    index = json.loads(metadata)
    index["scope"] = "Selected full Linux, musl, LLVM and Meson source inputs plus SDK materials; not complete corresponding source, an SBOM or an offline rebuild environment"
    index["sourceArchiveRoots"] = {}
    roots = {}
    for name in SOURCES:
        path = Path(spec["sources"][name]).resolve(strict=True)
        if path not in roots:
            roots[path] = "sources/" + name
            entries.extend(tree_entries(path, roots[path]))
        index["sourceArchiveRoots"][name] = roots[path]
    return sorted(entries), (json.dumps(index, sort_keys=True, indent=2) + "\n").encode()


def export(spec, destination, *, sources=False):
    entries, metadata = collect_sources(spec) if sources else collect(spec)
    index_name = "sdk-selected-sources.json" if sources else "sdk-build-materials.json"
    roots = [Path(value).resolve() for group in ("files", "trees", "sources") for value in spec[group].values()]
    # os.replace replaces a destination symlink itself, not its target. Check
    # the resolved parent as well so that a link inside a collected tree cannot
    # conceal an in-tree output location by pointing somewhere else.
    locations = (destination.resolve(), destination.parent.resolve() / destination.name)
    if any(location.is_relative_to(root) for location in locations for root in roots):
        raise ValueError("archive must be outside collected inputs")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=destination.parent, prefix=".sdk-materials-", delete=False) as output:
            temporary = Path(output.name)
            with gzip.GzipFile(filename="", fileobj=output, mode="wb", mtime=0) as compressed:
                with tarfile.open(fileobj=compressed, mode="w", format=tarfile.GNU_FORMAT) as archive:
                    for name, path, kind in entries:
                        member = tarfile.TarInfo(name)
                        member.mtime = 1
                        member.mode = 0o755 if kind == "directory" or path.lstat().st_mode & 0o111 else 0o644
                        if kind == "directory":
                            member.type = tarfile.DIRTYPE
                        elif kind == "symlink":
                            member.type = tarfile.SYMTYPE
                            member.linkname = os.readlink(path)
                        else:
                            member.size = path.stat().st_size
                            with path.open("rb") as source:
                                archive.addfile(member, source)
                            continue
                        archive.addfile(member)
                    member = tarfile.TarInfo(index_name)
                    member.size, member.mtime, member.mode = len(metadata), 1, 0o644
                    archive.addfile(member, io.BytesIO(metadata))
            os.fchmod(output.fileno(), 0o644)
        os.replace(temporary, destination)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def verify(spec, archive_path, *, sources=False):
    entries, metadata = collect_sources(spec) if sources else collect(spec)
    index_name = "sdk-selected-sources.json" if sources else "sdk-build-materials.json"
    # Compare against independently selected inputs, not just archive checksums.
    with tarfile.open(archive_path, "r:gz") as archive:
        members = archive.getmembers()
        if [member.name for member in members] != [name for name, _, _ in entries] + [index_name]:
            raise ValueError("archive members differ from selected materials")
        for member, (name, path, kind) in zip(members, entries):
            mode = 0o755 if kind == "directory" or path.lstat().st_mode & 0o111 else 0o644
            if (member.uid, member.gid, member.uname, member.gname, member.mtime, member.mode) != (0, 0, "", "", 1, mode):
                raise ValueError("noncanonical material metadata: " + name)
            if kind == "directory":
                valid = member.isdir()
            elif kind == "symlink":
                valid = member.issym() and member.linkname == os.readlink(path)
            else:
                valid = member.type == tarfile.REGTYPE and member.size == path.stat().st_size
                if valid:
                    with archive.extractfile(member) as actual, path.open("rb") as expected:
                        while chunk := expected.read(65536):
                            if actual.read(len(chunk)) != chunk:
                                valid = False
                                break
            if not valid:
                raise ValueError("material differs from selected input: " + name)
        last = members[-1]
        if ((last.type, last.uid, last.gid, last.uname, last.gname, last.mtime, last.mode, last.size)
                != (tarfile.REGTYPE, 0, 0, "", "", 1, 0o644, len(metadata))
                or archive.extractfile(last).read() != metadata):
            raise ValueError("SDK material identity differs")
    return len(members)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("export", "verify", "source-export", "source-verify"))
    parser.add_argument("spec", type=Path)
    parser.add_argument("archive", type=Path)
    args = parser.parse_args()
    selected = json.loads(args.spec.read_text())
    if args.mode in ("export", "source-export"):
        export(selected, args.archive, sources=args.mode == "source-export")
    else:
        print(f"Verified {verify(selected, args.archive, sources=args.mode == 'source-verify')} exact SDK archive members")
