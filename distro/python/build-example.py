# SPDX-License-Identifier: MIT
"""Build the standalone example without embedding a platform interpreter."""

from pathlib import Path
import os
import sys
import tempfile
import zipfile


FILES = (
    "LICENSE",
    "__main__.py",
    "linux_wasm_example-1.0.0.dist-info/METADATA",
    "sampleapp/__init__.py",
    "sampleapp/cli.py",
    "sampleapp/payload.txt",
)


def build(destination, source, files=FILES):
    destination = Path(destination)
    # Explicit membership excludes caches and local files. Fixed metadata also
    # works with Nix's epoch source mtimes, which predate ZIP's 1980 minimum.
    # Keep a previous bundle intact until the complete ZIP has been closed.
    # The same directory ensures replace does not cross filesystem boundaries.
    with tempfile.NamedTemporaryFile(
        dir=destination.parent, prefix=f".{destination.name}.", suffix=".tmp", delete=False,
    ) as staging:
        temporary = Path(staging.name)
    try:
        with zipfile.ZipFile(temporary, "w") as archive:
            for name in files:
                entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                entry.create_system = 3
                entry.external_attr = 0o100644 << 16
                entry.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(entry, (source / name).read_bytes())
        temporary.chmod(0o644)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    assert len(sys.argv) == 2, "usage: build-example.py OUTPUT.pyz"
    build(Path(sys.argv[1]), Path(__file__).with_name("example"))
