# SPDX-License-Identifier: MIT
"""Archive a committed distro checkout, not submodules or an offline closure."""
import argparse
import gzip
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile


def git(repository, *args):
    return subprocess.check_output(["git", "-C", str(repository), *args])


def selection(repository, revision):
    commit = git(repository, "rev-parse", "--verify", "--end-of-options", revision + "^{commit}").decode().strip()
    entries = {}
    for record in git(repository, "ls-tree", "-rz", "--full-tree", commit).split(b"\0"):
        if not record:
            continue
        header, raw_name = record.split(b"\t", 1)
        mode, kind, object_id = header.decode().split()
        name = raw_name.decode("utf-8", "surrogateescape")
        if kind != "blob" or mode not in ("100644", "100755", "120000"):
            raise ValueError("checkout contains an unsupported entry or unbundled submodule: " + name)
        entries["distro/" + name] = (mode, object_id)
    if not entries:
        raise ValueError("selected checkout has no files")
    return commit, entries


def verify(repository, revision, destination):
    commit, entries = selection(repository, revision)
    directories = {"distro"}
    for name in entries:
        directories.update(str(parent) for parent in Path(name).parents if str(parent) != ".")
    with tarfile.open(destination, "r:gz") as archive:
        members = archive.getmembers()
        names = [member.name for member in members]
        if len(set(names)) != len(names) or set(names) != set(entries) | directories:
            raise ValueError("checkout archive membership differs from committed Git tree")
        if archive.pax_headers.get("comment") != commit:
            raise ValueError("checkout archive commit identity differs")
        # One object reader avoids a process per tracked file. No checkout files
        # or archived scripts are executed, and no archive member is extracted.
        process = subprocess.Popen(["git", "-C", str(repository), "cat-file", "--batch"],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        try:
            for member in members:
                if member.name in directories:
                    if not member.isdir() or member.mode != 0o755:
                        raise ValueError("invalid checkout directory: " + member.name)
                    continue
                mode, object_id = entries[member.name]
                process.stdin.write((object_id + "\n").encode())
                process.stdin.flush()
                header = process.stdout.readline().decode().strip().split()
                if len(header) != 3 or header[:2] != [object_id, "blob"]:
                    raise ValueError("cannot read committed object: " + member.name)
                size = int(header[2])
                if mode == "120000":
                    expected = process.stdout.read(size)
                    valid = member.issym() and member.linkname.encode("utf-8", "surrogateescape") == expected
                else:
                    valid = (member.type == tarfile.REGTYPE and member.size == size
                             and member.mode == (0o755 if mode == "100755" else 0o644))
                    actual = archive.extractfile(member) if valid else None
                    try:
                        remaining = size
                        while remaining:
                            expected = process.stdout.read(min(65536, remaining))
                            if not expected:
                                raise ValueError("truncated committed object")
                            remaining -= len(expected)
                            if actual is not None and actual.read(len(expected)) != expected:
                                valid = False
                    finally:
                        if actual is not None:
                            actual.close()
                if process.stdout.read(1) != b"\n" or not valid:
                    raise ValueError("checkout member differs from committed object: " + member.name)
        finally:
            process.stdin.close()
            process.stdout.close()
            process.wait()
        if process.returncode:
            raise ValueError("Git object reader failed")
    return len(entries)


def export(repository, revision, destination):
    commit, entries = selection(repository, revision)
    repository = repository.resolve()
    locations = (destination.resolve(), destination.parent.resolve() / destination.name)
    git_directories = [Path(git(repository, *args).decode().strip()) for args in (
        ("rev-parse", "--absolute-git-dir"),
        ("rev-parse", "--path-format=absolute", "--git-common-dir"),
    )]
    tracked = {repository / name.removeprefix("distro/") for name in entries}
    tracked.update(path.resolve() for path in tuple(tracked))
    if any(path in tracked or any(path.is_relative_to(root) for root in git_directories)
           for path in locations):
        raise ValueError("archive must not replace tracked files or Git metadata")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=destination.parent, prefix=".distro-checkout-", delete=False) as output:
            temporary = Path(output.name)
            process = subprocess.Popen(["git", "-C", str(repository), "-c", "tar.umask=0022",
                                        "archive", "--format=tar", "--prefix=distro/", commit],
                                       stdout=subprocess.PIPE)
            try:
                with gzip.GzipFile(filename="", fileobj=output, mode="wb", mtime=0) as compressed:
                    shutil.copyfileobj(process.stdout, compressed, length=65536)
            finally:
                process.stdout.close()
                process.wait()
            if process.returncode:
                raise ValueError("Git archive failed")
        # export-ignore/export-subst must never silently omit/change source.
        count = verify(repository, commit, temporary)
        temporary.chmod(0o644)
        temporary.replace(destination)
        temporary = None
        return count
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("export", "verify"))
    parser.add_argument("repository", type=Path)
    parser.add_argument("revision")
    parser.add_argument("archive", type=Path)
    args = parser.parse_args()
    action = export if args.mode == "export" else verify
    print(f"Verified {action(args.repository, args.revision, args.archive)} committed distro files")
