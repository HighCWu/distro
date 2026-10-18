#!/bin/sh
# SPDX-License-Identifier: MIT
set -eu

cd /usr/share/licenses/git
for name in git-COPYING sha1dc-LICENSE.txt reftable-LICENSE README.md run-command-posix-spawn.patch notice-tools-MIT; do
  test -s "$name"
done
for name in regcomp.c regex.c regex.h regex_internal.c regex_internal.h regexec.c; do
  test -s "compat-regex/$name"
done
for name in curl-COPYING zlib.h openssl-LICENSE.txt musl-COPYRIGHT compiler-rt-LICENSE.TXT integration-MIT; do
  test -s "linked/$name"
done
test -s SHA256SUMS
sha256sum -c SHA256SUMS
