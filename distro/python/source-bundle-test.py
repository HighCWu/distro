# SPDX-License-Identifier: MIT
"""Small native fixtures exercise the real selected-source exporter."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch


MODULE = importlib.util.spec_from_file_location("source_bundle", Path(__file__).with_name("source-bundle.py"))
EXPORTER = importlib.util.module_from_spec(MODULE)
MODULE.loader.exec_module(EXPORTER)


class SelectedSources(unittest.TestCase):
    @staticmethod
    def checksums(materials):
        checksums = []
        for path in sorted(materials.rglob("*")):
            if path.is_file() and path.name != "SHA256SUMS":
                checksums.append(hashlib.sha256(path.read_bytes()).hexdigest() + "  " + str(path.relative_to(materials)))
        (materials / "SHA256SUMS").write_text("\n".join(checksums) + "\n")

    def fixture(self, root):
        materials = root / "materials"
        materials.mkdir()
        components = []
        for name in EXPORTER.NAMES:
            source, recipe = root / (name + " source"), root / (name + " recipe")
            source.mkdir()
            recipe.mkdir()
            (source / "LICENSE").write_text(name + " upstream license\n")
            (source / "code.c").write_bytes(name.encode() + b"\x00\xff\n")
            (source / "code-link.c").symlink_to("code.c")
            (recipe / "package.nix").write_text("# actual " + name + " integration\n")
            patches = []
            for number in range(2 if name in ("python", "xz") else 0):
                path = recipe / str(number) / "same.patch"
                path.parent.mkdir()
                path.write_text(f"{name} ordered patch {number}\n")
                patches.append(str(path))
            components.append({"name": name, "sourcePath": str(source), "sourceIdentity": source.name,
                               "recipeDirectory": str(recipe), "patchPaths": patches})
        spec = {"schemaVersion": 1, "addressBits": 64, "maximumMemoryBytes": 17179869184,
                "components": components}
        spec_path = root / "spec.json"
        spec_path.write_text(json.dumps(spec))
        build = {key: spec[key] for key in ("schemaVersion", "addressBits", "maximumMemoryBytes")}
        build.update(sourceIdentity=components[0]["sourceIdentity"],
                     dependencies=[{"sourceIdentity": item["sourceIdentity"]} for item in components[1:]],
                     patches=["same.patch", "same.patch"])
        (materials / "build.json").write_text(json.dumps(build))
        (materials / "package.nix").write_bytes((Path(components[0]["recipeDirectory"]) / "package.nix").read_bytes())
        (materials / "patches").mkdir()
        for number, path in enumerate(components[0]["patchPaths"]):
            (materials / "patches" / f"{number:03d}.patch").write_bytes(Path(path).read_bytes())
        for name in ("pyconfig.h", "LICENSE"):
            (materials / name).write_text("configured " + name + "\n")
        self.checksums(materials)
        return spec_path, materials, spec

    def test_exact_sources_recipes_ordered_patches_and_reproducibility(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spec, materials, inputs = self.fixture(root)
            source = Path(inputs["components"][0]["sourcePath"])
            os.link(source / "code.c", source / "hardlinked-code.c")
            # Reproduce content deduplication across separate Nix inputs.
            (materials / "package.nix").unlink()
            os.link(Path(inputs["components"][0]["recipeDirectory"]) / "package.nix", materials / "package.nix")
            original_patch = Path(inputs["components"][0]["patchPaths"][0])
            alias = root / "override patch symlink"
            alias.symlink_to(original_patch)
            inputs["components"][0]["patchPaths"][0] = str(alias)
            spec.write_text(json.dumps(inputs))
            outputs = [root / "first.tar.gz", root / "second.tar.gz"]
            for output in outputs:
                EXPORTER.export(spec, materials, output)
            self.assertEqual(outputs[0].read_bytes(), outputs[1].read_bytes())
            with tarfile.open(outputs[0]) as archive:
                for item in inputs["components"]:
                    name = item["name"]
                    for member in ("LICENSE", "code.c"):
                        self.assertEqual(archive.extractfile(f"sources/{name}/{member}").read(),
                                         (Path(item["sourcePath"]) / member).read_bytes())
                    self.assertTrue(archive.getmember(f"sources/{name}/code-link.c").issym())
                    self.assertEqual(archive.getmember(f"sources/{name}/code-link.c").linkname, "code.c")
                    self.assertEqual(archive.extractfile(f"recipes/{name}/package.nix").read(),
                                     (Path(item["recipeDirectory"]) / "package.nix").read_bytes())
                    for number, patch_path in enumerate(item["patchPaths"]):
                        self.assertTrue(archive.getmember(f"patches/{name}/{number:03d}.patch").isfile())
                        self.assertEqual(archive.extractfile(f"patches/{name}/{number:03d}.patch").read(),
                                         Path(patch_path).read_bytes())
                index_bytes = archive.extractfile("selected-sources.json").read()
                self.assertNotIn(directory.encode(), index_bytes)
                index = json.loads(index_bytes)
                self.assertEqual([item["name"] for item in index["components"]], list(EXPORTER.NAMES))
                self.assertEqual(index["components"][3]["patches"], ["patches/xz/000.patch", "patches/xz/001.patch"])
                self.assertIn("not complete corresponding source", index["scope"])
                for member in archive.getmembers():
                    self.assertEqual((member.uid, member.gid, member.mtime), (0, 0, 1))
                    self.assertFalse(member.islnk(), "regular files must be independently readable")

    def test_incomplete_or_mismatched_inputs_preserve_existing_output(self):
        for failure in ("missing-source", "missing-patch", "changed-patch", "changed-material", "wrong-order", "wrong-platform", "changed-recipe"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                spec_path, materials, spec = self.fixture(root)
                output = root / "archive.tar.gz"
                output.write_bytes(b"existing published archive")
                if failure == "missing-source":
                    spec["components"][2]["sourcePath"] += "-missing"
                elif failure == "missing-patch":
                    Path(spec["components"][3]["patchPaths"][1]).unlink()
                elif failure == "changed-patch":
                    Path(spec["components"][0]["patchPaths"][0]).write_text("different override")
                elif failure == "changed-material":
                    (materials / "pyconfig.h").write_text("tampered")
                elif failure == "wrong-order":
                    spec["components"][1:3] = reversed(spec["components"][1:3])
                elif failure == "wrong-platform":
                    spec["addressBits"] = 32
                else:
                    (Path(spec["components"][0]["recipeDirectory"]) / "package.nix").write_text("different recipe")
                spec_path.write_text(json.dumps(spec))
                with self.assertRaises((ValueError, subprocess.CalledProcessError)):
                    EXPORTER.export(spec_path, materials, output)
                self.assertEqual(output.read_bytes(), b"existing published archive")
                self.assertEqual(list(root.glob(".python-sources-*")), [])

    def test_both_pointer_widths_keep_their_own_declared_memory_bounds(self):
        for bits, limit in ((32, 4294967296), (64, 17179869184)):
            with self.subTest(bits=bits), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                spec_path, materials, spec = self.fixture(root)
                spec.update(addressBits=bits, maximumMemoryBytes=limit)
                spec_path.write_text(json.dumps(spec))
                build_path = materials / "build.json"
                build = json.loads(build_path.read_text())
                build.update(addressBits=bits, maximumMemoryBytes=limit)
                build_path.write_text(json.dumps(build))
                self.checksums(materials)
                output = root / "archive.tar.gz"
                EXPORTER.export(spec_path, materials, output)
                with tarfile.open(output) as archive:
                    index = json.load(archive.extractfile("selected-sources.json"))
                    self.assertEqual((index["addressBits"], index["maximumMemoryBytes"]), (bits, limit))

    def test_archive_write_and_publication_failures_clean_temporary_files(self):
        for method in ("write", "replace"):
            with self.subTest(method=method), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                spec, materials, _ = self.fixture(root)
                output = root / "archive.tar.gz"
                output.write_bytes(b"previous")
                target = "tarfile.TarFile.add" if method == "write" else "os.replace"
                with patch(target, side_effect=OSError("injected publication failure")):
                    with self.assertRaises(OSError):
                        EXPORTER.export(spec, materials, output)
                self.assertEqual(output.read_bytes(), b"previous")
                self.assertEqual(list(root.glob(".python-sources-*")), [])

    def test_output_inside_inputs_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spec, materials, inputs = self.fixture(root)
            for tree in (materials, Path(inputs["components"][0]["sourcePath"]), Path(inputs["components"][0]["recipeDirectory"])):
                output = tree / "recursive.tar.gz"
                with self.assertRaisesRegex(ValueError, "outside all collected"):
                    EXPORTER.export(spec, materials, output)
                self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
