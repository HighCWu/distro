#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Unpack the deterministic shared-xattr fixture without host xattr support.

Regenerate on a filesystem with user xattrs:
  umask 022
  python3 make-fixture.py root
  mkfs.erofs --all-root -T 0 -U 00000000-0000-0000-0000-000000000000 -x0 image root
The reference image was encoded by erofs-utils 1.7.1. It is uncompressed EROFS;
gzip here is only storage encoding for this MIT-owned test data, not a kernel
compression feature. Both layouts still go through fsck and on-disk checks.
"""
import base64
import gzip
import hashlib
from pathlib import Path
import sys

DATA = """
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
AgA=
"""
image = gzip.decompress(base64.b64decode(DATA))
assert hashlib.sha256(image).hexdigest() == "7b8a6962bc7119037acd196df26cfe521e4165ee90556d83e033a937cfbe0638"
Path(sys.argv[1]).write_bytes(image)
