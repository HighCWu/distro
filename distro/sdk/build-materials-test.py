# SPDX-License-Identifier: MIT
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

loader = importlib.util.spec_from_file_location("sdk_materials", Path(__file__).with_name("build-materials.py"))
materials = importlib.util.module_from_spec(loader)
loader.loader.exec_module(materials)


class MaterialsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="sdk-materials-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.spec = {"schemaVersion": 1, "addressBits": 64, "targetTriple": "wasm64-unknown-linux-musl",
                     "maximumMemoryBytes": 17179869184, "files": {}, "trees": {}, "sources": {}}
        for name in materials.FILES:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(name + "\n")
            self.spec["files"][name] = str(path)
        for name in materials.TREES:
            path = self.root / name
            path.mkdir(parents=True)
            (path / "package.nix").write_text("# selected recipe\n")
            self.spec["trees"][name] = str(path)
        origins = {}
        for number, name in enumerate(materials.SOURCES):
            source = self.root / (str(number) * 32 + "-" + name)
            source.mkdir()
            self.spec["sources"][name] = str(source)
            origins[name] = {"hashParts": [str(number) * 16] * 2, "name": name}
        profile = {"schemaVersion": 1, "addressBits": 64, "targetTriple": self.spec["targetTriple"],
                   "linearMemory": {"maximumBytes": self.spec["maximumMemoryBytes"]},
                   "paths": {"compilerConfiguration": self.spec["files"]["configuration/compiler.cfg"],
                             "configSite": self.spec["files"]["installed/config.site"],
                             "licenseTexts": self.spec["trees"]["licenses"], "toolchain": str(self.root / "compiler")}}
        compiler_bin = self.root / "compiler/bin"
        compiler_bin.mkdir(parents=True)
        (compiler_bin / "clang++.cfg").symlink_to(self.spec["files"]["configuration/clang++.cfg"])
        Path(self.spec["files"]["installed/profile.json"]).write_text(json.dumps(profile))
        (Path(self.spec["trees"]["licenses"]) / "sources.json").write_text(json.dumps({
            "schemaVersion": 1, "sourceStoreIdentities": origins}))
        self.archive = self.root / "result/materials.tar.gz"

    def test_reproducible_archive_and_exact_verification(self):
        sdk = Path(self.spec["trees"]["recipes/sdk"])
        (sdk / ".hidden").write_bytes(b"binary\x00material\xff")
        (sdk / "link").symlink_to(".hidden")
        (sdk / "tool").write_text("#!/bin/sh\nexit 0\n")
        (sdk / "tool").chmod(0o755)
        materials.export(self.spec, self.archive)
        before = self.archive.read_bytes()
        self.assertGreater(materials.verify(self.spec, self.archive), len(materials.FILES))
        materials.export(self.spec, self.archive)
        self.assertEqual(before, self.archive.read_bytes())
        with tarfile.open(self.archive) as archive:
            self.assertTrue(archive.getmember("recipes/sdk/link").issym())
            self.assertEqual(archive.getmember("recipes/sdk/tool").mode, 0o755)
            self.assertEqual(archive.extractfile("installed/bin/wasm-linux-cc").read(),
                             Path(self.spec["files"]["installed/bin/wasm-linux-cc"]).read_bytes())

    def test_rejects_missing_or_empty_required_files_and_incomplete_sets(self):
        for group in ("files", "trees", "sources"):
            changed = copy.deepcopy(self.spec)
            changed[group].pop(next(iter(changed[group])))
            with self.assertRaises(ValueError):
                materials.export(changed, self.archive)
        Path(self.spec["files"]["installed/bin/wasm-linux-cc"]).write_bytes(b"")
        with self.assertRaises(ValueError):
            materials.export(self.spec, self.archive)
        self.assertFalse(self.archive.exists())

    def test_wasm32_installed_profile_round_trip(self):
        self.spec.update(addressBits=32, targetTriple="wasm32-unknown-linux-musl",
                         maximumMemoryBytes=4294967296)
        path = Path(self.spec["files"]["installed/profile.json"])
        profile = json.loads(path.read_text())
        profile.update(addressBits=32, targetTriple=self.spec["targetTriple"])
        profile["linearMemory"]["maximumBytes"] = self.spec["maximumMemoryBytes"]
        path.write_text(json.dumps(profile))
        materials.export(self.spec, self.archive)
        materials.verify(self.spec, self.archive)
        with tarfile.open(self.archive) as archive:
            identity = json.load(archive.extractfile("sdk-build-materials.json"))
        self.assertEqual(identity["addressBits"], 32)
        self.assertEqual(identity["maximumMemoryBytes"], 4294967296)
        self.assertEqual(identity["targetTriple"], self.spec["targetTriple"])

    def test_rejects_missing_reordered_and_retyped_members(self):
        sdk = Path(self.spec["trees"]["recipes/sdk"])
        (sdk / "link").symlink_to("package.nix")
        materials.export(self.spec, self.archive)
        with tarfile.open(self.archive) as archive:
            entries = [(member, archive.extractfile(member).read() if member.isfile() else None)
                       for member in archive.getmembers()]
        for mutation in ("missing", "reordered", "directory", "hardlink", "symlink", "metadata-size"):
            with self.subTest(mutation=mutation):
                changed = [(copy.copy(member), data) for member, data in entries]
                if mutation == "missing":
                    changed.pop(0)
                elif mutation == "reordered":
                    changed[0], changed[1] = changed[1], changed[0]
                elif mutation == "directory":
                    member = next(member for member, _ in changed if member.isdir())
                    member.type = tarfile.REGTYPE
                elif mutation == "hardlink":
                    member = next(member for member, _ in changed if member.isfile())
                    member.type = tarfile.LNKTYPE
                    member.linkname = "installed/profile.json"
                    member.size = 0
                elif mutation == "symlink":
                    member = next(member for member, _ in changed if member.issym())
                    member.linkname = "../unselected"
                else:
                    member, data = changed[-1]
                    changed[-1] = (member, data + b" ")
                    member.size += 1
                with tarfile.open(self.archive, "w:gz") as archive:
                    for member, data in changed:
                        archive.addfile(member, io.BytesIO(data) if data is not None else None)
                with self.assertRaises(ValueError):
                    materials.verify(self.spec, self.archive)

    def test_truncated_archive_is_not_verified(self):
        materials.export(self.spec, self.archive)
        data = self.archive.read_bytes()
        self.archive.write_bytes(data[:len(data) // 2])
        with self.assertRaises((tarfile.TarError, EOFError, OSError)):
            materials.verify(self.spec, self.archive)

    def test_rejects_wrong_platform_and_source_provenance(self):
        for key, value in (("addressBits", 32), ("targetTriple", "wrong"), ("maximumMemoryBytes", 42)):
            changed = copy.deepcopy(self.spec)
            changed[key] = value
            with self.assertRaises(ValueError):
                materials.export(changed, self.archive)
        changed = copy.deepcopy(self.spec)
        changed["sources"]["musl"] = changed["sources"]["linux"]
        with self.assertRaisesRegex(ValueError, "installed licenses"):
            materials.export(changed, self.archive)

    def test_independent_inputs_detect_changed_wrapper_recipe_and_identity(self):
        materials.export(self.spec, self.archive)
        for path in (Path(self.spec["files"]["installed/bin/wasm-linux-cc"]),
                     Path(self.spec["trees"]["recipes/sdk"]) / "package.nix"):
            original = path.read_bytes()
            path.write_bytes(original + b"# changed\n")
            with self.assertRaises(ValueError):
                materials.verify(self.spec, self.archive)
            path.write_bytes(original)
        with tarfile.open(self.archive) as archive:
            entries = [(member, archive.extractfile(member).read() if member.isfile() else None)
                       for member in archive.getmembers()]
        for mutation in ("extra", "duplicate", "identity", "mode"):
            with tarfile.open(self.archive, "w:gz") as archive:
                for number, (member, data) in enumerate(entries):
                    member = copy.copy(member)
                    if mutation == "identity" and member.name == "sdk-build-materials.json":
                        data = data.replace(b'"addressBits": 64', b'"addressBits": 32')
                    if mutation == "mode" and number == 0:
                        member.mode ^= 0o111
                    archive.addfile(member, io.BytesIO(data) if data is not None else None)
                if mutation in ("extra", "duplicate"):
                    member = tarfile.TarInfo(entries[0][0].name if mutation == "duplicate" else "unselected")
                    archive.addfile(member)
            with self.assertRaises(ValueError):
                materials.verify(self.spec, self.archive)

    def test_rejects_output_inside_inputs_and_preserves_previous_archive_on_failure(self):
        materials.export(self.spec, self.archive)
        previous = self.archive.read_bytes()
        with self.assertRaises(ValueError):
            materials.export(self.spec, Path(self.spec["trees"]["recipes/sdk"]) / "nested.tar.gz")
        nested_link = Path(self.spec["trees"]["recipes/sdk"]) / "linked-output.tar.gz"
        nested_link.symlink_to(self.archive)
        with self.assertRaises(ValueError):
            materials.export(self.spec, nested_link)
        self.assertTrue(nested_link.is_symlink())
        Path(self.spec["files"]["installed/bin/wasm-linux-c++"]).unlink()
        with self.assertRaises((ValueError, FileNotFoundError)):
            materials.export(self.spec, self.archive)
        self.assertEqual(previous, self.archive.read_bytes())

    def test_failed_write_removes_partial_archive_and_keeps_previous_bytes(self):
        materials.export(self.spec, self.archive)
        previous = self.archive.read_bytes()
        with patch.object(materials.tarfile.TarFile, "addfile", side_effect=OSError("write failure")):
            with self.assertRaisesRegex(OSError, "write failure"):
                materials.export(self.spec, self.archive)
        self.assertEqual(previous, self.archive.read_bytes())
        self.assertEqual(list(self.archive.parent.glob(".sdk-materials-*")), [])

    def test_rejects_special_files_without_following_source_symlinks(self):
        sdk = Path(self.spec["trees"]["recipes/sdk"])
        (sdk / "external-link").symlink_to("/not-a-collected-input")
        materials.export(self.spec, self.archive)
        materials.verify(self.spec, self.archive)
        os.mkfifo(sdk / "unsupported-fifo")
        with self.assertRaisesRegex(ValueError, "unsupported material entry"):
            materials.export(self.spec, self.archive)


if __name__ == "__main__":
    unittest.main()
