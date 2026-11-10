#!/bin/sh
# SPDX-License-Identifier: MIT
# Configure the ordinary-fork BusyBox profile after `make allnoconfig`.

set -eu

if [ ! -f Config.in ] || [ ! -f Makefile ]; then
  printf '%s\n' 'busybox-fork: run configure.sh from the BusyBox source directory' >&2
  exit 1
fi
if [ ! -f .config ]; then
  printf '%s\n' 'busybox-fork: run make allnoconfig before configure.sh' >&2
  exit 1
fi

config() {
  name=$1
  value=$2
  case $name in
  '' | *[!A-Z0-9_]*)
    printf 'busybox-fork: invalid Kconfig name: %s\n' "$name" >&2
    exit 1
    ;;
  esac
  sed -i "/^CONFIG_${name}=/d; /^# CONFIG_${name} is not set$/d" .config
  if [ "$value" = n ]; then
    printf '# CONFIG_%s is not set\n' "$name" >>.config
  else
    printf 'CONFIG_%s=%s\n' "$name" "$value" >>.config
  fi
}

# Select BusyBox's ordinary fork path using the optional execution ABI.
# Kernel CONFIG_MMU remains n.
config NOMMU n
config STATIC y
config BUSYBOX y
config SHOW_USAGE y
config INSTALL_NO_USR y
config LFS y
config ASH y
config ASH_JOB_CONTROL n
config SH_IS_ASH y
config SH_IS_HUSH n
config SH_IS_NONE n
config FEATURE_SH_MATH y
config FEATURE_SH_MATH_64 y
config ASH_ALIAS y
config ASH_ECHO y
config ASH_PRINTF y
config ASH_TEST y
config ASH_GETOPTS y
config ASH_CMDCMD y
config FEATURE_TEST_64 y
config BUSYBOX_EXEC_PATH '"/opt/busybox-fork/bin/busybox"'
config CROSS_COMPILER_PREFIX '""'
config EXTRA_LDLIBS '"c"'
config EXTRA_CFLAGS '"-O2 -std=gnu17 -mllvm -wasm-enable-sjlj"'

for applet in \
  ECHO PRINTF TEST TEST1 TEST2 TRUE FALSE CAT LS CP MV RM MKDIR RMDIR STAT CHMOD \
  CHOWN LN READLINK TOUCH HEAD TAIL SED GREP CUT TR WC SORT UNIQ ENV UNAME ID \
  WHOAMI PWD DATE SLEEP TIMEOUT TEE FIND XARGS AWK TAR BASENAME DIRNAME EXPR KILL; do
  config "$applet" y
done

# find -name is part of the base FIND applet; it has no separate Kconfig option.
config FEATURE_FIND_EXEC y
config FEATURE_FIND_EXEC_PLUS y
config FEATURE_FIND_TYPE y
config FEATURE_FIND_MAXDEPTH y
config FEATURE_TAR_CREATE y

# Keep shell-style whitespace grouping and the -0 / parallel modes used by the
# process workload. BusyBox 1.37.0 has no GNU --process-slot-var option.
config FEATURE_XARGS_SUPPORT_QUOTES y
config FEATURE_XARGS_SUPPORT_ZERO_TERM y
config FEATURE_XARGS_SUPPORT_PARALLEL y
config FEATURE_AWK_LIBM y
config FEATURE_ALLOW_EXEC y

printf '%s\n' 'busybox-fork: configured .config; run make oldconfig in the package recipe'
