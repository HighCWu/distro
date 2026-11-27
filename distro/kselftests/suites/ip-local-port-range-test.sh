#!/bin/sh
set -u

mount -t proc proc /proc
/vm-test-setup-dev-fd
ip link set lo up 2>/dev/null || ifconfig lo up 2>/dev/null || true

# ip_local_port_range expects net.ipv4.ip_local_port_range = 40000 49999.
orig_range=$(cat /proc/sys/net/ipv4/ip_local_port_range 2>/dev/null || true)
echo "40000 49999" >/proc/sys/net/ipv4/ip_local_port_range

# Run TCP and UDP variants for IPv4 and IPv6 (omit SCTP/MPTCP variants since
# CONFIG_IP_SCTP and CONFIG_MPTCP are not enabled in defconfig).
for variant in ip4_tcp ip4_udp ip6_tcp ip6_udp; do
  out=$(ip_local_port_range -v "$variant" 2>&1)
  rc=$?
  printf '%s\n' "$out"

  if [ "$rc" -ne 0 ]; then
    [ -n "$orig_range" ] && echo "$orig_range" >/proc/sys/net/ipv4/ip_local_port_range
    echo "ip_local_port_range -v $variant failed with rc=$rc"
    exit 1
  fi

  if printf '%s\n' "$out" | grep -qE '^not ok|#[[:space:]]*SKIP|FAIL'; then
    [ -n "$orig_range" ] && echo "$orig_range" >/proc/sys/net/ipv4/ip_local_port_range
    echo "ip_local_port_range -v $variant reported failure or SKIP"
    exit 1
  fi
done

[ -n "$orig_range" ] && echo "$orig_range" >/proc/sys/net/ipv4/ip_local_port_range
echo "::vm-test::pass"
