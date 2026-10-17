# SPDX-License-Identifier: MIT
from importlib.metadata import version
from importlib.resources import files
import sys


def main():
    assert version("linux-wasm-example") == "1.0.0"
    resource = files("sampleapp").joinpath("payload.txt").read_bytes()
    sys.stdout.buffer.write(resource + sys.stdin.buffer.read()[::-1])
