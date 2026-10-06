#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Validate a fresh benchmark boot and extract its complete CSV to stdout."""

import csv
import re
import sys
from collections import defaultdict

HEADER = "mmap-bench,scenario,resident,holes_percent,threads,sample,operations_per_kind,mmap_ns,munmap_ns,elapsed_ns"


def extract(log, bits):
    configs = re.findall(
        r"^mmap-bench-config: pointer_bits=(\d+) page_bytes=(\d+) samples=3 batch=8 iterations=32$",
        log,
        re.MULTILINE,
    )
    if configs != [(str(bits), "65536")]:
        raise ValueError("missing, duplicate or unexpected benchmark profile")
    if log.splitlines().count("::vm-test::pass") != 1 or "::vm-test::fail" in log:
        raise ValueError("benchmark did not report an unambiguous pass")
    lines = [line for line in log.splitlines() if line.startswith("mmap-bench,")]
    if not lines or lines[0] != HEADER or len(lines) != 46:
        raise ValueError("expected one header and 45 sample rows")
    expected = {("scale", n, 0, 1): n for n in (16, 64, 256)}
    expected.update({("fragment", n, h, 1): n * h // 100 for n in (64, 256) for h in (0, 25, 50)})
    expected.update({("concurrent", n, 0, t): t * 32 * 8 for n in (16, 256) for t in (1, 2, 4)})
    samples = defaultdict(set)
    for row in csv.reader(lines[1:]):
        if len(row) != 10 or row[0] != "mmap-bench":
            raise ValueError("invalid row")
        resident, holes, threads, sample, ops, mmap_ns, munmap_ns, elapsed = map(int, row[2:])
        key = row[1], resident, holes, threads
        if key not in expected or ops != expected[key] or sample not in (1, 2, 3):
            raise ValueError("unexpected dimensions or operation count")
        if sample in samples[key] or min(mmap_ns, munmap_ns) < 0 or elapsed <= 0:
            raise ValueError("duplicate sample or invalid timing")
        if ops == 0 and (mmap_ns or munmap_ns):
            raise ValueError("zero-hole control performed operations")
        samples[key].add(sample)
    if set(samples) != set(expected) or any(value != {1, 2, 3} for value in samples.values()):
        raise ValueError("incomplete sample matrix")
    return "# SPDX-License-Identifier: MIT\n" + "\n".join(lines) + "\n"


if __name__ == "__main__":
    try:
        bits = int(sys.argv[1])
        if bits not in (32, 64):
            raise ValueError("pointer width must be 32 or 64")
        print(extract(sys.stdin.read(), bits), end="")
    except (ValueError, IndexError) as error:
        sys.exit(f"mmap benchmark: {error}")
