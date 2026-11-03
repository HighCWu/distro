#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Reject optimized consumers which no longer exercise OOM or large TLS."""

import re
import subprocess
import sys

report = subprocess.check_output(
    [sys.argv[1], "--sections", "--symbols", sys.argv[2]], text=True
)
symbols = report.split("Symbol {")[1:]
for name in ("malloc", "pthread_create"):
    if not any(re.search(r"Name: " + name + r"\s", item) for item in symbols):
        raise SystemExit(f"brk consumer lost its real {name} reference")
tls = [item for item in symbols if re.search(r"Name: tls_probe\s", item)]
if len(tls) != 1 or not re.search(r"Size: (?:0x2000|8192)\s", tls[0]):
    raise SystemExit("brk consumer must retain the complete 8192-byte TLS object")
if not re.search(r"Name: \.tbss\.tls_probe\s", report):
    raise SystemExit("brk consumer array must use actual thread-local storage")
print(
    "brk consumer: real malloc/thread references and full 8192-byte TLS object retained"
)
