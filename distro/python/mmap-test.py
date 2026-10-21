# SPDX-License-Identifier: MIT
"""Shared fixture; native execution checks assertions, not Wasm support."""

import errno
import mmap
import sys
import tempfile


def private_mapping(size):
    return mmap.mmap(
        -1, size, flags=mmap.MAP_PRIVATE, prot=mmap.PROT_READ | mmap.PROT_WRITE
    )


def expect_error(kind, operation):
    try:
        operation()
    except kind as error:
        return error
    raise AssertionError("operation did not raise " + kind.__name__)


def exercise_buffers():
    size = 2 * mmap.PAGESIZE + 37
    payload = b"\x00\x80\xffLinux/Wasm\x00"
    with private_mapping(size) as mapping:
        assert len(mapping) == size
        assert mapping[:] == bytes(size)
        position = mmap.PAGESIZE - 3
        mapping.seek(position)
        assert mapping.write(payload) == len(payload)
        assert mapping.tell() == position + len(payload)
        mapping.seek(position)
        assert mapping.read(len(payload)) == payload
        assert mapping.find(payload, 0) == position
        mapping.move(position + 1, position, len(payload))
        assert mapping[position + 1 : position + 1 + len(payload)] == payload
        view = memoryview(mapping)
        view[0] = 0xFE
        assert mapping[0] == 0xFE
        expect_error(BufferError, mapping.close)
        assert not mapping.closed
        view.release()
    assert mapping.closed
    mapping.close()  # idempotent close, without another munmap
    expect_error(ValueError, lambda: mapping.read(1))

    # Exercise release/reallocation without assuming address reuse or growth.
    for _ in range(16):
        with private_mapping(size) as mapping:
            assert mapping[:] == bytes(size)
            mapping[-1] = 0xFF
    expect_error(OverflowError, lambda: private_mapping(-1))
    print("Python mmap: private anonymous bytes, buffer lifetime and close verified")


def exercise_resize():
    page = mmap.PAGESIZE
    original = bytes(range(256)) * (2 * page // 256)
    with private_mapping(2 * page) as mapping:
        mapping[:] = original
        view = memoryview(mapping)
        expect_error(BufferError, lambda: mapping.resize(12 * page))
        assert len(mapping) == 2 * page and mapping[:] == original, "exported resize changed mapping"
        view.release()
        assert mapping.resize(12 * page) is None
        assert len(mapping) == 12 * page, "resize did not update logical size"
        assert mapping[: 2 * page] == original, "resize lost existing data"
        assert mapping[2 * page :] == bytes(10 * page), "expanded pages are not zero"

        before = mapping[:]
        error = expect_error(OSError, lambda: mapping.resize(0))
        assert error.errno == errno.EINVAL, error
        expect_error(ValueError, lambda: mapping.resize(-1))
        assert len(mapping) == 12 * page and mapping[:] == before, "failed resize changed mapping"

        mapping.resize(page)
        assert len(mapping) == page and mapping[:] == original[:page], "shrink lost retained data"
        mapping.resize(3 * page)
        assert mapping[:page] == original[:page]
        assert mapping[page:] == bytes(2 * page), "regrown complete pages retained discarded bytes"
        # Kernel operations round to pages. Check an unaligned size without
        # assuming that a partial last page is discarded when shrinking.
        mapping.resize(3 * page + 37)
        mapping[-1] = 0xA7
        mapping.resize(3 * page + 79)
        assert len(mapping) == 3 * page + 79 and mapping[3 * page + 36] == 0xA7
        assert mapping[3 * page + 37 :] == bytes(42)
    assert mapping.closed
    with private_mapping(page) as retry:
        assert retry[:] == bytes(page)
    print("Python mmap: resize growth, shrink, zero tail, exported buffers and error recovery verified")


def exercise_flush():
    # Private anonymous mappings have no file writeback. Successful msync
    # still requires a valid registered range, flags and aligned address.
    with private_mapping(mmap.PAGESIZE) as mapping:
        mapping[0] = 0x81
        assert mapping.flush() is None and mapping[0] == 0x81, "flush changed private data"
        assert mapping.flush(0, 0) is None
        error = expect_error(OSError, lambda: mapping.flush(1, 1))
        assert error.errno == errno.EINVAL, error
        assert mapping[0] == 0x81, "failed flush changed private data"
    print("Python mmap: private flush preserves data and rejects unaligned ranges without file writeback")


def exercise_advice():
    page = mmap.PAGESIZE
    with private_mapping(3 * page) as mapping:
        mapping[:] = b"\x47" * (3 * page)
        for hint in (mmap.MADV_NORMAL, mmap.MADV_RANDOM, mmap.MADV_SEQUENTIAL, mmap.MADV_WILLNEED):
            assert mapping.madvise(hint) is None
        assert mapping[:] == b"\x47" * (3 * page)
        view = memoryview(mapping)
        assert mapping.madvise(mmap.MADV_DONTNEED, page, 1) is None
        assert bytes(view[:page]) == b"\x47" * page
        assert bytes(view[page:2*page]) == bytes(page)
        assert bytes(view[2*page:]) == b"\x47" * page
        view[page] = 0x81
        assert mapping[page] == 0x81
        error = expect_error(OSError, lambda: mapping.madvise(-1))
        assert error.errno == errno.EINVAL and mapping[page] == 0x81
        view.release()
        assert mapping.madvise(mmap.MADV_DONTNEED) is None
        assert mapping[:] == bytes(3 * page)
        assert mapping.flush() is None
    print("Python mmap: madvise discards anonymous pages, preserves neighbors and live views, and rejects invalid advice")


def exercise_mapping_hints():
    page = mmap.PAGESIZE
    hints = (mmap.MAP_STACK, mmap.MAP_POPULATE, mmap.MAP_DENYWRITE | mmap.MAP_EXECUTABLE,
             mmap.MAP_STACK | mmap.MAP_POPULATE | mmap.MAP_DENYWRITE | mmap.MAP_EXECUTABLE)
    for hint in hints:
        with mmap.mmap(-1, 2 * page, flags=mmap.MAP_PRIVATE | hint,
                       prot=mmap.PROT_READ | mmap.PROT_WRITE) as mapping:
            assert mapping[:] == bytes(2 * page)
            mapping[page] = 0x81
            assert mapping.flush() is None and mapping[page] == 0x81
            mapping.resize(3 * page)
            assert mapping[page] == 0x81 and mapping[2*page:] == bytes(page)
            mapping.madvise(mmap.MADV_DONTNEED)
            assert mapping[:] == bytes(3 * page)
    print("Python mmap: advisory stack and populate flags preserve zero initialization, resize, advice and close")


def exercise_kernel_boundaries():
    # CPython's default anonymous request is MAP_SHARED, not MAP_PRIVATE.
    error = expect_error(OSError, lambda: mmap.mmap(-1, mmap.PAGESIZE))
    assert error.errno == errno.EINVAL, error
    with tempfile.TemporaryFile() as backing:
        backing.write(bytes(mmap.PAGESIZE))
        backing.flush()
        error = expect_error(
            OSError,
            lambda: mmap.mmap(
                backing.fileno(),
                mmap.PAGESIZE,
                flags=mmap.MAP_PRIVATE,
                prot=mmap.PROT_READ | mmap.PROT_WRITE,
            ),
        )
        assert error.errno == errno.EINVAL, error
    print("Python mmap: default shared and file mappings rejected by default kernel")


if __name__ == "__main__":
    assert sys.argv[1:] in ([], ["--kernel-boundaries"]), sys.argv
    exercise_buffers()
    exercise_resize()
    exercise_flush()
    exercise_advice()
    exercise_mapping_hints()
    if sys.argv[1:]:
        exercise_kernel_boundaries()
