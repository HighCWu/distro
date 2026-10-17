#!/bin/busybox sh
# SPDX-License-Identifier: MIT

fail() {
  printf 'Lua application failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
for license in lua-readme.html musl-COPYRIGHT compiler-rt-LICENSE.TXT example-MIT; do
  test -s "/share/licenses/lua/$license" || fail "missing application license: $license"
done

# Capture the child's protocol output: only this wrapper may certify that the
# normal application returned successfully rather than remaining alive as PID 1.
timeout -s KILL 10 /bin/lua-embedding-example >/tmp/lua-application.out 2>&1 ||
  fail "example did not exit successfully (output retained in /tmp/lua-application.out)"
grep -qx 'Lua embedding: installed archive, C callbacks, integer64, errors and coroutine verified' /tmp/lua-application.out ||
  fail "example missing complete stage"
grep -qx '::vm-test::pass' /tmp/lua-application.out || fail "example missing pass"
if grep -q '::vm-test::fail' /tmp/lua-application.out; then
  fail "example reported failure"
fi

echo "Lua application: installed example exits normally through Linux verified"
echo "::vm-test::pass"
while :; do :; done
