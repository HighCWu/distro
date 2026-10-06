# SPDX-License-Identifier: MIT
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "benchmark", Path(__file__).with_name("validate-mmap-benchmark.py")
)
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)


def fixture(bits=32):
    cases = [("scale", n, 0, 1, n) for n in (16, 64, 256)]
    cases += [("fragment", n, h, 1, n * h // 100) for n in (64, 256) for h in (0, 25, 50)]
    cases += [("concurrent", n, 0, t, t * 32 * 8) for n in (16, 256) for t in (1, 2, 4)]
    lines = [
        f"mmap-bench-config: pointer_bits={bits} page_bytes=65536 samples=3 batch=8 iterations=32",
        benchmark.HEADER,
    ]
    for scenario, resident, holes, threads, ops in cases:
        for sample in (1, 2, 3):
            lines.append(
                f"mmap-bench,{scenario},{resident},{holes},{threads},{sample},{ops},{ops * 10},{ops * 5},100"
            )
    return "\n".join(lines + ["::vm-test::pass"]) + "\n"


class BenchmarkValidation(unittest.TestCase):
    def test_profiles(self):
        for bits in (32, 64):
            self.assertEqual(len(benchmark.extract(fixture(bits), bits).splitlines()), 46)

    def test_invalid_results(self):
        valid = fixture()
        bad_logs = [
            valid.replace("pointer_bits=32", "pointer_bits=64"),
            valid.replace("page_bytes=65536", "page_bytes=4096"),
            valid.replace("::vm-test::pass", "::vm-test::fail: incorrect mapping"),
            valid.replace("::vm-test::pass", ""),
            valid + "::vm-test::pass\n",
            valid.replace("mmap-bench,scale,16,0,1,1,16,160,80,100\n", ""),
            valid.replace("scale,16,0,1,2", "scale,16,0,1,1"),
            valid.replace("scale,16,0,1,1,16", "scale,16,0,1,1,17"),
            valid.replace("16,160,80,100", "16,-1,80,100"),
            valid.replace("16,160,80,100", "16,160,80,0"),
            valid.replace("fragment,64,0,1,1,0,0,0,100", "fragment,64,0,1,1,0,1,0,100"),
        ]
        for log in bad_logs:
            with self.subTest(log=log), self.assertRaises(ValueError):
                benchmark.extract(log, 32)


if __name__ == "__main__":
    unittest.main()
