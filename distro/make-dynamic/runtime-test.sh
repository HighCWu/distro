#!/bin/sh
# shellcheck shell=sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C

make_program=${MAKE_DYNAMIC_PROGRAM:-/bin/make-dynamic}
plugin=${MAKE_DYNAMIC_PLUGIN:-/lib/make-dynamic/makeplugin.so}
bad_plugin=${MAKE_DYNAMIC_BAD_PLUGIN:-/lib/make-dynamic/badplugin.so}
native_reference=${NATIVE_REFERENCE:-0}
work=

cleanup() {
  if [ -n "$work" ]; then
    rm -rf "$work"
  fi
}

fail() {
  printf 'make dynamic runtime failure: %s\n' "$*" >&2
  if [ -n "$work" ] && [ -d "$work" ]; then
    for diagnostic in "$work"/*.stderr "$work"/*.stdout; do
      if [ -f "$diagnostic" ] && [ -s "$diagnostic" ]; then
        printf 'make dynamic diagnostic (%s):\n' "${diagnostic##*/}" >&2
        tail -n 20 "$diagnostic" >&2
      fi
    done
  fi
  cleanup
  work=
  if [ "$native_reference" = 1 ]; then
    exit 1
  fi
  echo '::vm-test::fail'
  while :; do sleep 1; done
}

if [ "$native_reference" != 1 ]; then
  mount -t devtmpfs devtmpfs /dev >/dev/null 2>&1
  status=$?
  if [ "$status" -ne 0 ]; then
    fail "mount devtmpfs (status $status)"
  fi
  mount -t proc proc /proc >/dev/null 2>&1
  status=$?
  if [ "$status" -ne 0 ]; then
    fail "mount proc (status $status)"
  fi
fi

[ -x "$make_program" ] || fail "make is not executable: $make_program"
[ -r "$plugin" ] || fail "make plugin is not readable: $plugin"
[ -r "$bad_plugin" ] || fail "bad make plugin is not readable: $bad_plugin"

version=$("$make_program" --version 2>/dev/null)
status=$?
if [ "$status" -ne 0 ]; then
  fail "make --version failed (status $status)"
fi
case "$version" in
*"GNU Make"*) ;;
*) fail 'expected GNU Make' ;;
esac

work=$(mktemp -d /tmp/make-dynamic-runtime.XXXXXX 2>/dev/null)
status=$?
if [ "$status" -ne 0 ] || [ -z "$work" ]; then
  fail 'creating temporary directory'
fi
trap cleanup 0

# Load the standard plugin, run its setup hook, and expand its public function
# against a variable owned by the main makefile.
first_makefile=$work/first.mk
first_output=$work/first.out
cat >"$first_makefile" <<'MAKEFILE'
BASE_VALUE := base42
load $(MAKE_DYNAMIC_PLUGIN)
.PHONY: all
all:
	@printf '%s\n' '$(PLUGIN_READY)' '$(PLUGIN_SETUP_COUNT)' \
	  '$(wasm_plugin alpha)' >"$(MAKE_DYNAMIC_OUTPUT)"
MAKEFILE
status=$?
if [ "$status" -ne 0 ]; then
  fail 'writing first Makefile'
fi
MAKE_DYNAMIC_PLUGIN="$plugin" MAKE_DYNAMIC_OUTPUT="$first_output" \
  "$make_program" --no-print-directory -f "$first_makefile" all \
  >"$work/first.stdout" 2>"$work/first.stderr"
status=$?
if [ "$status" -ne 0 ]; then
  fail "loading standard make plugin (status $status)"
fi
printf '%s\n' 'plugin-ready' '1' 'alpha:base42' >"$work/first.expected"
status=$?
if [ "$status" -ne 0 ]; then
  fail 'writing first expected output'
fi
cmp "$work/first.expected" "$first_output" >/dev/null 2>&1
status=$?
if [ "$status" -ne 0 ]; then
  fail 'plugin setup or public function returned the wrong value'
fi
echo 'make dynamic: load setup and main variable expansion pass'

# Loading the same object twice must initialize it once. The nested function
# calls back through make's expansion API, and .LOADED must list this object.
second_makefile=$work/second.mk
second_output=$work/second.out
cat >"$second_makefile" <<'MAKEFILE'
BASE_VALUE := base42
load $(MAKE_DYNAMIC_PLUGIN)
load $(MAKE_DYNAMIC_PLUGIN)
.PHONY: all
all:
	@printf '%s\n' '$(PLUGIN_READY)' '$(PLUGIN_SETUP_COUNT)' \
	  '$(wasm_nested nested)' '$(.LOADED)' >"$(MAKE_DYNAMIC_OUTPUT)"
MAKEFILE
status=$?
if [ "$status" -ne 0 ]; then
  fail 'writing duplicate-load Makefile'
fi
MAKE_DYNAMIC_PLUGIN="$plugin" MAKE_DYNAMIC_OUTPUT="$second_output" \
  "$make_program" --no-print-directory -f "$second_makefile" all \
  >"$work/second.stdout" 2>"$work/second.stderr"
status=$?
if [ "$status" -ne 0 ]; then
  fail "repeated make plugin load (status $status)"
fi
printf '%s\n' 'plugin-ready' '1' 'nested:base42' >"$work/second.expected"
status=$?
if [ "$status" -ne 0 ]; then
  fail 'writing duplicate-load expected output'
fi
head -n 3 "$second_output" >"$work/second.values"
status=$?
if [ "$status" -ne 0 ]; then
  fail 'reading duplicate-load values'
fi
cmp "$work/second.expected" "$work/second.values" >/dev/null 2>&1
status=$?
if [ "$status" -ne 0 ]; then
  fail 'nested plugin callback or one-time setup count was incorrect'
fi
awk -v plugin_path="$plugin" '
  NR == 4 {
    for (field = 1; field <= NF; field++) {
      if ($field == plugin_path) count++
    }
  }
  END { if (count != 1) exit 1 }
' "$second_output"
status=$?
if [ "$status" -ne 0 ]; then
  fail '.LOADED did not contain this plugin exactly once'
fi
echo 'make dynamic: nested expansion and duplicate load remain idempotent pass'

# A normal dependency-driven recipe consumes the plugin function. A second
# make invocation must find the artifact current and leave the recipe log alone.
recipe_dir=$work/recipe
recipe_makefile=$recipe_dir/Makefile
recipe_input=$recipe_dir/input
recipe_output=$recipe_dir/output
recipe_log=$recipe_dir/recipe.log
mkdir -p "$recipe_dir"
status=$?
if [ "$status" -ne 0 ]; then
  fail 'creating recipe directory'
fi
: >"$recipe_input"
status=$?
if [ "$status" -ne 0 ]; then
  fail 'creating recipe input dependency'
fi
cat >"$recipe_makefile" <<'MAKEFILE'
BASE_VALUE := base42
load $(MAKE_DYNAMIC_PLUGIN)
.PHONY: all
all: $(MAKE_DYNAMIC_OUTPUT)
$(MAKE_DYNAMIC_OUTPUT): $(MAKE_DYNAMIC_INPUT)
	@printf '%s\n' '$(wasm_plugin recipe)' '$<' '$^' >"$@"
	@printf '%s\n' recipe-ran >>"$(MAKE_DYNAMIC_LOG)"
MAKEFILE
status=$?
if [ "$status" -ne 0 ]; then
  fail 'writing recipe Makefile'
fi
MAKE_DYNAMIC_PLUGIN="$plugin" MAKE_DYNAMIC_INPUT="$recipe_input" \
  MAKE_DYNAMIC_OUTPUT="$recipe_output" MAKE_DYNAMIC_LOG="$recipe_log" \
  "$make_program" --no-print-directory -f "$recipe_makefile" all \
  >"$work/recipe-first.stdout" 2>"$work/recipe-first.stderr"
status=$?
if [ "$status" -ne 0 ]; then
  fail "plugin recipe build failed (status $status)"
fi
printf '%s\n' 'recipe:base42' "$recipe_input" "$recipe_input" \
  >"$work/recipe.expected"
status=$?
if [ "$status" -ne 0 ]; then
  fail 'writing expected recipe output'
fi
cmp "$work/recipe.expected" "$recipe_output" >/dev/null 2>&1
status=$?
if [ "$status" -ne 0 ]; then
  fail 'plugin recipe result or dependency automatic variables were wrong'
fi
MAKE_DYNAMIC_PLUGIN="$plugin" MAKE_DYNAMIC_INPUT="$recipe_input" \
  MAKE_DYNAMIC_OUTPUT="$recipe_output" MAKE_DYNAMIC_LOG="$recipe_log" \
  "$make_program" --no-print-directory -f "$recipe_makefile" all \
  >"$work/recipe-second.stdout" 2>"$work/recipe-second.stderr"
status=$?
if [ "$status" -ne 0 ]; then
  fail "second no-op make invocation failed (status $status)"
fi
recipe_count=$(wc -l <"$recipe_log")
status=$?
if [ "$status" -ne 0 ] || [ "$recipe_count" -ne 1 ]; then
  fail 'second make invocation reran an up-to-date recipe'
fi
echo 'make dynamic: recipe output dependency and second no-op pass'

# The required bad plugin reports its setup marker and rejects loading before
# any target recipe can run. Recovery uses a separate make process with the good plugin.
bad_makefile=$work/bad.mk
bad_recipe_marker=$work/bad-recipe-ran
bad_output=$work/recovery.out
cat >"$bad_makefile" <<'MAKEFILE'
load $(MAKE_DYNAMIC_BAD_PLUGIN)
.PHONY: must-not-run
must-not-run:
	@printf '%s\n' ran >"$(MAKE_DYNAMIC_BAD_RECIPE_MARKER)"
MAKEFILE
status=$?
if [ "$status" -ne 0 ]; then
  fail 'writing bad-plugin Makefile'
fi
MAKE_DYNAMIC_BAD_PLUGIN="$bad_plugin" \
  MAKE_DYNAMIC_BAD_RECIPE_MARKER="$bad_recipe_marker" \
  "$make_program" --no-print-directory -f "$bad_makefile" must-not-run \
  >"$work/bad.stdout" 2>"$work/bad.stderr"
bad_status=$?
if [ "$bad_status" -eq 0 ]; then
  fail 'make accepted the plugin whose setup returns failure'
fi
grep -Fx 'MAKE_PLUGIN_BAD_INIT_CALLED' "$work/bad.stdout" >/dev/null 2>&1
status=$?
if [ "$status" -ne 0 ]; then
  fail 'bad plugin setup marker was not printed'
fi
if [ -f "$bad_recipe_marker" ]; then
  fail 'bad plugin load ran a target recipe before failing'
fi

recovery_makefile=$work/recovery.mk
cat >"$recovery_makefile" <<'MAKEFILE'
BASE_VALUE := base42
load $(MAKE_DYNAMIC_PLUGIN)
.PHONY: recover
recover:
	@printf '%s\n' '$(wasm_plugin recovery)' >"$(MAKE_DYNAMIC_OUTPUT)"
MAKEFILE
status=$?
if [ "$status" -ne 0 ]; then
  fail 'writing recovery Makefile'
fi
MAKE_DYNAMIC_PLUGIN="$plugin" MAKE_DYNAMIC_OUTPUT="$bad_output" \
  "$make_program" --no-print-directory -f "$recovery_makefile" recover \
  >"$work/recovery.stdout" 2>"$work/recovery.stderr"
status=$?
if [ "$status" -ne 0 ]; then
  fail "new make process did not recover with the good plugin (status $status)"
fi
printf '%s\n' 'recovery:base42' >"$work/recovery.expected"
status=$?
if [ "$status" -ne 0 ]; then
  fail 'writing expected recovery output'
fi
cmp "$work/recovery.expected" "$bad_output" >/dev/null 2>&1
status=$?
if [ "$status" -ne 0 ]; then
  fail 'fresh make process returned the wrong recovery result'
fi
echo 'make dynamic: bad setup fails before recipe and fresh make recovers pass'

rm -rf "$work"
status=$?
if [ "$status" -ne 0 ]; then
  fail 'temporary tree cleanup'
fi
work=
trap - 0
echo '::vm-test::pass'
if [ "$native_reference" = 1 ]; then
  exit 0
fi
while :; do sleep 1; done
