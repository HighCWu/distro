#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
from pathlib import Path
import os
import sys

root = Path(sys.argv[1]) / "zstd-fixture"
root.mkdir(parents=True)
data = bytes((i * 37 + (i >> 8) * 13 + (i >> 16) * 7) & 255 for i in range(4 * 65536 + 257))
(root / "payload.bin").write_bytes(data)
os.chmod(root / "payload.bin", 0o640)
(root / "executable").write_text("#!/bin/sh\nexit 0\n")
os.chmod(root / "executable", 0o751)
(root / "empty").mkdir(mode=0o750)
(root / "link").symlink_to("payload.bin")
