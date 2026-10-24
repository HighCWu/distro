#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Make deterministic source files/attributes before encoding the image."""
import os
import io
from pathlib import Path
import sys
import tarfile

binary = bytes([0, 1, 2, 0, 255, 127, 128])
payload = bytes((i * 37 + (i >> 8)) & 255 for i in range(131089))
attributes = {"user.binary": binary, "user.empty": b""}
if sys.argv[1] == "--tar":
    # The Nix builder filesystem need not implement user xattrs. Encode the
    # metadata in PAX rather than requiring privileged mounts or fake success.
    with tarfile.open(sys.argv[2], "w", format=tarfile.PAX_FORMAT) as archive:
        for name, kind, contents, attrs in (
            (".", tarfile.DIRTYPE, b"", {**attributes, "user.directory": b"dir"}),
            ("file", tarfile.REGTYPE, b"contents\n", attributes),
            ("link", tarfile.SYMTYPE, b"", {}),
            ("payload", tarfile.REGTYPE, payload, {}),
        ):
            info = tarfile.TarInfo(name)
            info.type, info.mode = kind, 0o755 if kind == tarfile.DIRTYPE else 0o644
            info.linkname = "file" if kind == tarfile.SYMTYPE else ""
            info.size = len(contents)
            # surrogateescape preserves arbitrary bytes, including 0xff and
            # embedded NUL, in the length-delimited SCHILY.xattr PAX record.
            info.pax_headers = {"SCHILY.xattr." + key: value.decode("utf-8", "surrogateescape")
                                for key, value in attrs.items()}
            archive.addfile(info, io.BytesIO(contents))
else:
    root = Path(sys.argv[1])
    root.mkdir()
    file = root / "file"
    file.write_bytes(b"contents\n")
    (root / "link").symlink_to("file")
    (root / "payload").write_bytes(payload)
    for inode in (root, file):
        for key, value in attributes.items():
            os.setxattr(inode, key, value)
    os.setxattr(root, "user.directory", b"dir")
