#!/bin/busybox sh
# SPDX-License-Identifier: MIT

fail() {
  printf 'runtime check failure: %s\n' "$*"
  echo '::vm-test::fail'
  while :; do sleep 1; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C

api_output=$(/bin/expat-runtime) || fail 'Expat API consumer failed'
api_expected='expat-runtime: streamed UTF-8 namespace/attribute parse and malformed-input diagnostic verified'
[ "$api_output" = "$api_expected" ] || fail 'unexpected Expat API consumer output'

workdir=$(mktemp -d /tmp/expat-xmlwf.XXXXXX) || fail 'create temporary directory'
cat >"$workdir/valid.xml" <<'EOF'
<settings xmlns="urn:settings" version="3"><entry key="beta">A&amp;B</entry></settings>
EOF
cat >"$workdir/invalid.xml" <<'EOF'
<settings><entry></settings>
EOF

/bin/xmlwf -n "$workdir/valid.xml" >"$workdir/valid.out" 2>&1 || fail 'xmlwf rejected a well-formed XML file'
if /bin/xmlwf -n "$workdir/invalid.xml" >"$workdir/invalid.out" 2>&1; then
  fail 'xmlwf accepted a mismatched XML document'
fi
grep -Fq 'mismatched tag' "$workdir/invalid.out" || fail 'xmlwf omitted the malformed-input diagnostic'

rm -rf "$workdir"
echo "$api_output"
echo 'expat-xmlwf: valid file accepted; malformed file rejected with a diagnostic'
echo '::vm-test::pass'
while :; do sleep 1; done
