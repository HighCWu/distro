#!/bin/busybox sh
# SPDX-License-Identifier: MIT
export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C
fail() {
  echo "::vm-test::fail: VM events: $*"
  exit 1
}
mount -t proc proc /proc || fail 'mount proc'
vm-events || fail 'real kernel page event consumer'
vmstat 1 2 >/tmp/vmstat.out || fail 'upstream BusyBox vmstat'
cat /tmp/vmstat.out || fail 'read vmstat report'
awk '
  /^[[:space:]]*[0-9]/ {
    if (NF < 16 || NF > 17) exit 1
    for (i = 1; i <= NF; i++) if ($i !~ /^[0-9]+$/) exit 1
    rows++
  }
  END { if (rows != 2) exit 1 }
' /tmp/vmstat.out || fail 'two complete numeric vmstat samples'
rm /tmp/vmstat.out || fail 'vmstat output cleanup'
for notice in LICENSE.MIT musl-COPYRIGHT compiler-rt-LICENSE.TXT; do
  test -s "/share/licenses/vm-events/$notice" || fail "missing license $notice"
done
echo 'vm-events: upstream BusyBox vmstat two samples and cleanup pass'
echo '::vm-test::pass'
while :; do sleep 1; done
