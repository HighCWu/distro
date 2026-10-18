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
from unittest.mock import patch
import zipfile


ROOT = Path(__file__).resolve().parent
BUILDER = runpy.run_path(str(ROOT / "build-example.py"))


class PublishedExample(unittest.TestCase):
    def test_incomplete_source_preserves_previous_bundle_and_cleans_staging(self):
        with tempfile.TemporaryDirectory(prefix="python-example-atomic-") as directory:
            root = Path(directory)
            source = root / "example"
            shutil.copytree(ROOT / "example", source)
            destination = root / "application.pyz"
            BUILDER["build"](destination, source)
            previous = destination.read_bytes()
            (source / BUILDER["FILES"][-1]).unlink()
            with self.assertRaises(FileNotFoundError):
                BUILDER["build"](destination, source)
            self.assertEqual(destination.read_bytes(), previous)
            self.assertEqual(set(root.iterdir()), {source, destination})
            destination.unlink()
            with self.assertRaises(FileNotFoundError):
                BUILDER["build"](destination, source)
            self.assertEqual(set(root.iterdir()), {source})

    def test_replace_failure_preserves_previous_bundle_and_cleans_staging(self):
        with tempfile.TemporaryDirectory(prefix="python-example-replace-") as directory:
            root = Path(directory)
            destination = root / "application.pyz"
            destination.write_bytes(b"previous bundle")
            with patch.object(os, "replace", side_effect=PermissionError("injected replace failure")):
                with self.assertRaisesRegex(PermissionError, "injected replace failure"):
                    BUILDER["build"](destination, ROOT / "example")
            self.assertEqual(destination.read_bytes(), b"previous bundle")
            self.assertEqual(list(root.iterdir()), [destination])

    def test_success_replaces_previous_bundle_with_readable_complete_archive(self):
        with tempfile.TemporaryDirectory(prefix="python-example-success-") as directory:
            root = Path(directory)
            destination = root / "application.pyz"
            destination.write_bytes(b"previous bundle")
            BUILDER["build"](destination, ROOT / "example")
            with zipfile.ZipFile(destination) as archive:
                self.assertIsNone(archive.testzip())
                self.assertEqual(archive.namelist(), list(BUILDER["FILES"]))
            self.assertEqual(destination.stat().st_mode & 0o777, 0o644)
            self.assertEqual(list(root.iterdir()), [destination])

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
