# SPDX-License-Identifier: MIT
"""Replay the actual CI source collector with immutable native fixtures."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import textwrap
import unittest


class SourceArtifactTest(unittest.TestCase):
    def test_collects_readonly_nix_materials_and_committed_checkout(self):
        source = Path(__file__).resolve().parent
        workflow = (source.parent.parent / ".github/workflows/ci.yml").read_text()
        section = workflow.split("      - name: Collect validated SDK source inputs\n", 1)[1]
        section = section.split("      - name:", 1)[0]
        script = textwrap.dedent(section.split("        run: |\n", 1)[1])
        for check in ("sdk-check-source-bundle", "sdk-wasm64-check-source-bundle"):
            with self.subTest(check=check), tempfile.TemporaryDirectory(prefix="sdk-source-artifact-") as directory:
                root = Path(directory)
                repository = root / "checkout"
                sdk = repository / "distro/sdk"
                sdk.mkdir(parents=True)
                for name in ("checkout-bundle.py", "checkout-bundle-test.py"):
                    shutil.copyfile(source / name, sdk / name)
                def git(*args):
                    return subprocess.check_output(["git", "-C", str(repository), *args], stderr=subprocess.PIPE).decode().strip()
                git("init", "--quiet")
                git("config", "user.name", "Fixture")
                git("config", "user.email", "fixture@example.invalid")
                git("add", ".")
                git("commit", "--quiet", "-m", "selected fixture sources")
                bundle = root / "nix-output"
                bundle.mkdir()
                checksums = ""
                for name in ("sdk-selected-sources.tar.gz", "README.md"):
                    data = ("synthetic native fixture: " + name + "\n").encode()
                    (bundle / name).write_bytes(data)
                    (bundle / name).chmod(0o444)
                    checksums += hashlib.sha256(data).hexdigest() + "  " + name + "\n"
                (bundle / "SHA256SUMS").write_text(checksums)
                (bundle / "SHA256SUMS").chmod(0o444)
                tools = root / "tools"
                tools.mkdir()
                (tools / "nix").write_text('#!/bin/sh\nprintf "%s\\n" "$FIXTURE_BUNDLE"\n')
                (tools / "nix").chmod(0o755)
                result = subprocess.run(["bash", "-euo", "pipefail", "-c", script], cwd=repository,
                                        env={**os.environ, "SDK_CHECK": check, "GITHUB_SHA": git("rev-parse", "HEAD"),
                                             "FIXTURE_BUNDLE": str(bundle), "PATH": str(tools) + os.pathsep + os.environ["PATH"]},
                                        capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                collected = repository / "sdk-selected-sources"
                self.assertEqual({path.name for path in collected.iterdir()}, {
                    "sdk-selected-sources.tar.gz", "README.md", "SHA256SUMS", "distro-checkout.tar.gz"})
                self.assertEqual((bundle / "SHA256SUMS").read_text(), checksums)
                actual = (collected / "SHA256SUMS").read_text()
                self.assertTrue(actual.startswith(checksums))
                self.assertEqual(actual.count("distro-checkout.tar.gz"), 1)
                self.assertIn("Verified 2 committed distro files", result.stdout)


if __name__ == "__main__":
    unittest.main()
