# SPDX-License-Identifier: MIT
"""Replay the patched subprocess module on native POSIX, not the Wasm libc."""

import builtins
import importlib.util
from pathlib import Path
import sys
from unittest.mock import patch


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main(subprocess_source, fixtures):
    assert sys.version_info >= (3, 13), "native replay requires Python 3.13+ (posix_spawn env=None)"
    original_import = builtins.__import__

    def without_fork_exec(name, *args, **kwargs):
        if name == "_posixsubprocess":
            raise ImportError("intentionally unavailable for fork-less replay")
        return original_import(name, *args, **kwargs)

    with patch.object(builtins, "__import__", without_fork_exec):
        subprocess = load_module("forkless_subprocess", subprocess_source)
    assert subprocess._HAVE_FORK_EXEC is False
    assert subprocess._fork_exec is None
    assert subprocess._USE_POSIX_SPAWN is True

    errors = load_module("forkless_spawn_errors", fixtures / "spawn-errors-test.py")
    errors.subprocess = subprocess
    errors.check_errors(errors.subprocess_launch)
    errors.check_failed_launch_cleanup()
    # Do not replay musl's error-pipe fd exhaustion on glibc: its spawn backend
    # does not need that pipe. The installed target suite retains that check.

    lifecycle = load_module("forkless_lifecycle", fixtures / "process-lifecycle-test.py")
    lifecycle.subprocess = subprocess
    lifecycle.exercise_lifecycle()
    lifecycle.exercise_backpressure()
    terminal = load_module("forkless_pty", fixtures / "pty-test.py")
    terminal.subprocess = subprocess
    terminal.exercise_session()
    terminal.negative_control()
    # These inject failures into the same patched Popen, not the host's Popen.
    errors.verify_cleanup_negative_controls()
    lifecycle.verify_native_negative_control()
    print("Python fork-less native replay: actual patched subprocess and cleanup controls verified")


if __name__ == "__main__":
    assert len(sys.argv) == 3, "usage: forkless-host-test.py PATCHED_SUBPROCESS FIXTURES"
    main(Path(sys.argv[1]), Path(sys.argv[2]))
