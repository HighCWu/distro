# SPDX-License-Identifier: MIT
import runpy
import struct
import unittest
from pathlib import Path

fixture = runpy.run_path(str(Path(__file__).with_name("make-erofs-read-error.py")))


class ReadErrorImage(unittest.TestCase):
    def test_directory_metadata(self):
        data = fixture["image"]()
        root = fixture["ROOT"] * 32
        size = struct.unpack_from("<I", data, root + 8)[0]
        directory = data[root + 32:root + 32 + size]
        entries = [struct.unpack_from("<QHBB", directory, i * 12) for i in range(5)]
        offsets = [entry[1] for entry in entries] + [len(directory)]
        names = [directory[offsets[i]:offsets[i + 1]] for i in range(5)]
        self.assertEqual(names, [b".", b"..", b"bad", b"good", b"partial"])
        self.assertEqual(offsets[0], 60)
        self.assertLess(root + 32 + size, fixture["BAD"] * 32)
        self.assertEqual([entry[0] for entry in entries], [36, 36, 40, 41, 42])

    def test_data_extents(self):
        data = fixture["image"]()
        page, block = fixture["PAGE"], fixture["BLOCK"]
        self.assertEqual(len(data), 2 * page)
        self.assertEqual(struct.unpack_from("<I", data, 1024)[0], 0xE0F5E1E2)
        self.assertEqual(struct.unpack_from("<I", data, 1060)[0] * block, len(data))
        for name, size, start in [("BAD", page, len(data)), ("GOOD", page, page),
                                  ("PARTIAL", 2 * page, page)]:
            inode = fixture[name] * 32
            self.assertEqual(struct.unpack_from("<H", data, inode)[0], 0)
            self.assertEqual(struct.unpack_from("<I", data, inode + 8)[0], size)
            self.assertEqual(struct.unpack_from("<I", data, inode + 16)[0] * block, start)
        self.assertEqual(data[page:], bytes((i * 37 + 11) & 255 for i in range(page)))


if __name__ == "__main__":
    unittest.main()
