# SPDX-License-Identifier: MIT
"""Build the standalone example without embedding a platform interpreter."""

from pathlib import Path
import sys
import zipfile


FILES = (
    "LICENSE",
    "__main__.py",
    "linux_wasm_example-1.0.0.dist-info/METADATA",
    "sampleapp/__init__.py",
    "sampleapp/cli.py",
    "sampleapp/payload.txt",
)


def build(destination, source):
    # Explicit membership excludes caches and local files. Fixed metadata also
    # works with Nix's epoch source mtimes, which predate ZIP's 1980 minimum.
    with zipfile.ZipFile(destination, "w") as archive:
        for name in FILES:
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, (source / name).read_bytes())


if __name__ == "__main__":
    assert len(sys.argv) == 2, "usage: build-example.py OUTPUT.pyz"
    build(Path(sys.argv[1]), Path(__file__).with_name("example"))
