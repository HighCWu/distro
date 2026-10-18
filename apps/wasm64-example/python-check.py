# SPDX-License-Identifier: MIT
"""Test-only launcher input; never installed in the system root."""
import signal
import sys

mode = sys.argv[1]
if mode == "wait":
    print("Python application ready", flush=True)
    while True:
        signal.pause()
elif mode == "status":
    print(sys.argv[2], flush=True)
    print("Python application stderr", file=sys.stderr, flush=True)
    sys.exit(37)
else:
    raise ValueError("unknown test mode")
