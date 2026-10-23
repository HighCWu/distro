# SPDX-License-Identifier: MIT
"""Exercise unchanged CPython signal-stack consumers, not engine-fault recovery."""
import faulthandler
import os
import signal
import sys
import sysconfig
import tempfile


def emit_traceback():
    signal.raise_signal(signal.SIGUSR1)


def check():
    assert sysconfig.get_config_var("HAVE_SIGALTSTACK") == 1
    assert faulthandler.is_enabled(), "start with -X faulthandler"
    faulthandler.disable()
    assert not faulthandler.is_enabled()
    print("Python faulthandler: normal configure detection and startup stack registration pass", flush=True)

    delivered = []
    previous = signal.signal(signal.SIGUSR1, lambda signum, frame: delivered.append(signum))
    try:
        with tempfile.TemporaryFile(mode="w+b") as output:
            for all_threads in (False, True):
                for _ in range(8):
                    output.seek(0)
                    output.truncate()
                    faulthandler.register(signal.SIGUSR1, file=output, all_threads=all_threads, chain=False)
                    emit_traceback()
                    assert delivered == [], "unchained handler must not call previous disposition"
                    output.seek(0)
                    dump = output.read().decode("utf-8")
                    assert dump.count(" in emit_traceback") == 1, dump
                    assert os.path.basename(__file__) in dump and " in check" in dump, dump
                    assert faulthandler.unregister(signal.SIGUSR1)
                    assert not faulthandler.unregister(signal.SIGUSR1)
            signal.raise_signal(signal.SIGUSR1)
            assert delivered == [signal.SIGUSR1], delivered
            print("Python faulthandler: repeated SA_ONSTACK traceback delivery and previous-handler restoration pass", flush=True)

            try:
                faulthandler.register(-1, file=output)
            except (ValueError, OSError):
                pass
            else:
                raise AssertionError("invalid signal registration succeeded")
            faulthandler.enable(file=output, all_threads=False)
            assert faulthandler.is_enabled()
            faulthandler.disable()
            assert not faulthandler.is_enabled()
            output.seek(0)
            output.truncate()
            faulthandler.register(signal.SIGUSR1, file=output, all_threads=False)
            emit_traceback()
            output.seek(0)
            assert output.read().count(b" in emit_traceback") == 1
            assert faulthandler.unregister(signal.SIGUSR1)
    finally:
        faulthandler.unregister(signal.SIGUSR1)
        signal.signal(signal.SIGUSR1, previous)
        faulthandler.disable()
    print("Python faulthandler: invalid registration, enable-disable recovery and descriptor cleanup pass", flush=True)


if __name__ == "__main__":
    check()
