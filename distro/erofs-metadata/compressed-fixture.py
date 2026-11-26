#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Create deterministic data and verify the actual compressed EROFS extents."""
from pathlib import Path
import re
import sys

SIZE = 6 * 65536 + 173


def payload():
    data = bytearray(((i % 4096) * 37 + ((i % 4096) >> 8) * 17) & 255 for i in range(SIZE))
    # Distinct little-endian tags prevent a wrong repeated-page mapping from
    # passing while the rest remains compressible enough for large extents.
    for start in range(0, SIZE, 4096):
        data[start:start + 8] = (start // 4096).to_bytes(8, "little")
    return bytes(data)


if sys.argv[1] == "make":
    root = Path(sys.argv[2])
    root.mkdir()
    (root / "payload").write_bytes(payload())
elif sys.argv[1] == "check":
    report = Path(sys.argv[2]).read_text()
    assert re.search(r"Size:\s*393389\s+On-disk size:", report)
    assert re.search(r"Layout:\s*[13]\s+", report), "payload must use a compressed inode layout"
    extents = [tuple(map(int, match)) for match in re.findall(
        r"^\s*\d+:\s*(\d+)\.\.\s*(\d+)\s*\|\s*(\d+)\s*:\s*"
        r"(\d+)\.\.\s*(\d+)\s*\|\s*(\d+)\s*$", report, re.M)]
    assert extents, "dump.erofs did not report data extents"
    offset = 0
    crosses_pages = False
    for start, end, length, physical, physical_end, physical_length in extents:
        assert start == offset and end - start == length and length > 0
        assert physical_end - physical == physical_length and physical_length > 0
        crosses_pages |= length > 65536 and physical_length < length
        offset = end
    assert offset == SIZE and crosses_pages, "no compressed extent decompresses across 64KiB pages"
    assert (Path(sys.argv[3]) / "payload").read_bytes() == payload(), "extracted LZ4 bytes differ"
    print("erofs-compressed fixture: actual compressed layout, multi-page extent and exact extracted bytes pass")
else:
    raise SystemExit("expected make DIRECTORY or check EXTENT_REPORT EXTRACTED_DIRECTORY")
