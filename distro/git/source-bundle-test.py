# SPDX-License-Identifier: MIT
"""Native fixtures validate the actual shared Git source archive implementation."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest


BASE = Path(__file__).resolve().parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


EXPORTER = load("git_exporter", BASE / "../python/source-bundle.py")
VERIFIER = load("git_verifier", BASE / "../python/verify-source-bundle.py")


class GitSelectedSources(unittest.TestCase):
    def fixture(self, root, bits=64):
        materials = root / "materials"
        materials.mkdir()
        components = []
        for name in ("git", "zlib", "curl", "openssl"):
            source, recipe = root / (name + " source"), root / (name + " recipe")
            source.mkdir()
            recipe.mkdir()
            (source / "COPYING").write_bytes(b"original license\x00\xff\n")
            (source / "last.c").write_bytes(name.encode() + b"\x00\xff source\n")
            (source / "link").symlink_to("last.c")
            (recipe / "package.nix").write_text(name + " integration\n")
            patches = []
            for index in range(2 if name in ("git", "curl") else 0):
                path = recipe / str(index) / "same.patch"
                path.parent.mkdir()
                path.write_text(f"{name} actual override {index}\n")
                patches.append(str(path))
            components.append(dict(name=name, sourcePath=str(source), sourceIdentity=source.name,
                                   recipeDirectory=str(recipe), patchPaths=patches))
        spec = dict(schemaVersion=1, addressBits=bits, maximumMemoryBytes=4294967296 if bits == 32 else 17179869184,
                    components=components, archiveTools={"exporter.py": str(BASE / "../python/source-bundle.py"),
                    "verifier.py": str(BASE / "../python/verify-source-bundle.py"), "LICENSE-MIT.txt": str(BASE / "../sdk/LICENSE.MIT")})
        build = {key: spec[key] for key in ("schemaVersion", "addressBits", "maximumMemoryBytes")}
        build.update(sourceIdentity=components[0]["sourceIdentity"], patches=["same.patch", "same.patch"],
                     dependencies=[dict(sourceIdentity=item["sourceIdentity"]) for item in components[1:]])
        (materials / "build.json").write_text(json.dumps(build))
        (materials / "package.nix").write_bytes((Path(components[0]["recipeDirectory"]) / "package.nix").read_bytes())
        (materials / "patches").mkdir()
        for index, path in enumerate(components[0]["patchPaths"]):
            (materials / "patches" / f"{index:03d}.patch").write_bytes(Path(path).read_bytes())
        (materials / "SHA256SUMS").write_text("".join(hashlib.sha256(path.read_bytes()).hexdigest() + "  " + str(path.relative_to(materials)) + "\n"
                                                     for path in sorted(materials.rglob("*")) if path.is_file()))
        path = root / "spec.json"
        path.write_text(json.dumps(spec))
        return path, materials, spec

    def test_both_widths_exact_members_tools_overrides_and_reproducibility(self):
        for bits in (32, 64):
            with self.subTest(bits=bits), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                spec, materials, inputs = self.fixture(root, bits)
                first, second = root / "first.tar.gz", root / "second.tar.gz"
                for output in (first, second):
                    EXPORTER.export(spec, materials, output, profile="git")
                    self.assertGreater(VERIFIER.verify(spec, materials, output, profile="git"), 40)
                self.assertEqual(first.read_bytes(), second.read_bytes())
                with tarfile.open(first) as archive:
                    for item in inputs["components"]:
                        name = item["name"]
                        self.assertEqual(archive.extractfile(f"sources/{name}/last.c").read(), (Path(item["sourcePath"]) / "last.c").read_bytes())
                        self.assertTrue(archive.getmember(f"sources/{name}/link").issym())
                        for index, path in enumerate(item["patchPaths"]):
                            self.assertEqual(archive.extractfile(f"patches/{name}/{index:03d}.patch").read(), Path(path).read_bytes())
                    for name, path in inputs["archiveTools"].items():
                        self.assertEqual(archive.extractfile("archive-tools/" + name).read(), Path(path).read_bytes())
                    index = archive.extractfile("selected-sources.json").read()
                    self.assertNotIn(directory.encode(), index)
                    self.assertEqual(json.loads(index)["addressBits"], bits)

    def test_invalid_selection_preserves_published_archive(self):
        for mode in ("profile", "missing", "order", "identity", "patch", "recipe", "platform", "tool", "tool-name"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                spec, materials, inputs = self.fixture(root)
                output = root / "published.tar.gz"
                output.write_bytes(b"previous publication")
                if mode == "missing":
                    inputs["components"].pop()
                elif mode == "order":
                    inputs["components"][1:3] = reversed(inputs["components"][1:3])
                elif mode == "identity":
                    inputs["components"][2]["sourceIdentity"] = "wrong"
                elif mode == "patch":
                    Path(inputs["components"][0]["patchPaths"][0]).write_text("changed patch")
                elif mode == "recipe":
                    (Path(inputs["components"][0]["recipeDirectory"]) / "package.nix").write_text("changed recipe")
                elif mode == "platform":
                    inputs["addressBits"] = 32
                elif mode == "tool":
                    inputs["archiveTools"]["exporter.py"] = str(root / "missing-tool")
                elif mode == "tool-name":
                    inputs["archiveTools"]["../escape"] = inputs["archiveTools"].pop("exporter.py")
                spec.write_text(json.dumps(inputs))
                with self.assertRaises((ValueError, FileNotFoundError)):
                    EXPORTER.export(spec, materials, output, profile="python" if mode == "profile" else "git")
                self.assertEqual(output.read_bytes(), b"previous publication")
                self.assertEqual(list(root.glob(".git-sources-*")), [])

    def test_full_verifier_rejects_deep_byte_corruption_extra_duplicate_and_truncation(self):
        for mode in ("deep-bytes", "extra", "duplicate", "truncated", "wrong-profile"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                spec, materials, _ = self.fixture(root)
                archive = root / "sources.tar.gz"
                EXPORTER.export(spec, materials, archive, profile="git")
                if mode == "truncated":
                    archive.write_bytes(archive.read_bytes()[:-8])
                elif mode != "wrong-profile":
                    changed = root / "changed.tar.gz"
                    with tarfile.open(archive) as source, tarfile.open(changed, "w:gz") as destination:
                        for member in source:
                            data = source.extractfile(member).read() if member.isfile() else None
                            if mode == "deep-bytes" and member.name == "sources/openssl/last.c":
                                data = b"X" + data[1:]
                            destination.addfile(member, io.BytesIO(data) if data is not None else None)
                            if mode == "duplicate" and member.name == "sources/openssl/last.c":
                                destination.addfile(member, io.BytesIO(data))
                        if mode == "extra":
                            member = tarfile.TarInfo("../outside")
                            destination.addfile(member)
                    archive = changed
                with self.assertRaises((ValueError, OSError, EOFError)):
                    VERIFIER.verify(spec, materials, archive, profile="python" if mode == "wrong-profile" else "git")
                self.assertFalse((root / "outside").exists())

    def test_actual_cli_requires_explicit_git_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spec, materials, _ = self.fixture(root)
            archive = root / "cli.tar.gz"
            commands = (BASE / "../python/source-bundle.py", BASE / "../python/verify-source-bundle.py")
            for path in commands:
                result = subprocess.run([sys.executable, "-B", str(path), "--profile", "git", str(spec), str(materials), str(archive)], capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
            default = subprocess.run([sys.executable, "-B", str(BASE / "../python/verify-source-bundle.py"), str(spec), str(materials), str(archive)], capture_output=True)
            self.assertNotEqual(default.returncode, 0)

    def test_archive_cannot_replace_a_standalone_tool_or_override_patch_input(self):
        for kind in ("tool", "patch"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                spec, materials, inputs = self.fixture(root)
                target = root / "standalone-input"
                if kind == "tool":
                    target.write_bytes(Path(inputs["archiveTools"]["exporter.py"]).read_bytes())
                    inputs["archiveTools"]["exporter.py"] = str(target)
                else:
                    target.write_bytes(Path(inputs["components"][0]["patchPaths"][0]).read_bytes())
                    inputs["components"][0]["patchPaths"][0] = str(target)
                original = target.read_bytes()
                spec.write_text(json.dumps(inputs))
                with self.assertRaisesRegex(ValueError, "outside all collected"):
                    EXPORTER.export(spec, materials, target, profile="git")
                self.assertEqual(target.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
