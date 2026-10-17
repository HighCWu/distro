# SPDX-License-Identifier: MIT
"""Check the real application bundle without a target compiler or kernel."""

import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile


ROOT = Path(__file__).resolve().parent
BUILDER = runpy.run_path(str(ROOT / "build-example.py"))


class PublishedExample(unittest.TestCase):
    def test_fixed_metadata_and_explicit_membership(self):
        with tempfile.TemporaryDirectory(prefix="python-example-build-") as directory:
            root = Path(directory)
            source = root / "example"
            shutil.copytree(ROOT / "example", source)
            first, second = root / "first.pyz", root / "second.pyz"
            BUILDER["build"](first, source)
            (source / "unrelated.txt").write_text("must not ship\n")
            for name in BUILDER["FILES"]:
                os.utime(source / name, (1, 1))
            BUILDER["build"](second, source)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            with zipfile.ZipFile(first) as archive:
                self.assertEqual(archive.namelist(), list(BUILDER["FILES"]))
                for item in archive.infolist():
                    self.assertEqual(item.date_time, (1980, 1, 1, 0, 0, 0))
                    self.assertEqual(item.compress_type, zipfile.ZIP_DEFLATED)
                    self.assertEqual(archive.read(item), (source / item.filename).read_bytes())

    def test_published_archive_runs_after_source_removal(self):
        with tempfile.TemporaryDirectory(prefix="python-example-relocate-") as directory:
            root = Path(directory)
            source = root / "example"
            shutil.copytree(ROOT / "example", source)
            archive = root / "application.pyz"
            BUILDER["build"](archive, source)
            shutil.rmtree(source)
            result = subprocess.run(
                [sys.executable, "-B", str(ROOT / "application-test.py"), "--example", str(archive)],
                capture_output=True, text=True, timeout=15,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("published MIT zipapp, resources, metadata and binary pipes verified",
                          result.stdout)

    def test_missing_distribution_metadata_is_not_accepted(self):
        with tempfile.TemporaryDirectory(prefix="python-example-negative-") as directory:
            archive = Path(directory) / "broken.pyz"
            with zipfile.ZipFile(archive, "w") as output:
                for name in BUILDER["FILES"]:
                    if not name.endswith("/METADATA"):
                        output.writestr(name, (ROOT / "example" / name).read_bytes())
            result = subprocess.run(
                [sys.executable, str(archive)], input=b"", capture_output=True, timeout=10,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b"PackageNotFoundError", result.stderr)


if __name__ == "__main__":
    unittest.main()
