#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Build and inspect a deterministic, compressed SquashFS Zstandard image."""
from pathlib import Path
import struct
import sys

SIZE = 6 * 65536 + 173
SQUASHFS_MAGIC = 0x73717368
SQUASHFS_COMPRESSION_ZSTD = 6
BLOCK_SIZE = 262144


def payload():
    data = bytearray(((i % 4096) * 37 + ((i % 4096) >> 8) * 17) & 255 for i in range(SIZE))
    for start in range(0, SIZE, 4096):
        data[start:start + 8] = (start // 4096).to_bytes(8, "little")
    return bytes(data)


def check(image_path, superblock_path, extracted_directory):
    image = Path(image_path).read_bytes()
    assert len(image) >= 96, "SquashFS superblock is truncated"
    magic, = struct.unpack_from("<I", image, 0)
    block_size, = struct.unpack_from("<I", image, 12)
    compression, = struct.unpack_from("<H", image, 20)
    assert magic == SQUASHFS_MAGIC, f"unexpected SquashFS magic: {magic:#x}"
    assert compression == SQUASHFS_COMPRESSION_ZSTD, (
        f"superblock compression id is {compression}, expected Zstandard id "
        f"{SQUASHFS_COMPRESSION_ZSTD}"
    )
    assert block_size == BLOCK_SIZE, f"unexpected SquashFS block size: {block_size}"
    assert len(image) < SIZE, "fixture payload was not compressed"

    report = Path(superblock_path).read_text()
    assert "Compression zstd" in report, "unsquashfs does not report Zstandard compression"
    assert f"Block size {BLOCK_SIZE}" in report, "unsquashfs reports the wrong block size"
    actual = Path(extracted_directory, "payload").read_bytes()
    assert len(actual) == SIZE and actual == payload(), "extracted payload differs byte-for-byte"


if len(sys.argv) == 3 and sys.argv[1] == "make":
    root = Path(sys.argv[2])
    root.mkdir()
    (root / "payload").write_bytes(payload())
elif len(sys.argv) == 5 and sys.argv[1] == "check":
    check(sys.argv[2], sys.argv[3], sys.argv[4])
    print("squashfs-zstd fixture: superblock Zstandard marker, 256 KiB block and exact compressed payload pass")
else:
    raise SystemExit("expected make DIRECTORY or check IMAGE SUPERBLOCK_REPORT EXTRACTED_DIRECTORY")
