#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Check the small plain fixture really selects inline/shared xattr storage."""
from pathlib import Path
import struct
import sys

data = Path(sys.argv[1]).read_bytes()
shared = sys.argv[2] == "shared"
assert sys.argv[2] in ("inline", "shared")
sb = 1024
assert struct.unpack_from("<I", data, sb)[0] == 0xE0F5E1E2
block_bits = data[sb + 12]
assert 9 <= block_bits <= 16
assert not struct.unpack_from("<I", data, sb + 80)[0] & 0x180, "fixture must not use 48-bit/metabox layout"
root_nid = struct.unpack_from("<H", data, sb + 14)[0]
metadata_block, xattr_block = struct.unpack_from("<II", data, sb + 40)
inode = (metadata_block << block_bits) + root_nid * 32
format_, xattr_count = struct.unpack_from("<HH", data, inode)
assert xattr_count > 0, "fixture root must contain its directory attribute"
inode_size = 64 if format_ & 1 else 32
shared_count = data[inode + inode_size + 4]
assert bool(shared_count) == shared, "root xattr storage does not match selected fixture"
if shared:
    # A small image can place shared entries in filesystem block zero too.
    for i in range(shared_count):
        index = struct.unpack_from("<I", data, inode + inode_size + 12 + i * 4)[0]
        entry = (xattr_block << block_bits) + index * 4
        assert entry + 4 <= len(data), "shared xattr entry outside fixture"
print("EROFS fixture confirmed: " + sys.argv[2] + " xattr storage")
