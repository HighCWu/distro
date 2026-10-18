# SPDX-License-Identifier: MIT
"""Native workload validation; not proof of the Wasm ABI or kernel behavior."""
import hashlib
import importlib.util
import json
import os
import runpy
import shutil
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import zipfile


EXAMPLE = Path(__file__).with_name("git-workspace-example.py")
spec = importlib.util.spec_from_file_location("git_workspace", EXAMPLE)
example = importlib.util.module_from_spec(spec)
spec.loader.exec_module(example)


class GitWorkspace(unittest.TestCase):
    def test_relocatable_zipapp_is_exact_reproducible_source_and_runs_both_phases(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()
            shutil.copyfile(EXAMPLE, source / "__main__.py")
            shutil.copyfile(EXAMPLE.parent / "example/LICENSE", source / "LICENSE")
            build = runpy.run_path(str(EXAMPLE.parent / "build-example.py"))["build"]
            archive = root / "git-workspace.pyz"
            build(archive, source, ("LICENSE", "__main__.py"))
            first = archive.read_bytes()
            os.utime(source / "__main__.py", (1, 1))
            build(archive, source, ("LICENSE", "__main__.py"))
            self.assertEqual(first, archive.read_bytes())
            with zipfile.ZipFile(archive) as bundle:
                self.assertEqual(bundle.namelist(), ["LICENSE", "__main__.py"])
                self.assertEqual(bundle.read("__main__.py"), EXAMPLE.read_bytes())
                self.assertEqual(bundle.read("LICENSE"), (source / "LICENSE").read_bytes())
                for entry in bundle.infolist():
                    self.assertEqual(entry.date_time, (1980, 1, 1, 0, 0, 0))
            shutil.rmtree(source)
            directory = root / "workspace ' $HOME → data"
            written = subprocess.run([sys.executable, "-I", str(archive), "write", str(directory)],
                                     capture_output=True, timeout=30)
            self.assertEqual(written.returncode, 0, written.stderr)
            self.assertEqual(written.stderr, b"")
            report = json.loads(written.stdout)
            read = subprocess.run([sys.executable, "-I", str(archive), "read", str(directory), report["head"]],
                                  capture_output=True, timeout=30)
            self.assertEqual(read.returncode, 0, read.stderr)
            self.assertEqual(read.stderr, b"")
            self.assertEqual(json.loads(read.stdout), {**report, "phase": "read"})

    def run_example(self, phase, directory, head=None):
        return subprocess.run([sys.executable, "-I", str(EXAMPLE), phase, str(directory), *([head] if head else [])],
                              capture_output=True, timeout=30)

    def test_native_cli_binary_hook_sqlite_and_clone(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "workspace ' $HOME → data"
            write = self.run_example("write", directory)
            self.assertEqual(write.returncode, 0, write.stderr)
            self.assertEqual(write.stderr, b"")
            result = json.loads(write.stdout)
            self.assertEqual(result["sha256"], hashlib.sha256(example.PAYLOAD).hexdigest())
            self.assertEqual(result["bytes"], 65553)
            read = self.run_example("read", directory, result["head"])
            self.assertEqual(read.returncode, 0, read.stderr)
            self.assertEqual(read.stderr, b"")
            self.assertEqual(json.loads(read.stdout), {**result, "phase": "read"})

    def test_real_read_rejects_corrupt_worktree_objects_hook_database_and_head(self):
        for mode in ("worktree", "object", "hook", "database", "head", "missing-database"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary) / "workspace"
                write = self.run_example("write", directory)
                self.assertEqual(write.returncode, 0, write.stderr)
                head = json.loads(write.stdout)["head"]
                repo = directory / "project ' $HOME → repo"
                if mode == "worktree":
                    (repo / example.FILE).write_bytes(b"changed")
                elif mode == "object":
                    pack = next((repo / ".git/objects/pack").glob("*.pack"))
                    pack.chmod(0o644)
                    pack.write_bytes(b"broken object pack")
                elif mode == "hook":
                    (repo / ".git/python-hook-marker").write_bytes(b"wrong hook marker")
                elif mode == "database":
                    connection = sqlite3.connect(directory / "workspace.sqlite")
                    connection.execute("UPDATE result SET payload=X'00'")
                    connection.commit()
                    connection.close()
                elif mode == "missing-database":
                    (directory / "workspace.sqlite").unlink()
                else:
                    head = "0" * 40
                read = self.run_example("read", directory, head)
                self.assertNotEqual(read.returncode, 0)
                if mode == "missing-database":
                    self.assertFalse((directory / "workspace.sqlite").exists())

    def test_existing_workspace_is_not_overwritten_and_invalid_read_creates_nothing(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "workspace"
            directory.mkdir()
            marker = directory / "user-file"
            marker.write_bytes(b"preserve me")
            self.assertNotEqual(self.run_example("write", directory).returncode, 0)
            self.assertEqual(marker.read_bytes(), b"preserve me")
            absent = Path(temporary) / "absent"
            self.assertNotEqual(self.run_example("read", absent, "bad-head").returncode, 0)
            self.assertFalse(absent.exists())

    def test_untrusted_git_environment_is_not_inherited(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "workspace"
            result = subprocess.run([sys.executable, "-I", str(EXAMPLE), "write", str(directory)], capture_output=True,
                                    timeout=30, env={**os.environ, "GIT_DIR": "/no-such-repository", "GIT_CONFIG_COUNT": "1",
                                    "GIT_CONFIG_KEY_0": "core.hooksPath", "GIT_CONFIG_VALUE_0": "/no-such-hooks"})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stderr, b"")


if __name__ == "__main__":
    unittest.main()
