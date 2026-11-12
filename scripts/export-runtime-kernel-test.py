#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts/export-runtime-kernel.sh"
COMMIT = "0123456789abcdef0123456789abcdef01234567"
PROFILE = "dynamic-wasm64"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def put(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data if isinstance(data, bytes) else data.encode("utf-8"))


def write_sums(root, destination, excluded):
    lines = []
    for path in sorted(root.rglob("*")):
        if path.is_file() and path.relative_to(root).as_posix() not in excluded:
            lines.append(f"{digest(path.read_bytes())}  {path.relative_to(root).as_posix()}\n")
    destination.write_text("".join(lines), encoding="ascii")


def make_fixture(root, *, stream=True, source_reference=True, tooling=False):
    runtime = root / "runtime-assets"
    kernel_store = root / "kernel-store"
    build = kernel_store / "linux-build"
    source_bundle = root / "kernel-source-bundle"
    put(kernel_store / "vmlinux.wasm", b"\0asm\x01\0\0\0kernel-profile-bytes")
    put(build / "kernel.config", "CONFIG_64BIT=y\nCONFIG_WASM_FILE_MMAP=y\n" + ("CONFIG_WASM_FILE_MMAP_STREAM=y\n" if stream else ""))
    metadata = {
        "schemaVersion": 1,
        "wasmBits": 64,
        "debug": False,
        "mmapCopyTest": False,
        "fileMmapCandidate": False,
        "fileMmapStreamCandidate": stream,
        "vtimeCandidate": False,
        "userNamespaceCandidate": False,
        "elfContainerCandidate": False,
        "checkpointRestoreCandidate": False,
        "sourceIdentity": {"hashParts": ["0123456789abcdfg", "hijklmnpqrsvwxyz"], "name": "source"},
        "llvmToolchainIdentity": {"hashParts": ["hijklmnpqrsvwxyz", "0123456789abcdfg"], "name": "toolchain"},
        "scope": "Exact materials from the selected kernel build.",
    }
    put(build / "build.json", json.dumps(metadata, sort_keys=True) + "\n")
    put(build / "COPYING", "kernel license fixture\n")
    put(build / "LICENSES/preferred/GPL-2.0", "GPL fixture\n")
    put(build / "LICENSES/exceptions/Linux-syscall-note", "syscall note fixture\n")
    package = f'''{{
  src ? import ./fetch-source.nix {{
    inherit pkgs;
    owner = "HighCWu";
    repo = "linux";
    rev = "{COMMIT}";
    hash = "sha256-0123456789012345678901234567890123456789012=";
  }},
}}:
'''
    put(build / "package.nix", package)
    put(build / "fetch-source.nix", "{ pkgs, owner, repo, rev, hash }: pkgs.fetchgit { inherit rev hash; }\n")
    put(build / "README.md", "selected materials\n")
    write_sums(kernel_store, build / "SHA256SUMS", {"linux-build/SHA256SUMS"})

    put(source_bundle / "linux-source.tar.gz", b"complete source archive is referenced, not copied")
    put(source_bundle / "README.md", "selected full source bundle\n")
    write_sums(source_bundle, source_bundle / "SHA256SUMS", {"SHA256SUMS"})
    (runtime / "sources").mkdir(parents=True)
    (runtime / "kernel").symlink_to(kernel_store, target_is_directory=True)
    (runtime / "sources/linux-build-materials").symlink_to(build, target_is_directory=True)
    if source_reference:
        (runtime / "sources/kernel-source-bundle").symlink_to(source_bundle, target_is_directory=True)

    tooling_suffix = "-tooling" if tooling else ""
    closure_manifest = root / f"sdk-{PROFILE}-{COMMIT}{tooling_suffix}.json"
    closure = {
        "schemaVersion": 2 if tooling else 1,
        "repositoryCommit": COMMIT,
        "profile": PROFILE,
        "sdkAttribute": "sdk-dynamic-loader-wasm64",
        "sdkPath": "/nix/store/01234567890123456789012345678901-linux-wasm-dynamic-sdk-wasm64",
        "runtimeAssetsPath": str(runtime),
        "closureArchive": f"sdk-{PROFILE}-{COMMIT}{tooling_suffix}.nar.zst",
        "closureSha256": "a" * 64,
        "closureStorePathCount": 3,
    }
    if tooling:
        closure["tooling"] = {"storePath": "/nix/store/01234567890123456789012345678901-llvm-toolchain-development"}
    closure_manifest.write_text(json.dumps(closure) + "\n", encoding="utf-8")
    return runtime, closure_manifest, metadata


class RuntimeKernelExportTest(unittest.TestCase):
    def run_export(self, root, runtime, closure_manifest, output, *, closure_artifact=None):
        artifact = closure_artifact or f"sdk-closure-{PROFILE}-{COMMIT}"
        return subprocess.run(
            [
                "bash",
                str(SCRIPT),
                "--runtime-path",
                str(runtime),
                "--profile",
                PROFILE,
                "--github-sha",
                COMMIT,
                "--sdk-closure-manifest",
                str(closure_manifest),
                "--sdk-closure-artifact",
                artifact,
                "--output-dir",
                str(output),
            ],
            cwd=root,
            text=True,
            capture_output=True,
        )

    def test_exports_only_kernel_and_materials_with_hashes_and_source_reference(self):
        with tempfile.TemporaryDirectory(prefix="runtime-kernel-export-") as temporary:
            root = Path(temporary)
            runtime, closure_manifest, metadata = make_fixture(root)
            output = root / "bundle"
            exported = self.run_export(root, runtime, closure_manifest, output)
            self.assertEqual(exported.returncode, 0, exported.stderr)
            self.assertTrue((output / "vmlinux.wasm").is_file())
            self.assertTrue((output / "linux-build/kernel.config").is_file())
            self.assertTrue((output / "linux-build/COPYING").is_file())
            self.assertTrue((output / "linux-build/LICENSES/preferred/GPL-2.0").is_file())
            self.assertFalse((output / "linux-source.tar.gz").exists())
            self.assertFalse(any(path.name.endswith(".nar.zst") for path in output.rglob("*")))

            manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["repositoryCommit"], COMMIT)
            self.assertEqual(manifest["sdkProfile"], PROFILE)
            self.assertEqual(manifest["kernelBuild"], metadata)
            self.assertEqual(
                manifest["kernelSource"]["selectedSourceIdentity"],
                metadata["sourceIdentity"],
            )
            self.assertEqual(manifest["kernelSource"]["recipeDefault"]["revision"], COMMIT)
            source_ref = manifest["sourceBundleReference"]
            self.assertEqual(source_ref["sdkClosure"]["artifact"], f"sdk-closure-{PROFILE}-{COMMIT}")
            self.assertEqual(source_ref["sdkClosure"]["manifestFile"], closure_manifest.name)
            self.assertEqual(source_ref["files"]["linux-source.tar.gz"], digest(b"complete source archive is referenced, not copied"))
            self.assertEqual(manifest["files"]["vmlinux.wasm"], digest((output / "vmlinux.wasm").read_bytes()))
            self.assertIn("linux-build/kernel.config", manifest["files"])
            self.assertEqual(
                subprocess.run(["sha256sum", "--check", "SHA256SUMS"], cwd=output, capture_output=True).returncode,
                0,
            )
            self.assertEqual(
                subprocess.run(["sha256sum", "--check", "linux-build/SHA256SUMS"], cwd=output, capture_output=True).returncode,
                0,
            )

    def test_rejects_kernel_config_that_disagrees_with_profile_metadata(self):
        with tempfile.TemporaryDirectory(prefix="runtime-kernel-config- mismatch-") as temporary:
            root = Path(temporary)
            runtime, closure_manifest, _ = make_fixture(root, stream=False)
            config = runtime / "kernel/linux-build/kernel.config"
            put(config, "CONFIG_64BIT=y\nCONFIG_WASM_FILE_MMAP=y\nCONFIG_WASM_FILE_MMAP_STREAM=y\n")
            output = root / "bundle"
            exported = self.run_export(root, runtime, closure_manifest, output)
            self.assertNotEqual(exported.returncode, 0)
            self.assertFalse(output.exists())

    def test_rejects_missing_source_bundle_reference(self):
        with tempfile.TemporaryDirectory(prefix="runtime-kernel-source-reference-") as temporary:
            root = Path(temporary)
            runtime, closure_manifest, _ = make_fixture(root, source_reference=False)
            output = root / "bundle"
            exported = self.run_export(root, runtime, closure_manifest, output)
            self.assertNotEqual(exported.returncode, 0)
            self.assertFalse(output.exists())

    def test_tooling_closure_uses_the_tooling_manifest_and_artifact_names(self):
        with tempfile.TemporaryDirectory(prefix="runtime-kernel-tooling-") as temporary:
            root = Path(temporary)
            runtime, closure_manifest, _ = make_fixture(root, tooling=True)
            output = root / "bundle"
            artifact = f"sdk-closure-{PROFILE}-{COMMIT}-tooling"
            exported = self.run_export(root, runtime, closure_manifest, output, closure_artifact=artifact)
            self.assertEqual(exported.returncode, 0, exported.stderr)
            manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["sourceBundleReference"]["sdkClosure"]["artifact"], artifact)
            self.assertEqual(manifest["sourceBundleReference"]["sdkClosure"]["manifestFile"], closure_manifest.name)


if __name__ == "__main__":
    unittest.main()
