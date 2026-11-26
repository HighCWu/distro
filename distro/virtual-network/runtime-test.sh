#!/bin/busybox sh
# SPDX-License-Identifier: MIT
set -eu
export PATH=/bin:/sbin:/usr/bin:/usr/sbin

fail() {
  echo "::vm-test::fail: virtual network: $*"
  exit 1
}

busybox mount -t devtmpfs devtmpfs /dev || fail "mount devtmpfs"
busybox mount -t proc proc /proc || fail "mount procfs"
busybox mount -t sysfs sysfs /sys || fail "mount sysfs"
/tun-probe || fail "TUN bidirectional IPv4"
test ! -e /sys/class/net/wasmtun || fail "TUN survives last close"
/tap-probe || fail "TAP bidirectional Ethernet"
test ! -e /sys/class/net/wasmtap || fail "TAP survives last close"
echo 'virtual network: TAP interface removed on last close'

ip link add name wasmleft type veth || fail "create veth pair"
peer_index=$(cat /sys/class/net/wasmleft/iflink)
test "$peer_index" != "$(cat /sys/class/net/wasmleft/ifindex)" || fail "veth does not have a peer"
peer=
for link in /sys/class/net/veth*; do
  if test -e "$link/ifindex" && test "$(cat "$link/ifindex")" = "$peer_index"; then
    peer=${link##*/}
    break
  fi
done
test -n "$peer" || fail "find veth peer"
ip link set dev wasmleft up || fail "bring up veth endpoint"
ip link set dev "$peer" up || fail "bring up veth peer"
test "$(cat /sys/class/net/wasmleft/carrier)" = 1 || fail "veth carrier"
ip link del dev wasmleft || fail "delete veth pair"
test ! -e "/sys/class/net/$peer" || fail "veth peer remains"
echo 'virtual network: veth pair and peer lifecycle pass'

ip link add name wasmdummy type dummy || fail "create dummy link"
ip link set dev wasmdummy up || fail "bring up dummy link"
ip address add 198.18.0.1/24 dev wasmdummy || fail "assign dummy IPv4 address"
ip route add 198.19.0.0/24 dev wasmdummy table 101 || fail "add separate route table"
ip rule add priority 1101 to 198.19.0.0/24 table 101 || fail "add policy rule"
route=$(ip route get 198.19.0.12) || fail "lookup policy-selected route"
case " $route " in
*" dev wasmdummy "*) ;;
*) fail "policy lookup selected an unexpected device: $route" ;;
esac
ip rule del priority 1101 || fail "delete policy rule"
if route=$(ip route get 198.19.0.12 2>/dev/null); then
  case " $route " in
  *" dev wasmdummy "*) fail "custom table was selected after rule removal" ;;
  esac
fi
ip route del 198.19.0.0/24 dev wasmdummy table 101 || fail "delete custom route"
echo 'virtual network: dummy and IPv4 policy routing pass'

# The pinned BusyBox ip does not accept the nodad address flag.
printf '0\n' >/proc/sys/net/ipv6/conf/wasmdummy/accept_dad || fail "disable dummy IPv6 DAD"
ip -6 address add 2001:db8:100::1/64 dev wasmdummy || fail "assign dummy IPv6 address"
ip -6 route add 2001:db8:200::/64 dev wasmdummy table 102 || fail "add separate IPv6 route table"
ip -6 rule add priority 1102 to 2001:db8:200::/64 table 102 || fail "add IPv6 policy rule"
ipv6_rules=$(ip -6 rule show) || fail "dump IPv6 policy rules"
case "$ipv6_rules" in
*"1102:"*"2001:db8:200::/64"*"lookup 102"*) ;;
*) fail "IPv6 policy rule missing from AF_INET6 dump: $ipv6_rules" ;;
esac
route6=$(ip -6 route get 2001:db8:200::12) || fail "lookup IPv6 policy-selected route"
case " $route6 " in
*" dev wasmdummy "*) ;;
*) fail "IPv6 policy lookup selected an unexpected device: $route6" ;;
esac
case " $route6 " in
*" src 2001:db8:100::1 "*) ;;
*) fail "IPv6 policy lookup selected an unexpected source: $route6" ;;
esac
ip -6 rule del priority 1102 || fail "delete IPv6 policy rule"
ipv6_rules=$(ip -6 rule show) || fail "dump IPv6 rules after deletion"
case "$ipv6_rules" in
*"1102:"*) fail "IPv6 policy rule remains after deletion: $ipv6_rules" ;;
esac
if route6=$(ip -6 route get 2001:db8:200::12 2>/dev/null); then
  case " $route6 " in
  *" dev wasmdummy "*) fail "IPv6 custom table was selected after rule removal" ;;
  esac
fi
ip -6 route del 2001:db8:200::/64 dev wasmdummy table 102 || fail "delete IPv6 custom route"
ip -6 address del 2001:db8:100::1/64 dev wasmdummy || fail "delete dummy IPv6 address"
echo 'virtual network: IPv6 policy routing and AF_INET6 rule dump pass'

ip link del dev wasmdummy || fail "delete dummy link"
echo '::vm-test::pass'
while :; do sleep 1; done
