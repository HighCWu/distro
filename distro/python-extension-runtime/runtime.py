# SPDX-License-Identifier: MIT
import argparse
import importlib
import inspect
import json
from pathlib import Path
import shutil
import struct
import sys
import tempfile


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("module_dir", type=Path)
    parser.add_argument("--bits", type=int, choices=(32, 64))
    args = parser.parse_args()

    pointer_bits = struct.calcsize("P") * 8
    if args.bits is not None:
        require(
            pointer_bits == args.bits,
            f"expected {args.bits}-bit Python, got {pointer_bits}-bit",
        )

    sys.path.insert(0, str(args.module_dir.resolve()))
    module = importlib.import_module("_wasmexample")
    module_path = Path(module.__file__).resolve()
    require(
        module_path.parent == args.module_dir.resolve(),
        "module was not imported from the configured extension directory",
    )
    require(
        module_path.name.endswith(".so"),
        "module did not load from a native shared object",
    )
    answer_function = module.answer
    require(
        inspect.isbuiltin(answer_function),
        "answer was not registered as a built-in extension function",
    )
    require(
        answer_function is module.answer,
        "answer function registration did not preserve its function object",
    )
    require(answer_function(2) == 42, "answer(2) did not return 42")
    require(module.state() == (1, 0), "initial module state is incorrect")
    print("python extension: standard .so import and answer 42 pass")

    require(
        module.callback(lambda value: value + 1, 40) == 41,
        "callback did not return the Python callable result",
    )
    require(
        module.callback(str.upper, "wasm") == "WASM",
        "callback did not call a built-in Python callable",
    )
    require(module.state() == (1, 2), "successful callback state was not retained")

    def fail_callback(_value):
        raise ValueError("callback error")

    try:
        module.callback(fail_callback, None)
    except ValueError as error:
        require(str(error) == "callback error", "callback exception changed")
    else:
        raise AssertionError("callback exception did not propagate")
    require(module.state() == (1, 2), "failed callback changed module state")
    print("python extension: Python callbacks preserve module state pass")

    try:
        importlib.import_module("_wasmbadinit")
    except ImportError as error:
        require(
            str(error) == "controlled extension initialization failure",
            "bad extension returned the wrong ImportError",
        )
    else:
        raise AssertionError("bad extension import unexpectedly succeeded")
    require(
        "_wasmbadinit" not in sys.modules,
        "failed extension import left a sys.modules entry",
    )
    original_sys_path = sys.path[:]
    original_module = sys.modules.pop("_wasmexample")
    try:
        with tempfile.TemporaryDirectory(
            prefix="python-extension-reload-"
        ) as recovery_dir:
            recovery_path = Path(recovery_dir)
            copied_module_path = recovery_path / module_path.name
            shutil.copy2(module_path, copied_module_path)
            sys.path.insert(0, str(recovery_path))
            importlib.invalidate_caches()
            recovered = importlib.import_module("_wasmexample")
            require(
                Path(recovered.__file__).resolve() == copied_module_path.resolve(),
                "good extension recovery did not load the copied shared object",
            )
            require(recovered.answer(2) == 42, "reloaded extension answer was wrong")
            require(
                recovered.state() == (1, 0),
                "reloaded extension did not start with fresh module state",
            )
            require(module.state() == (1, 2), "original module state was not preserved")
    finally:
        sys.path[:] = original_sys_path
        sys.modules.pop("_wasmexample", None)
        sys.modules["_wasmexample"] = original_module
    require(
        not Path(recovery_dir).exists(), "copied extension directory was not cleaned"
    )
    print("python extension: bad init ImportError and recovery pass")

    with tempfile.TemporaryDirectory(
        prefix="python-extension-runtime-"
    ) as temporary_dir:
        data_path = Path(temporary_dir) / "result.json"
        expected = {"module": module.__name__, "answer": module.answer(4)}
        data_path.write_text(json.dumps(expected), encoding="utf-8")
        require(
            json.loads(data_path.read_text(encoding="utf-8")) == expected,
            "standard-library JSON or file I/O round trip failed",
        )
        require(data_path.is_file(), "temporary file was not created")
    require(not Path(temporary_dir).exists(), "temporary directory was not cleaned")
    require(
        module.state() == (2, 2), "file I/O stage changed module state unexpectedly"
    )


if __name__ == "__main__":
    main()
