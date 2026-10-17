# SPDX-License-Identifier: MIT
"""Exercise a relocated pure-Python distribution, not pip or native extensions."""

import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import zipapp
import zipfile


def exercise_application():
    payload = b"\x00\x80\xffLinux/Wasm resource\x00"
    with tempfile.TemporaryDirectory(prefix="python-app-") as directory:
        root = Path(directory)
        source = root / "source"
        package = source / "sampleapp"
        package.mkdir(parents=True)
        (package / "__init__.py").write_text("", encoding="utf-8")
        (package / "payload.bin").write_bytes(payload)
        (package / "cli.py").write_text(
            "from importlib.metadata import version\n"
            "from importlib.resources import files\n"
            "import sys\n"
            "def main():\n"
            "    assert version('linux-wasm-sample') == '1.2.3'\n"
            "    resource = files('sampleapp').joinpath('payload.bin').read_bytes()\n"
            "    assert resource == " + repr(payload) + "\n"
            "    sys.stdout.buffer.write(resource + sys.stdin.buffer.read()[::-1])\n",
            encoding="utf-8",
        )
        metadata = source / "linux_wasm_sample-1.2.3.dist-info"
        metadata.mkdir()
        (metadata / "METADATA").write_text(
            "Metadata-Version: 2.1\nName: linux-wasm-sample\nVersion: 1.2.3\n",
            encoding="utf-8",
        )
        built = root / "application.pyz"
        zipapp.create_archive(source, built, main="sampleapp.cli:main", compressed=True)
        installed = root / "relocated"
        installed.mkdir()
        executable = installed / "application.pyz"
        shutil.move(built, executable)
        shutil.rmtree(source)
        # No source tree or inherited Python path may satisfy archive imports.
        environment = {
            name: value
            for name, value in os.environ.items()
            if not name.startswith("PYTHON")
        }
        incoming = bytes(range(256)) * 33 + b"\x00end\xff"
        result = subprocess.run(
            [sys.executable, str(executable)],
            input=incoming,
            capture_output=True,
            cwd=installed,
            env=environment,
            check=True,
        )
        assert result.stderr == b"", result.stderr
        assert result.stdout == payload + incoming[::-1], result.stdout
    print("Python application: relocated compressed archive, metadata, resources and binary pipes verified")


def exercise_published_example(archive):
    with tempfile.TemporaryDirectory(prefix="python-published-app-") as directory:
        installed = Path(directory) / "relocated.pyz"
        shutil.copyfile(archive, installed)
        with zipfile.ZipFile(installed) as bundle:
            assert "MIT License" in bundle.read("LICENSE").decode("utf-8")
            payload = bundle.read("sampleapp/payload.txt")
        incoming = bytes(range(256)) * 33 + b"\x00end\xff"
        result = subprocess.run(
            [sys.executable, str(installed)],
            input=incoming,
            capture_output=True,
            cwd=directory,
            env={name: value for name, value in os.environ.items()
                 if not name.startswith("PYTHON")},
            check=True,
        )
        assert result.stdout == payload + incoming[::-1], result.stdout
        assert result.stderr == b"", result.stderr
    print("Python application: published MIT zipapp, resources, metadata and binary pipes verified")


if __name__ == "__main__":
    assert sys.argv[1:] == [] or (len(sys.argv) == 3 and sys.argv[1] == "--example"), sys.argv
    exercise_application()
    if sys.argv[1:]:
        exercise_published_example(sys.argv[2])
