# SPDX-License-Identifier: MIT
"""Build a deliberately narrow EROFS fixture, not a general filesystem writer.

Compact inodes, no xattrs/compression/checksum/48-bit features. Metadata and
`good` are in range; `bad` names a full page beyond the declared device capacity.
`partial` has one valid page followed by one out-of-range page.
The format is the published EROFS disk ABI, not a kernel implementation import.
"""
import struct
import sys
from pathlib import Path

PAGE = 65536
BLOCK = 4096
ROOT, BAD, GOOD, PARTIAL = 36, 40, 41, 42


def image():
    result = bytearray(2 * PAGE)
    # Superblock: magic, no checksum/features, 4KiB blocks, compact root nid.
    struct.pack_into("<IIIBBH", result, 1024, 0xE0F5E1E2, 0, 0, 12, 0, ROOT)
    struct.pack_into("<Q", result, 1024 + 16, 4)  # inode count
    struct.pack_into("<I", result, 1024 + 36, len(result) // BLOCK)

    def inode(nid, layout, mode, links, size, start):
        struct.pack_into("<HHHHIIIIHHI", result, nid * 32,
                         layout << 1, 0, mode, links, size, 0, start, nid, 0, 0, 0)

    entries = [(ROOT, b".", 2), (ROOT, b"..", 2), (BAD, b"bad", 1),
               (GOOD, b"good", 1), (PARTIAL, b"partial", 1)]
    directory = bytearray(12 * len(entries))
    for index, (nid, name, kind) in enumerate(entries):
        struct.pack_into("<QHBB", directory, index * 12, nid, len(directory), kind, 0)
        directory.extend(name)
    inode(ROOT, 2, 0o40755, 2, len(directory), 0)
    start = ROOT * 32 + 32
    result[start:start + len(directory)] = directory
    inode(BAD, 0, 0o100644, 1, PAGE, len(result) // BLOCK)
    inode(GOOD, 0, 0o100644, 1, PAGE, PAGE // BLOCK)
    inode(PARTIAL, 0, 0o100644, 1, 2 * PAGE, PAGE // BLOCK)
    result[PAGE:] = bytes((i * 37 + 11) & 255 for i in range(PAGE))
    return result


if __name__ == "__main__":
    Path(sys.argv[1]).write_bytes(image())
