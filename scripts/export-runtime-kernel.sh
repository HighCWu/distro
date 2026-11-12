#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
set -euo pipefail

exec python3 - "$@" <<'PY'
import argparse
import hashlib
import json
import os
import re
import shutil
import tempfile
from pathlib import Path
from pathlib import PurePosixPath


PROFILES = {
    "default-wasm64",
    "dynamic-wasm64",
    "linux64-abi-dynamic-wasm64",
}


def fail(message):
    raise SystemExit(message)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_json(path, label):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        fail(f"cannot read {label}: {error}")
    if not isinstance(value, dict):
        fail(f"{label} must be a JSON object")
    return value


def parse_sha256sums(path, required):
    try:
        lines = path.read_text(encoding="ascii").splitlines()
    except (OSError, UnicodeError) as error:
        fail(f"cannot read source bundle checksums: {error}")
    result = {}
    for line in lines:
        match = re.fullmatch(r"([0-9a-f]{64})  ([^/\\\x00]+)", line)
        if not match:
            fail("source bundle SHA256SUMS has an unsupported line")
        digest, name = match.groups()
        if name in result:
            fail("source bundle SHA256SUMS has a duplicate filename")
        result[name] = digest
    for name in required:
        if name not in result:
            fail(f"source bundle SHA256SUMS is missing {name}")
    return result


def source_recipe(package_path):
    try:
        package = package_path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        fail(f"cannot read kernel package recipe: {error}")
    match = re.search(
        r"(?ms)^\s*src\s*\?\s*import\s+\./fetch-source\.nix\s*\{(.*?)^\s*\},\s*$",
        package,
    )
    if not match:
        fail("kernel package recipe has no fixed fetch-source block")
    block = match.group(1)
    fields = {}
    for field in ("owner", "repo", "rev", "hash"):
        values = re.findall(
            r"(?m)^\s*" + re.escape(field) + r'\s*=\s*"([^"\n]+)";\s*$',
            block,
        )
        if len(values) != 1:
            fail(f"kernel package fetch-source block must contain one {field}")
        fields[field] = values[0]
    if re.fullmatch(r"[0-9a-f]{40}", fields["rev"]) is None:
        fail("kernel source revision must be a full 40-character Git SHA")
    if not fields["owner"] or not fields["repo"] or not fields["hash"].startswith("sha256-"):
        fail("kernel source fetch identity is incomplete")
    return fields


def verify_kernel_build(kernel_root, linux_build, build):
    if (
        not isinstance(build, dict)
        or type(build.get("schemaVersion")) is not int
        or build["schemaVersion"] != 1
        or type(build.get("wasmBits")) is not int
        or build["wasmBits"] != 64
    ):
        fail("kernel build metadata is not a schema-1 wasm64 build")
    for field in ("fileMmapCandidate", "fileMmapStreamCandidate"):
        if not isinstance(build.get(field), bool):
            fail(f"kernel build metadata has no boolean {field}")

    for path in linux_build.rglob("*"):
        if path.is_symlink():
            fail(f"linux-build contains an unexpected symlink: {path.relative_to(linux_build)}")
    config_path = linux_build / "kernel.config"
    try:
        config = set(config_path.read_text(encoding="utf-8").splitlines())
    except (OSError, UnicodeError) as error:
        fail(f"cannot read kernel.config: {error}")
    wants_file_mmap = build["fileMmapCandidate"] or build["fileMmapStreamCandidate"]
    if ("CONFIG_WASM_FILE_MMAP=y" in config) != wants_file_mmap:
        fail("kernel.config does not match the file-mmap build metadata")
    if ("CONFIG_WASM_FILE_MMAP_STREAM=y" in config) != build["fileMmapStreamCandidate"]:
        fail("kernel.config does not match the streaming file-mmap metadata")

    required = (
        kernel_root / "vmlinux.wasm",
        linux_build / "kernel.config",
        linux_build / "build.json",
        linux_build / "COPYING",
        linux_build / "LICENSES/preferred/GPL-2.0",
        linux_build / "LICENSES/exceptions/Linux-syscall-note",
        linux_build / "package.nix",
        linux_build / "fetch-source.nix",
        linux_build / "README.md",
        linux_build / "SHA256SUMS",
    )
    for path in required:
        if not path.is_file() or path.is_symlink() or path.stat().st_size == 0:
            fail(f"required kernel file is missing or empty: {path.name}")

    # The kernel package's own checksum file binds vmlinux.wasm and every
    # linux-build material to the same build output.
    try:
        lines = (linux_build / "SHA256SUMS").read_text(encoding="ascii").splitlines()
    except (OSError, UnicodeError) as error:
        fail(f"cannot read linux-build/SHA256SUMS: {error}")
    seen = set()
    for line in lines:
        match = re.fullmatch(r"([0-9a-f]{64})  (vmlinux\.wasm|linux-build/.+)", line)
        if not match:
            fail("linux-build/SHA256SUMS has an unsupported entry")
        expected, relative = match.groups()
        relative_path = PurePosixPath(relative)
        if relative_path.is_absolute() or any(part in ("", ".", "..") for part in relative_path.parts):
            fail("linux-build/SHA256SUMS contains a non-local path")
        if relative in seen:
            fail("linux-build/SHA256SUMS has a duplicate entry")
        seen.add(relative)
        target = kernel_root / relative
        if not target.is_file() or target.is_symlink() or sha256(target) != expected:
            fail(f"kernel build checksum mismatch: {relative}")
    if "vmlinux.wasm" not in seen or "linux-build/kernel.config" not in seen:
        fail("linux-build/SHA256SUMS does not bind the kernel and configuration")
    expected_files = {
        "vmlinux.wasm",
        *(
            "linux-build/" + path.relative_to(linux_build).as_posix()
            for path in linux_build.rglob("*")
            if path.is_file() and path.name != "SHA256SUMS"
        ),
    }
    if seen != expected_files:
        fail("linux-build/SHA256SUMS does not cover every kernel build material")


def copy_material_tree(source, destination):
    destination.mkdir(parents=True)
    for path in sorted(source.rglob("*")):
        relative = path.relative_to(source)
        target = destination / relative
        if path.is_dir():
            target.mkdir()
        elif path.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)
        else:
            fail(f"unsupported linux-build entry: {relative}")


def main():
    parser = argparse.ArgumentParser(description="Export the matching wasm64 kernel and build materials")
    parser.add_argument("--runtime-path", required=True)
    parser.add_argument("--profile", required=True, choices=sorted(PROFILES))
    parser.add_argument("--github-sha", required=True)
    parser.add_argument("--sdk-closure-manifest", required=True)
    parser.add_argument("--sdk-closure-artifact", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()

    if re.fullmatch(r"[0-9a-f]{40}", args.github_sha) is None:
        fail("repository commit must be a full 40-character Git SHA")
    closure_prefix = f"sdk-closure-{args.profile}-{args.github_sha}"
    tooling_suffix = ""
    if args.sdk_closure_artifact == closure_prefix + "-tooling":
        tooling_suffix = "-tooling"
    elif args.sdk_closure_artifact != closure_prefix:
        fail("SDK closure artifact name does not match the selected profile and commit")

    closure_manifest_path = Path(args.sdk_closure_manifest)
    expected_manifest_name = f"sdk-{args.profile}-{args.github_sha}{tooling_suffix}.json"
    if closure_manifest_path.name != expected_manifest_name:
        fail("SDK closure manifest filename does not match its artifact")
    closure_manifest = read_json(closure_manifest_path, "SDK closure manifest")
    expected_schema = 2 if tooling_suffix else 1
    if (
        type(closure_manifest.get("schemaVersion")) is not int
        or closure_manifest["schemaVersion"] != expected_schema
        or closure_manifest.get("profile") != args.profile
        or closure_manifest.get("repositoryCommit") != args.github_sha
        or closure_manifest.get("runtimeAssetsPath") != args.runtime_path
    ):
        fail("SDK closure manifest does not identify this runtime kernel")
    if tooling_suffix and not isinstance(closure_manifest.get("tooling"), dict):
        fail("tooling SDK closure manifest has no tooling metadata")
    closure_archive = f"sdk-{args.profile}-{args.github_sha}{tooling_suffix}.nar.zst"
    if closure_manifest.get("closureArchive") != closure_archive:
        fail("SDK closure manifest names an unexpected closure archive")
    archive_sha = closure_manifest.get("closureSha256")
    if not isinstance(archive_sha, str) or re.fullmatch(r"[0-9a-f]{64}", archive_sha) is None:
        fail("SDK closure manifest has no valid archive SHA256")

    runtime = Path(args.runtime_path)
    if not runtime.is_absolute():
        fail("runtime assets path must be absolute")
    try:
        kernel_root = (runtime / "kernel").resolve(strict=True)
        linux_build = (runtime / "sources/linux-build-materials").resolve(strict=True)
        source_bundle = (runtime / "sources/kernel-source-bundle").resolve(strict=True)
    except OSError:
        fail("runtime assets are missing the kernel or source references")
    if not kernel_root.is_dir() or not linux_build.is_dir() or not source_bundle.is_dir():
        fail("runtime assets are missing the kernel or source references")

    build = read_json(linux_build / "build.json", "kernel build metadata")
    verify_kernel_build(kernel_root, linux_build, build)
    source_checksums_path = source_bundle / "SHA256SUMS"
    source_checksums = parse_sha256sums(source_checksums_path, ("linux-source.tar.gz", "README.md"))
    source_archive = source_bundle / "linux-source.tar.gz"
    source_readme = source_bundle / "README.md"
    if not source_archive.is_file():
        fail("kernel source bundle is missing linux-source.tar.gz")
    if not source_readme.is_file():
        fail("kernel source bundle is missing README.md")
    if sha256(source_archive) != source_checksums["linux-source.tar.gz"]:
        fail("kernel source archive checksum mismatch")
    if sha256(source_readme) != source_checksums["README.md"]:
        fail("kernel source bundle README checksum mismatch")
    source_recipe_metadata = source_recipe(linux_build / "package.nix")

    output = Path(args.output_dir)
    if output.exists():
        if not output.is_dir() or any(output.iterdir()):
            fail("output directory must be absent or empty")
        output.rmdir()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent))
    try:
        shutil.copy2(kernel_root / "vmlinux.wasm", temporary / "vmlinux.wasm")
        copy_material_tree(linux_build, temporary / "linux-build")

        payload_files = {}
        for path in sorted(temporary.rglob("*")):
            if path.is_file():
                payload_files[path.relative_to(temporary).as_posix()] = sha256(path)

        source_bundle_ref = {
            "runtimePath": "sources/kernel-source-bundle",
            "storePath": str(source_bundle),
            "sha256sumsFileSha256": sha256(source_checksums_path),
            "files": {
                "linux-source.tar.gz": source_checksums["linux-source.tar.gz"],
                "README.md": source_checksums["README.md"],
            },
            "sdkClosure": {
                "artifact": args.sdk_closure_artifact,
                "manifestFile": closure_manifest_path.name,
                "manifestSha256": sha256(closure_manifest_path),
                "archiveFile": closure_archive,
                "archiveSha256": closure_manifest["closureSha256"],
                "runtimeAssetsPath": args.runtime_path,
            },
        }
        manifest = {
            "schemaVersion": 1,
            "repositoryCommit": args.github_sha,
            "sdkProfile": args.profile,
            "runtimeAssetsPath": args.runtime_path,
            "kernelSource": {
                "selectedSourceIdentity": build["sourceIdentity"],
                "recipeDefault": {
                    "owner": source_recipe_metadata["owner"],
                    "repository": source_recipe_metadata["repo"],
                    "revision": source_recipe_metadata["rev"],
                    "fetchHash": source_recipe_metadata["hash"],
                },
            },
            "kernelBuild": build,
            "files": payload_files,
            "sourceBundleReference": source_bundle_ref,
        }
        (temporary / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=True, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

        checksum_lines = []
        for path in sorted(temporary.rglob("*")):
            if path.is_file():
                relative = path.relative_to(temporary).as_posix()
                checksum_lines.append(f"{sha256(path)}  {relative}\n")
        (temporary / "SHA256SUMS").write_text("".join(checksum_lines), encoding="ascii")
        os.replace(temporary, output)
    except BaseException:
        shutil.rmtree(temporary, ignore_errors=True)
        raise

    print(f"exported matching kernel and materials to {output}")


if __name__ == "__main__":
    main()
PY
