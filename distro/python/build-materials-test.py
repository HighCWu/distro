# SPDX-License-Identifier: MIT
"""Exercise the real collector with small synthetic configure outputs."""

from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent
REQUIRED = ("pyconfig.h", "Makefile", "config.log", "Modules/Setup.stdlib",
            "Modules/Setup.bootstrap", "LICENSE")


class BuildMaterials(unittest.TestCase):
    def collect(self, root, missing=None, empty_patch=False):
        tree, output = root / "configured tree", root / "materials"
        for name in REQUIRED:
            path = tree / name
            path.parent.mkdir(parents=True, exist_ok=True)
            if name != missing:
                path.write_text("actual fixture " + name + "\n")
        metadata = root / "metadata.json"
        metadata.write_text('{"schemaVersion":1,"addressBits":64}\n')
        patches = []
        # Same basename in different directories must not overwrite a patch.
        for index in range(2):
            patch = root / str(index) / "same.patch"
            patch.parent.mkdir()
            patch.write_text("" if empty_patch and index == 1 else "patch " + str(index) + "\n")
            patches.append(patch)
        result = subprocess.run(
            ["bash", str(ROOT / "build-materials.sh"), str(tree), str(output),
             str(ROOT / "package.nix"), str(metadata), *map(str, patches)],
            capture_output=True, text=True, timeout=10,
        )
        return result, output, tree, patches

    def test_preserves_configuration_and_all_ordered_patches(self):
        with tempfile.TemporaryDirectory(prefix="python-materials-") as directory:
            result, output, tree, patches = self.collect(Path(directory))
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            for name in REQUIRED:
                self.assertEqual((output / name).read_bytes(), (tree / name).read_bytes())
            for index, patch in enumerate(patches):
                self.assertEqual((output / "patches" / f"{index:03d}.patch").read_bytes(),
                                 patch.read_bytes())
            (output / "pyconfig.h").write_text("tampered\n")
            check = subprocess.run(["sha256sum", "--check", "SHA256SUMS"], cwd=output,
                                   capture_output=True, timeout=10)
            self.assertNotEqual(check.returncode, 0)

    def test_missing_configured_input_fails(self):
        for name in REQUIRED:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                result, output, _, _ = self.collect(Path(directory), missing=name)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((output / "SHA256SUMS").exists())

    def test_empty_configured_patch_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            result, output, _, _ = self.collect(Path(directory), empty_patch=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((output / "SHA256SUMS").exists())

    def test_verification_binds_installed_bytes_and_materials(self):
        with tempfile.TemporaryDirectory(prefix="python-materials-verify-") as directory:
            root = Path(directory)
            result, materials, _, _ = self.collect(root)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            installed, verification = root / "installed root", root / "verification"
            binary = installed / "usr/bin/python3.13"
            binary.parent.mkdir(parents=True)
            binary.write_bytes(b"installed final bytes, not a target executable\x00\xff")
            result = subprocess.run(
                ["bash", str(ROOT / "verify-build-materials.sh"), str(materials),
                 str(installed), str(verification)], capture_output=True, text=True, timeout=10,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual((verification / "MATERIALS_SHA256SUMS").read_bytes(),
                             (materials / "SHA256SUMS").read_bytes())
            manifest = verification / "BINARY_SHA256SUMS"
            self.assertIn("  usr/bin/python3.13\n", manifest.read_text())
            check = subprocess.run(["sha256sum", "--check", str(manifest)], cwd=installed,
                                   capture_output=True, timeout=10)
            self.assertEqual(check.returncode, 0)
            binary.write_bytes(b"replaced interpreter\n")
            check = subprocess.run(["sha256sum", "--check", str(manifest)], cwd=installed,
                                   capture_output=True, timeout=10)
            self.assertNotEqual(check.returncode, 0)
            manifest.write_text("0" * 64 + "  usr/bin/python3.13\n")
            check = subprocess.run(["sha256sum", "--check", "SHA256SUMS"], cwd=verification,
                                   capture_output=True, timeout=10)
            self.assertNotEqual(check.returncode, 0)

    def test_verification_rejects_missing_binary_and_tampered_materials(self):
        for mode in ("missing-binary", "changed-config"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                result, materials, _, _ = self.collect(root)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                installed = root / "installed"
                installed.mkdir()
                if mode == "changed-config":
                    binary = installed / "usr/bin/python3.13"
                    binary.parent.mkdir(parents=True)
                    binary.write_bytes(b"fixture\n")
                    (materials / "pyconfig.h").write_text("changed\n")
                verification = root / "verification"
                result = subprocess.run(
                    ["bash", str(ROOT / "verify-build-materials.sh"), str(materials),
                     str(installed), str(verification)], capture_output=True, timeout=10,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(verification.exists())


if __name__ == "__main__":
    unittest.main()
