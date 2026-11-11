#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Small structural tests for write-import-stub.py."""

from pathlib import Path
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("write-import-stub.py")
WRAPPER = Path(__file__).with_name("write-import-stub.sh")
WASM_HEADER = b"\x00asm\x01\x00\x00\x00"


def u32_leb(value):
    encoded = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            encoded.append(byte | 0x80)
        else:
            encoded.append(byte)
            return bytes(encoded)


def section(section_id, payload):
    return bytes((section_id,)) + u32_leb(len(payload)) + payload


def wasm_module(exports):
    export_payload = bytearray(u32_leb(len(exports)))
    for name, kind, index in exports:
        encoded_name = name.encode("utf-8") if isinstance(name, str) else name
        export_payload.extend(u32_leb(len(encoded_name)))
        export_payload.extend(encoded_name)
        export_payload.append(kind)
        export_payload.extend(u32_leb(index))

    return b"".join(
        (
            WASM_HEADER,
            section(1, b"\x01\x60\x00\x00"),  # One () -> () function type.
            section(3, b"\x01\x00"),  # One function of type 0.
            section(4, b"\x01\x70\x00\x00"),  # One empty funcref table.
            section(5, b"\x01\x00\x01"),  # One-page memory.
            section(6, b"\x01\x7f\x00\x41\x00\x0b"),  # Immutable i32 global.
            section(7, bytes(export_payload)),
            section(10, b"\x01\x02\x00\x0b"),  # One empty function body.
        )
    )


class WriteImportStubTests(unittest.TestCase):
    def run_helper(self, *arguments):
        installed_helper = os.environ.get("SDK_IMPORT_STUB")
        command = (
            [installed_helper, *map(str, arguments)]
            if installed_helper
            else [sys.executable, str(SCRIPT), *map(str, arguments)]
        )
        return subprocess.run(
            command,
            check=False,
            capture_output=True,
        )

    def test_shell_wrapper_forwards_arguments(self):
        with tempfile.TemporaryDirectory(prefix="write-import-stub wrapper ") as temporary:
            directory = Path(temporary)
            provider = directory / "provider module.wasm"
            output = directory / "provider symbols.stub"
            provider.write_bytes(wasm_module([("provider_fn", 0, 0)]))
            wrapper = WRAPPER.read_text(encoding="utf-8")
            wrapper = wrapper.replace("@python@", shlex.quote(sys.executable)).replace(
                "@helper@", shlex.quote(str(SCRIPT))
            )
            result = subprocess.run(
                ["bash", "-c", wrapper, "write-import-stub", str(provider), "-o", str(output)],
                check=False,
                capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", errors="replace"))
            self.assertEqual(output.read_bytes(), b"#STUB\nprovider_fn\n")

    def test_merges_sorted_function_exports_only(self):
        with tempfile.TemporaryDirectory(prefix="write-import-stub-") as temporary:
            directory = Path(temporary)
            first = directory / "first.wasm"
            second = directory / "second.wasm"
            first.write_bytes(
                wasm_module(
                    [
                        ("zeta", 0, 0),
                        ("table,not-a-symbol", 1, 0),
                        ("memory:also-not-a-symbol", 2, 0),
                        ("global\nnot-a-symbol", 3, 0),
                    ]
                )
            )
            second.write_bytes(wasm_module([("shared", 0, 0), ("alpha", 0, 0), ("zeta", 0, 0), ("λ", 0, 0)]))

            result = self.run_helper(first, second)

        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", errors="replace"))
        self.assertEqual(result.stdout, "#STUB\nalpha\nshared\nzeta\nλ\n".encode("utf-8"))

    def test_rejects_truncated_section_leb(self):
        with tempfile.TemporaryDirectory(prefix="write-import-stub-") as temporary:
            provider = Path(temporary) / "truncated.wasm"
            provider.write_bytes(WASM_HEADER + b"\x07\x80")
            result = self.run_helper(provider)

        self.assertEqual(result.returncode, 2)
        self.assertIn(b"section size exceeds", result.stderr)

    def test_rejects_u32_leb_overflow(self):
        with tempfile.TemporaryDirectory(prefix="write-import-stub-") as temporary:
            provider = Path(temporary) / "overflow.wasm"
            provider.write_bytes(WASM_HEADER + b"\x07\x80\x80\x80\x80\x10")
            result = self.run_helper(provider)

        self.assertEqual(result.returncode, 2)
        self.assertIn(b"section size overflows u32", result.stderr)

    def test_rejects_bad_function_export_names(self):
        cases = (
            (b"bad:name", "not representable"),
            (b"bad,name", "not representable"),
            (b"bad\xff", "UTF-8"),
        )
        with tempfile.TemporaryDirectory(prefix="write-import-stub-") as temporary:
            directory = Path(temporary)
            for index, (name, expected_error) in enumerate(cases):
                with self.subTest(name=name):
                    provider = directory / f"bad-{index}.wasm"
                    provider.write_bytes(wasm_module([(name, 0, 0)]))
                    result = self.run_helper(provider)
                    self.assertEqual(result.returncode, 2)
                    self.assertIn(expected_error.encode(), result.stderr)

    def test_rejects_unsupported_version(self):
        with tempfile.TemporaryDirectory(prefix="write-import-stub-") as temporary:
            provider = Path(temporary) / "version.wasm"
            provider.write_bytes(b"\x00asm\x02\x00\x00\x00")
            result = self.run_helper(provider)

        self.assertEqual(result.returncode, 2)
        self.assertIn(b"version 1", result.stderr)

    @unittest.skipUnless(
        os.environ.get("SDK_CC") and os.environ.get("SDK_LD") and os.environ.get("SDK_IMPORT_STUB"),
        "SKIPPED real 32/64 SDK link and Node-call check: set SDK_CC, SDK_LD, and SDK_IMPORT_STUB",
    )
    def test_sdk_provider_stub_links_and_calls_for_wasm32_and_wasm64(self):
        compiler = shlex.split(os.environ["SDK_CC"])
        linker = shlex.split(os.environ["SDK_LD"])
        stub_tool = os.environ["SDK_IMPORT_STUB"]
        self.assertTrue(compiler, "SDK_CC must name the SDK Clang driver")
        self.assertTrue(linker, "SDK_LD must name the SDK wasm-ld")
        node = shutil.which(os.environ.get("NODE", "node"))
        self.assertIsNotNone(node, "Node.js is required for the SDK Wasm execution check")

        node_harness = r"""
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const providerModule = new WebAssembly.Module(readFileSync(process.argv[2]));
const consumerModule = new WebAssembly.Module(readFileSync(process.argv[3]));
const provider = new WebAssembly.Instance(providerModule, {});
assert.equal(provider.exports.provider_value(), 73);

const imports = WebAssembly.Module.imports(consumerModule);
assert.deepEqual(imports, [{ module: "env", name: "provider_value", kind: "function" }]);
const consumer = new WebAssembly.Instance(consumerModule, {
  env: { provider_value: provider.exports.provider_value },
});
assert.equal(consumer.exports.consumer_call(), 73);
"""

        with tempfile.TemporaryDirectory(prefix="write-import-stub-sdk-") as temporary:
            directory = Path(temporary)
            provider_source = directory / "provider.c"
            consumer_source = directory / "consumer.c"
            missing_source = directory / "consumer-missing.c"
            provider_source.write_text("int provider_value(void) { return 73; }\n", encoding="utf-8")
            consumer_source.write_text(
                "extern int provider_value(void);\n"
                "int consumer_call(void) { return provider_value(); }\n",
                encoding="utf-8",
            )
            missing_source.write_text(
                "extern int provider_value(void);\n"
                "extern int missing_value(void);\n"
                "int consumer_call(void) { return provider_value() + missing_value(); }\n",
                encoding="utf-8",
            )
            harness = directory / "run-provider.mjs"
            harness.write_text(node_harness, encoding="utf-8")

            def run_checked(command, label):
                result = subprocess.run(command, cwd=directory, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, f"{label}: {result.stderr}")
                return result

            for bits in (32, 64):
                with self.subTest(wasm_bits=bits):
                    target = f"wasm{bits}-unknown-unknown"
                    run_checked(
                        [
                            *compiler,
                            f"--target={target}",
                            "-ffreestanding",
                            "-fno-builtin",
                            "-O2",
                            "-c",
                            str(provider_source),
                            "-o",
                            "provider.o",
                        ],
                        f"compile wasm{bits} provider",
                    )
                    run_checked(
                        [
                            *linker,
                            f"-mwasm{bits}",
                            "--no-entry",
                            "--export=provider_value",
                            "--unresolved-symbols=report-all",
                            "provider.o",
                            "-o",
                            "provider.wasm",
                        ],
                        f"link wasm{bits} provider",
                    )
                    run_checked(
                        [
                            stub_tool,
                            "provider.wasm",
                            "-o",
                            "provider.stub",
                        ],
                        f"write wasm{bits} provider stub",
                    )
                    run_checked(
                        [
                            *compiler,
                            f"--target={target}",
                            "-ffreestanding",
                            "-fno-builtin",
                            "-O2",
                            "-c",
                            str(consumer_source),
                            "-o",
                            "consumer.o",
                        ],
                        f"compile wasm{bits} consumer",
                    )
                    run_checked(
                        [
                            *linker,
                            f"-mwasm{bits}",
                            "--no-entry",
                            "--export=consumer_call",
                            "--unresolved-symbols=report-all",
                            "consumer.o",
                            "provider.stub",
                            "-o",
                            "consumer.wasm",
                        ],
                        f"link wasm{bits} consumer with provider stub",
                    )
                    run_checked(
                        [node, str(harness), "provider.wasm", "consumer.wasm"],
                        f"run wasm{bits} provider and consumer in Node",
                    )

                    run_checked(
                        [
                            *compiler,
                            f"--target={target}",
                            "-ffreestanding",
                            "-fno-builtin",
                            "-O2",
                            "-c",
                            str(missing_source),
                            "-o",
                            "consumer-missing.o",
                        ],
                        f"compile wasm{bits} consumer with missing import",
                    )
                    missing_link = subprocess.run(
                        [
                            *linker,
                            f"-mwasm{bits}",
                            "--no-entry",
                            "--export=consumer_call",
                            "--unresolved-symbols=report-all",
                            "consumer-missing.o",
                            "provider.stub",
                            "-o",
                            "consumer-missing.wasm",
                        ],
                        cwd=directory,
                        capture_output=True,
                        text=True,
                    )
                    self.assertNotEqual(missing_link.returncode, 0, "unlisted function import linked")
                    self.assertIn("undefined symbol: missing_value", missing_link.stderr)
                    self.assertNotIn("undefined symbol: provider_value", missing_link.stderr)


if __name__ == "__main__":
    unittest.main()
