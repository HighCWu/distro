#!/bin/busybox sh
# SPDX-License-Identifier: MIT
export PATH=/bin:/sbin:/usr/bin:/usr/sbin
unset PROC_ROOT PROC_NET_UNIX PROC_NET_TCP PROC_NET_UDP PROC_NET_NETLINK
(cd / && sha256sum -c /ss.sha256) || exit 1
version=$(/sbin/ss -V) || exit 1
case "$version" in
*iproute2-7.3.0*) ;;
*)
  echo '::vm-test::fail: unexpected ss version'
  exit 1
  ;;
esac
echo 'socket diagnostics: proc-free NOMMU shell subshell and command substitution pass'
ifconfig lo 127.0.0.1 up || exit 1
/libexec/socket-diag/verify || exit 1
ifconfig lo down || exit 1
echo 'socket diagnostics: loopback fixture teardown pass'
echo '::vm-test::pass'
while :; do sleep 1; done
