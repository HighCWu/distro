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
ip link del dev wasmdummy || fail "delete dummy link"
echo 'virtual network: dummy and policy routing pass'
echo '::vm-test::pass'
while :; do sleep 1; done
