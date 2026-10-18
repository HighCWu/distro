# SPDX-License-Identifier: MIT
"""Run a Python/Git/SQLite workspace on ordinary Linux or Linux/Wasm.

Use `write DIRECTORY` once, then `read DIRECTORY HEAD` after a clean restart.
This example never downloads code, invokes a shell command string or installs
dependencies. It creates files only below the explicitly selected directory.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys


PAYLOAD = bytes(index & 255 for index in range(65553))
FILE = "payload ' $HOME → data.bin"
APPLICATION = "application ' $HOME →.py"
MARKER = b"Python pre-commit hook verified binary payload\n"
APP = """import pathlib, sys
data = pathlib.Path(sys.argv[1]).read_bytes()
assert sys.stdin.buffer.read() == data
sys.stdout.buffer.write(data[::-1])
""".encode()


def workspace(phase, directory, expected_head=None):
    directory = directory.resolve()
    repo = directory / "project ' $HOME → repo"
    clone = directory / "clone ' $HOME → repo"
    database = directory / "workspace.sqlite"
    digest = hashlib.sha256(PAYLOAD).hexdigest()
    env = {key: os.environ[key] for key in ("PATH", "HOME", "TMPDIR") if key in os.environ}
    env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null", GIT_TERMINAL_PROMPT="0",
               GIT_AUTHOR_NAME="Linux/Wasm developer", GIT_AUTHOR_EMAIL="developer@example.test",
               GIT_COMMITTER_NAME="Linux/Wasm developer", GIT_COMMITTER_EMAIL="developer@example.test",
               GIT_AUTHOR_DATE="2000-01-01T00:00:00+0000", GIT_COMMITTER_DATE="2000-01-01T00:00:00+0000", LC_ALL="C")

    def run(argv, *, cwd=directory, data=None):
        result = subprocess.run(argv, cwd=cwd, env=env, input=data, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, check=True)
        if result.stderr:
            raise ValueError("unexpected subprocess stderr: " + repr(result.stderr))
        return result.stdout

    def git(*args, at=repo):
        return run(["git", "-C", str(at), *args])

    def quiet(*args, at=repo):
        if git(*args, at=at):
            raise ValueError("unexpected Git stdout")

    if phase == "write":
        if expected_head is not None:
            raise ValueError("write does not accept an existing HEAD")
        # Fail before modifying an existing workspace, not mkdir(exist_ok=True).
        directory.mkdir(parents=True)
        if run(["git", "init", "--quiet", "--initial-branch=main", "--object-format=sha1", str(repo)]):
            raise ValueError("unexpected Git init stdout")
        (repo / FILE).write_bytes(PAYLOAD)
        (repo / APPLICATION).write_bytes(APP)
        hook = repo / ".git/hooks/pre-commit"
        hook.write_text('#!/bin/sh\nexec python3 -I "$0.py"\n')
        hook.chmod(0o755)
        hook.with_name("pre-commit.py").write_text(
            "import hashlib, pathlib\n"
            f"data = pathlib.Path({FILE!r}).read_bytes()\n"
            f"assert hashlib.sha256(data).hexdigest() == {digest!r}\n"
            f"pathlib.Path('.git/python-hook-marker').write_bytes({MARKER!r})\n", encoding="utf-8")
        quiet("add", "--", FILE, APPLICATION)
        quiet("-c", "commit.gpgSign=false", "commit", "--quiet", "-m", "Python-built binary application input")
        quiet("-c", "pack.threads=2", "repack", "-adq")
    elif phase != "read" or expected_head is None or re.fullmatch("[0-9a-f]{40}", expected_head) is None:
        raise ValueError("read requires the previously reported SHA-1 HEAD")

    quiet("status", "--porcelain=v1")
    head = git("rev-parse", "--verify", "HEAD").decode("ascii").rstrip("\n")
    if re.fullmatch("[0-9a-f]{40}", head) is None or (phase == "read" and head != expected_head):
        raise ValueError("unexpected repository HEAD")
    if (repo / ".git/python-hook-marker").read_bytes() != MARKER:
        raise ValueError("Python commit hook was not executed")

    def verify(at):
        for name, content in ((FILE, PAYLOAD), (APPLICATION, APP)):
            if (at / name).read_bytes() != content or git("cat-file", "blob", "HEAD:" + name, at=at) != content:
                raise ValueError("worktree or Git object bytes differ")
        if git("rev-parse", "--verify", "HEAD", at=at) != (head + "\n").encode():
            raise ValueError("cloned HEAD differs")
        quiet("fsck", "--strict", at=at)
        quiet("status", "--porcelain=v1", at=at)
        if run([sys.executable, "-I", str(at / APPLICATION), FILE], cwd=at, data=PAYLOAD) != PAYLOAD[::-1]:
            raise ValueError("repository Python application binary output differs")

    verify(repo)
    if phase == "read":
        if run(["git", "clone", "--quiet", "--no-local", str(repo), str(clone)]):
            raise ValueError("unexpected clone stdout")
        verify(clone)
        connection = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)
    else:
        connection = sqlite3.connect(database)
    try:
        if phase == "write":
            connection.execute("CREATE TABLE result (head TEXT, digest TEXT, payload BLOB)")
            connection.execute("INSERT INTO result VALUES (?, ?, ?)", (head, digest, PAYLOAD))
            connection.commit()
        if connection.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
            raise ValueError("SQLite integrity check failed")
        if connection.execute("SELECT head, digest, payload FROM result").fetchall() != [(head, digest, PAYLOAD)]:
            raise ValueError("persisted SQLite result differs")
    finally:
        connection.close()
    return dict(head=head, sha256=digest, bytes=len(PAYLOAD), phase=phase)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("write", "read"))
    parser.add_argument("directory", type=Path)
    parser.add_argument("head", nargs="?")
    args = parser.parse_args()
    print(json.dumps(workspace(args.phase, args.directory, args.head), sort_keys=True))
