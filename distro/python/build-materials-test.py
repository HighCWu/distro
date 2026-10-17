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


if __name__ == "__main__":
    unittest.main()
