#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Build and inspect a deterministic, compressed SquashFS Zstandard image."""
from pathlib import Path
import os
import struct
import sys

SIZE = 6 * 65536 + 173
SQUASHFS_MAGIC = 0x73717368
SQUASHFS_COMPRESSION_IDS = {"xz": 4, "zstd": 6}
COMPRESSION_LABELS = {"xz": "XZ", "zstd": "Zstandard"}
BLOCK_SIZE = 262144
XATTR_NAME = "user.squashfs-test"
XATTR_VALUE = b"squashfs-xattr-fixture-v1"


def payload():
    data = bytearray(((i % 4096) * 37 + ((i % 4096) >> 8) * 17) & 255 for i in range(SIZE))
    for start in range(0, SIZE, 4096):
        data[start:start + 8] = (start // 4096).to_bytes(8, "little")
    return bytes(data)


def check(image_path, superblock_path, extracted_directory, compression, xattrs=False):
    assert compression in SQUASHFS_COMPRESSION_IDS, f"unsupported compression: {compression}"
    image = Path(image_path).read_bytes()
    assert len(image) >= 96, "SquashFS superblock is truncated"
    magic, = struct.unpack_from("<I", image, 0)
    block_size, = struct.unpack_from("<I", image, 12)
    compression_id, = struct.unpack_from("<H", image, 20)
    assert magic == SQUASHFS_MAGIC, f"unexpected SquashFS magic: {magic:#x}"
    expected_compression_id = SQUASHFS_COMPRESSION_IDS[compression]
    assert compression_id == expected_compression_id, (
        f"superblock compression id is {compression_id}, expected {COMPRESSION_LABELS[compression]} id "
        f"{expected_compression_id}"
    )
    assert block_size == BLOCK_SIZE, f"unexpected SquashFS block size: {block_size}"
    assert len(image) < SIZE, "fixture payload was not compressed"

    report = Path(superblock_path).read_text()
    assert f"Compression {compression}" in report, f"unsquashfs does not report {compression} compression"
    assert f"Block size {BLOCK_SIZE}" in report, "unsquashfs reports the wrong block size"
    extracted_payload = Path(extracted_directory, "payload")
    actual = extracted_payload.read_bytes()
    assert len(actual) == SIZE and actual == payload(), "extracted payload differs byte-for-byte"
    if xattrs:
        assert os.getxattr(extracted_payload, XATTR_NAME) == XATTR_VALUE, "extracted xattr differs"
        assert XATTR_NAME in os.listxattr(extracted_payload), "extracted xattr is absent from list"


if sys.argv[1:2] == ["make"] and len(sys.argv) in (3, 4):
    with_xattrs = len(sys.argv) == 4 and sys.argv[3] == "xattrs"
    assert len(sys.argv) == 3 or with_xattrs, "expected optional xattrs mode"
    root = Path(sys.argv[2])
    root.mkdir()
    target = root / "payload"
    target.write_bytes(payload())
    if with_xattrs:
        os.setxattr(target, XATTR_NAME, XATTR_VALUE)
elif sys.argv[1:2] == ["check"] and len(sys.argv) in (5, 6, 7):
    expected_compression = sys.argv[5] if len(sys.argv) >= 6 else "zstd"
    with_xattrs = len(sys.argv) == 7 and sys.argv[6] == "xattrs"
    assert len(sys.argv) != 7 or with_xattrs, "expected optional xattrs mode"
    check(sys.argv[2], sys.argv[3], sys.argv[4], expected_compression, with_xattrs)
    marker = (
        f"squashfs-{expected_compression} fixture: superblock {COMPRESSION_LABELS[expected_compression]} marker, "
        "256 KiB block and exact compressed payload pass"
    )
    if with_xattrs:
        marker = marker.removesuffix(" pass") + ", xattrs pass"
    print(marker)
else:
    raise SystemExit(
        "expected make DIRECTORY [xattrs] or check IMAGE SUPERBLOCK_REPORT EXTRACTED_DIRECTORY [zstd|xz] [xattrs]"
    )
