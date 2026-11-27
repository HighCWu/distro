#!/bin/sh
set -u

mount -t proc proc /proc
/vm-test-setup-dev-fd

mkdir -p /tmp/rex_dir_a /tmp/rex_dir_b
printf 'alpha\n' >/tmp/rex_a
printf 'beta\n' >/tmp/rex_b
printf 'in_a\n' >/tmp/rex_dir_a/tag
printf 'in_b\n' >/tmp/rex_dir_b/tag

out=$(rename_exchange /tmp/rex_a /tmp/rex_b 2>&1)
rc=$?
[ -n "$out" ] && printf '%s\n' "$out"
if [ "$rc" -ne 0 ]; then
  echo "rename_exchange files failed with rc=$rc"
  exit 1
fi

got_a=$(cat /tmp/rex_a)
got_b=$(cat /tmp/rex_b)
if [ "$got_a" != "beta" ] || [ "$got_b" != "alpha" ]; then
  echo "file exchange mismatch: a='$got_a' b='$got_b'"
  exit 1
fi

out=$(rename_exchange /tmp/rex_dir_a /tmp/rex_dir_b 2>&1)
rc=$?
[ -n "$out" ] && printf '%s\n' "$out"
if [ "$rc" -ne 0 ]; then
  echo "rename_exchange dirs failed with rc=$rc"
  exit 1
fi

got_da=$(cat /tmp/rex_dir_a/tag)
got_db=$(cat /tmp/rex_dir_b/tag)
if [ "$got_da" != "in_b" ] || [ "$got_db" != "in_a" ]; then
  echo "dir exchange mismatch: da='$got_da' db='$got_db'"
  exit 1
fi

rm -rf /tmp/rex_a /tmp/rex_b /tmp/rex_dir_a /tmp/rex_dir_b
echo "::vm-test::pass"
