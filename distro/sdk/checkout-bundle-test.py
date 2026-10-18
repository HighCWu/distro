# SPDX-License-Identifier: MIT
import importlib.util
import io
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

loader = importlib.util.spec_from_file_location("checkout_bundle", Path(__file__).with_name("checkout-bundle.py"))
bundle = importlib.util.module_from_spec(loader)
loader.loader.exec_module(bundle)


class CheckoutTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="distro-checkout-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repository = self.root / "repository"
        self.repository.mkdir()
        self.git("init", "--quiet")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("config", "core.autocrlf", "false")
        (self.repository / "flake.lock").write_bytes(b"selected lock\x00\xff")
        (self.repository / ".hidden").write_text("hidden source\n")
        nested = self.repository / "recipes/with space"
        nested.mkdir(parents=True)
        (nested / "tool").write_text("#!/bin/sh\nexit 0\n")
        (nested / "tool").chmod(0o755)
        (self.repository / "link").symlink_to("flake.lock")
        self.commit()
        self.archive = self.root / "output/checkout.tar.gz"

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.repository), *args], stderr=subprocess.PIPE).decode().strip()

    def commit(self):
        self.git("add", ".")
        self.git("commit", "--quiet", "-m", "fixture")
        self.revision = self.git("rev-parse", "HEAD")

    def test_exact_committed_checkout_ignores_worktree_and_is_reproducible(self):
        self.assertEqual(bundle.export(self.repository, self.revision, self.archive), 4)
        original = self.archive.read_bytes()
        (self.repository / "flake.lock").write_text("dirty worktree\n")
        (self.repository / "untracked").write_text("not selected\n")
        bundle.export(self.repository, self.revision, self.archive)
        self.assertEqual(self.archive.read_bytes(), original)
        self.assertEqual(bundle.verify(self.repository, self.revision, self.archive), 4)
        with tarfile.open(self.archive) as archive:
            self.assertTrue(archive.getmember("distro/link").issym())
            self.assertEqual(archive.extractfile("distro/flake.lock").read(), b"selected lock\x00\xff")
            self.assertEqual(archive.getmember("distro/recipes/with space/tool").mode, 0o755)

    def test_export_attributes_cannot_omit_or_rewrite_committed_sources(self):
        bundle.export(self.repository, self.revision, self.archive)
        original = self.archive.read_bytes()
        for rule in (".hidden export-ignore\n", "flake.lock export-subst\n"):
            (self.repository / ".gitattributes").write_text(rule)
            (self.repository / "flake.lock").write_text("$Format:%H$\n")
            self.commit()
            with self.assertRaises(ValueError):
                bundle.export(self.repository, self.revision, self.archive)
            self.assertEqual(original, self.archive.read_bytes())
            self.assertEqual(list(self.archive.parent.glob(".distro-checkout-*")), [])

    def test_unbundled_submodule_is_rejected(self):
        self.git("update-index", "--add", "--cacheinfo", "160000," + self.revision + ",sources/example")
        self.git("commit", "--quiet", "-m", "gitlink")
        with self.assertRaisesRegex(ValueError, "submodule"):
            bundle.export(self.repository, "HEAD", self.archive)

    def test_destination_cannot_overwrite_sources_or_git_metadata(self):
        before = (self.repository / "flake.lock").read_bytes()
        for destination in (self.repository / "flake.lock", self.repository / ".git/config"):
            with self.assertRaisesRegex(ValueError, "tracked files or Git metadata"):
                bundle.export(self.repository, self.revision, destination)
        self.assertEqual((self.repository / "flake.lock").read_bytes(), before)
        self.assertEqual(self.git("rev-parse", "HEAD"), self.revision)

    def test_changed_or_duplicate_archive_members_are_rejected(self):
        bundle.export(self.repository, self.revision, self.archive)
        with tarfile.open(self.archive) as archive:
            headers = dict(archive.pax_headers)
            entries = [(member, archive.extractfile(member).read() if member.isfile() else None)
                       for member in archive.getmembers()]
        for mutation in ("bytes", "duplicate", "identity"):
            with self.subTest(mutation=mutation):
                with tarfile.open(self.archive, "w:gz", format=tarfile.PAX_FORMAT,
                                  pax_headers={} if mutation == "identity" else headers) as archive:
                    for member, data in entries:
                        if mutation == "bytes" and member.name == "distro/flake.lock":
                            data = b"X" * len(data)
                        archive.addfile(member, io.BytesIO(data) if data is not None else None)
                    if mutation == "duplicate":
                        member, data = entries[-1]
                        archive.addfile(member, io.BytesIO(data) if data is not None else None)
                with self.assertRaises(ValueError):
                    bundle.verify(self.repository, self.revision, self.archive)


if __name__ == "__main__":
    unittest.main()
