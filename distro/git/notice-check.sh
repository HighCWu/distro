#!/bin/sh
# SPDX-License-Identifier: MIT
# The installed shell is hush, whose supported options do not include -u.
# Keep every required failure explicit rather than relying on shell options.

cd /usr/share/licenses/git || exit 1
for name in git-COPYING sha1dc-LICENSE.txt reftable-LICENSE README.md run-command-posix-spawn.patch notice-tools-MIT; do
  test -s "$name" || exit 1
done
for name in regcomp.c regex.c regex.h regex_internal.c regex_internal.h regexec.c; do
  test -s "compat-regex/$name" || exit 1
done
for name in curl-COPYING zlib.h openssl-LICENSE.txt musl-COPYRIGHT compiler-rt-LICENSE.TXT integration-MIT; do
  test -s "linked/$name" || exit 1
done
test -s SHA256SUMS || exit 1
sha256sum -c SHA256SUMS
