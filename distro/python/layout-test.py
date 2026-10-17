# SPDX-License-Identifier: MIT
"""Synthetic configuration fixtures; target checks query actual sysconfig."""

import contextlib
import io
import unittest

from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

spec = spec_from_file_location("python_abi_fixture", Path(__file__).with_name("abi-test.py"))
fixture = module_from_spec(spec)
spec.loader.exec_module(fixture)


class LayoutTests(unittest.TestCase):
    def setUp(self):
        self.paths = {
            "stdlib": "/usr/lib/python3.13",
            "platstdlib": "/usr/lib/python3.13",
            "purelib": "/usr/lib/python3.13/site-packages",
            "platlib": "/usr/lib/python3.13/site-packages",
            "include": "/usr/include/python3.13",
            "platinclude": "/usr/include/python3.13",
            "scripts": "/usr/bin",
            "data": "/usr",
        }
        self.config = {
            "prefix": "/usr",
            "exec_prefix": "/usr",
            "CC": "wasm64-unknown-linux-musl-cc",
            "CXX": "wasm64-unknown-linux-musl-c++",
            "AR": "llvm-ar",
            "CFLAGS": "-O2 -pthread",
            "CPPFLAGS": "-I/usr/include",
            "LDFLAGS": "-L/usr/lib",
            "LIBS": "-ldl -lm",
            # Provenance is not a runnable path or an installed search path.
            "CONFIG_ARGS": "--with-build-python=/nix/store/native-python/bin/python3",
        }

    def invoke(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            fixture.check_installed_layout(self.paths, self.config)
        return output.getvalue()

    def test_fhs_paths_and_flags(self):
        self.assertIn("Python layout:", self.invoke())

    def test_wrong_installed_paths(self):
        for name in self.paths:
            with self.subTest(name=name):
                original = self.paths[name]
                self.paths[name] = "/nix/store/build-output" + original
                with self.assertRaises(AssertionError):
                    self.invoke()
                self.paths[name] = original

    def test_missing_installed_path(self):
        del self.paths["include"]
        with self.assertRaises(AssertionError):
            self.invoke()

    def test_operational_flags_cannot_leak_nix_store(self):
        for name in ("CC", "CXX", "AR", "CFLAGS", "CPPFLAGS", "LDFLAGS", "LIBS"):
            with self.subTest(name=name):
                original = self.config[name]
                self.config[name] += " /nix/store/foreign-build/include"
                with self.assertRaises(AssertionError):
                    self.invoke()
                self.config[name] = original

    def test_missing_operational_field(self):
        del self.config["CC"]
        with self.assertRaises(AssertionError):
            self.invoke()

    def test_build_prefix_cannot_be_runtime_prefix(self):
        for name in ("prefix", "exec_prefix"):
            with self.subTest(name=name):
                self.config[name] = "/nix/store/python"
                with self.assertRaises(AssertionError):
                    self.invoke()
                self.config[name] = "/usr"


if __name__ == "__main__":
    unittest.main()
