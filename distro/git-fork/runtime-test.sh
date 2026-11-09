#!/bin/sh
# shellcheck shell=sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_TERMINAL_PROMPT=0
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_EXEC_PATH

git_program=${GIT_FORK_PROGRAM:-/bin/git-fork}
helper=${GIT_FORK_HELPER:-/bin/git-fork-helper}
native_reference=${NATIVE_REFERENCE:-0}
work=

cleanup() {
  if [ -n "$work" ]; then
    rm -rf "$work"
  fi
}

fail() {
  printf 'git fork runtime failure: %s\n' "$*" >&2
  if [ -n "$work" ] && [ -d "$work" ]; then
    for diagnostic in "$work"/*.stderr "$work"/*.stdout "$work"/*.trace; do
      if [ -f "$diagnostic" ] && [ -s "$diagnostic" ]; then
        printf 'git fork diagnostic (%s):\n' "$diagnostic" >&2
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

git_run() {
  "$git_program" "$@" >"$work/git.stdout" 2>"$work/git.stderr"
}

git_value() {
  "$git_program" "$@" 2>"$work/git-value.stderr"
}

must_git() {
  description=$1
  shift
  git_run "$@"
  status=$?
  if [ "$status" -ne 0 ]; then
    fail "$description (status $status)"
  fi
}

check_hook_log() {
  expected_count=$1
  awk -v expected_count="$expected_count" '
    {
      if (NF != 4 || $1 != "hook" || $2 != "child" ||
          $3 !~ /^pid=[1-9][0-9]*$/ ||
          $4 !~ /^ppid=[1-9][0-9]*$/)
        invalid = 1
      child = $3
      parent = $4
      sub(/^pid=/, "", child)
      sub(/^ppid=/, "", parent)
      if (child == parent)
        invalid = 1
    }
    END {
      if (NR != expected_count || invalid)
        exit 1
    }
  ' "$hook_log"
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

[ -x "$git_program" ] || fail "git is not executable: $git_program"
[ -x "$helper" ] || fail "git helper is not executable: $helper"
version=$("$git_program" --version 2>/dev/null)
status=$?
if [ "$status" -ne 0 ]; then
  fail "git --version failed (status $status)"
fi
case "$version" in
*"git version"*) ;;
*) fail 'expected Git' ;;
esac
git_exec_path=$("$git_program" --exec-path 2>/dev/null)
status=$?
if [ "$status" -ne 0 ] || [ -z "$git_exec_path" ]; then
  fail 'cannot determine Git executable directory'
fi
case "$git_exec_path" in
/*) ;;
*) fail "Git executable directory is not absolute: $git_exec_path" ;;
esac
export PATH="$git_exec_path:/opt/git-fork/bin:$PATH"

work=$(mktemp -d /tmp/git-fork-runtime.XXXXXX 2>/dev/null)
status=$?
if [ "$status" -ne 0 ] || [ -z "$work" ]; then
  fail 'creating temporary directory'
fi
trap cleanup 0

repo=$work/repository
hooks=$work/hooks
hook_log=$work/hooks.log
mkdir -p "$hooks"
status=$?
if [ "$status" -ne 0 ]; then
  fail 'creating repository hook directory'
fi
cat >"$hooks/pre-commit" <<'HOOK'
#!/bin/sh
exec "$GIT_FORK_HELPER" hook "$GIT_FORK_HOOK_LOG" "$PPID" "$GIT_FORK_HOOK_STATUS"
HOOK
status=$?
if [ "$status" -ne 0 ]; then
  fail 'writing executable hook'
fi
chmod +x "$hooks/pre-commit"
status=$?
if [ "$status" -ne 0 ]; then
  fail 'marking hook executable'
fi
export GIT_FORK_HELPER="$helper"
export GIT_FORK_HOOK_LOG="$hook_log"
export GIT_FORK_HOOK_STATUS=0

must_git 'initializing repository' init -q -b main "$repo"
must_git 'setting repository author name' -C "$repo" config user.name 'Git Fork Runtime'
must_git 'setting repository author email' -C "$repo" config user.email 'git-fork-runtime@example.invalid'
must_git 'disabling commit signing' -C "$repo" config commit.gpgsign false
must_git 'disabling automatic garbage collection' -C "$repo" config gc.auto 0
must_git 'configuring repository hooks' -C "$repo" config core.hooksPath "$hooks"
must_git 'configuring clean filter helper' -C "$repo" config filter.gitfork.clean "$helper filter"
must_git 'configuring smudge filter helper' -C "$repo" config filter.gitfork.smudge "$helper filter"
must_git 'requiring successful filter execution' -C "$repo" config filter.gitfork.required true
printf '%s\n' 'payload.txt filter=gitfork' >"$repo/.gitattributes"
printf '%s\n' 'forked filter preserves this payload' >"$repo/payload.txt"
export GIT_TRACE="$work/filter.trace"
must_git 'adding filtered files' -C "$repo" add .gitattributes payload.txt
unset GIT_TRACE
grep -F "$helper" "$work/filter.trace" >/dev/null 2>&1
status=$?
if [ "$status" -ne 0 ]; then
  fail 'Git did not start the configured external filter helper'
fi
must_git 'initial commit or executable hook failed' -C "$repo" commit -q -m initial
check_hook_log 1
status=$?
if [ "$status" -ne 0 ]; then
  fail 'initial hook did not record one valid child process'
fi
git_head=$(git_value -C "$repo" rev-parse HEAD)
status=$?
if [ "$status" -ne 0 ] || [ -z "$git_head" ]; then
  fail 'reading initial commit id'
fi
"$git_program" -C "$repo" show HEAD:payload.txt >"$work/payload.from-git" \
  2>"$work/show-payload.stderr"
status=$?
if [ "$status" -ne 0 ]; then
  fail 'reading the filtered committed payload'
fi
cmp "$repo/payload.txt" "$work/payload.from-git" >/dev/null 2>&1
status=$?
if [ "$status" -ne 0 ]; then
  fail 'external filter changed the committed payload'
fi
echo 'git fork: external filter pipe and executable commit hook pass'

# A required hook failure must leave HEAD unchanged; a later normal hook commits.
base_head=$git_head
printf '%s\n' 'recovered commit payload' >"$repo/recovery.txt"
must_git 'staging recovery payload' -C "$repo" add recovery.txt
export GIT_FORK_HOOK_STATUS=19
git_run -C "$repo" commit -q -m rejected
rejected_status=$?
if [ "$rejected_status" -eq 0 ]; then
  fail 'commit succeeded despite the hook returning status 19'
fi
check_hook_log 2
status=$?
if [ "$status" -ne 0 ]; then
  fail 'status-19 hook did not run and record its helper process'
fi
head_after_rejection=$(git_value -C "$repo" rev-parse HEAD)
status=$?
if [ "$status" -ne 0 ] || [ "$head_after_rejection" != "$base_head" ]; then
  fail 'failed hook changed the repository HEAD'
fi
"$git_program" -C "$repo" diff --cached --quiet \
  >"$work/staged-check.stdout" 2>"$work/staged-check.stderr"
status=$?
if [ "$status" -ne 1 ]; then
  fail 'failed hook did not leave the rejected change staged'
fi
export GIT_FORK_HOOK_STATUS=0
must_git 'normal hook did not recover the commit path' -C "$repo" commit -q -m recovery
check_hook_log 3
status=$?
if [ "$status" -ne 0 ]; then
  fail 'recovery hook did not record the expected third process'
fi
git_head=$(git_value -C "$repo" rev-parse HEAD)
status=$?
if [ "$status" -ne 0 ] || [ "$git_head" = "$base_head" ]; then
  fail 'successful recovery commit did not advance HEAD'
fi
"$git_program" -C "$repo" diff --cached --quiet \
  >"$work/clean-index.stdout" 2>"$work/clean-index.stderr"
status=$?
if [ "$status" -ne 0 ]; then
  fail 'recovery commit left staged changes'
fi
echo 'git fork: failing hook preserves HEAD and later commit recovers pass'

# --no-local forces the local transport through upload-pack and pack-objects.
clone=$work/clone
export GIT_TRACE="$work/clone.trace"
must_git 'non-local clone failed' clone --no-local --no-checkout "$repo" "$clone"
unset GIT_TRACE
grep -F 'upload-pack' "$work/clone.trace" >/dev/null 2>&1
status=$?
if [ "$status" -ne 0 ]; then
  fail 'non-local clone trace did not include upload-pack'
fi
grep -F 'pack-objects' "$work/clone.trace" >/dev/null 2>&1
status=$?
if [ "$status" -ne 0 ]; then
  fail 'non-local clone trace did not include pack-objects'
fi
clone_head=$(git_value -C "$clone" rev-parse HEAD)
status=$?
if [ "$status" -ne 0 ] || [ "$clone_head" != "$git_head" ]; then
  fail 'non-local clone HEAD differs from the source repository'
fi
must_git 'cloned object database failed fsck' -C "$clone" fsck --full --no-reflogs
must_git 'configuring clone clean filter helper' -C "$clone" config filter.gitfork.clean "$helper filter"
must_git 'configuring clone smudge filter helper' -C "$clone" config filter.gitfork.smudge "$helper filter"
must_git 'requiring successful clone filter execution' -C "$clone" config filter.gitfork.required true
export GIT_TRACE="$work/checkout.trace"
must_git 'checking out the cloned branch failed' -C "$clone" checkout -f main
unset GIT_TRACE
grep -F "$helper" "$work/checkout.trace" >/dev/null 2>&1
status=$?
if [ "$status" -ne 0 ]; then
  fail 'clone checkout did not start the configured smudge filter helper'
fi
cmp "$repo/payload.txt" "$clone/payload.txt" >/dev/null 2>&1
status=$?
if [ "$status" -ne 0 ]; then
  fail 'cloned payload differs from the source payload'
fi
cmp "$repo/recovery.txt" "$clone/recovery.txt" >/dev/null 2>&1
status=$?
if [ "$status" -ne 0 ]; then
  fail 'cloned recovery content differs from the source content'
fi
echo 'git fork: non-local clone upload-pack and pack integrity pass'

# Exercise foreground pack creation and garbage collection, then verify objects.
export GIT_TRACE="$work/repack.trace"
must_git 'foreground repack failed' -C "$repo" repack -ad
unset GIT_TRACE
grep -F 'pack-objects' "$work/repack.trace" >/dev/null 2>&1
status=$?
if [ "$status" -ne 0 ]; then
  fail 'repack trace did not include pack-objects'
fi
must_git 'foreground garbage collection failed' -c gc.autoDetach=false -C "$repo" gc
pack_found=0
for pack in "$repo"/.git/objects/pack/pack-*.pack; do
  if [ -s "$pack" ]; then
    pack_found=1
  fi
done
if [ "$pack_found" -ne 1 ]; then
  fail 'repack/gc did not leave a nonempty pack file'
fi
must_git 'repacked repository failed fsck' -C "$repo" fsck --full --no-reflogs
echo 'git fork: foreground repack and garbage collection integrity pass'

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
