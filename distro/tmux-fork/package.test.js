// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const recipe = readFileSync(join(directory, "package.nix"), "utf8");
const runtime = readFileSync(join(directory, "runtime-test.sh"), "utf8");
const nativeReference = readFileSync(join(directory, "native-reference.sh"), "utf8");

function phase(name) {
  const match = recipe.match(new RegExp(name + "\\s*=\\s*''([\\s\\S]*?)'';"));
  assert.ok(match, "missing " + name);
  return match[1];
}

test("tmux candidate uses pinned upstream sources and target-only static dependencies", () => {
  assert.match(recipe, /inherit \(pkgs\.tmux\) version src/);
  assert.doesNotMatch(recipe, /^\s*patches\s*=/m);
  assert.doesNotMatch(recipe, /dontPatch = true/);
  assert.match(recipe, /autoreconfHook/);
  assert.match(recipe, /CONFIG_SITE=\$\{sdk-fork-automatic-poll-libc\.configSite\}/);
  assert.match(recipe, /CC=\$\{sdk-fork-automatic-poll-libc\}\/bin\/wasm-linux-fork-cc/);
  assert.match(recipe, /-I\$\{libevent-runtime\}\/include -I\$\{ncurses\}\/include/);
  assert.match(recipe, /-L\$\{libevent-runtime\}\/lib -L\$\{ncurses\}\/lib/);
  assert.match(recipe, /PKG_CONFIG_LIBDIR/);
  assert.match(recipe, /--prefix=\/opt\/tmux-fork/);
  assert.match(recipe, /make -j"\$NIX_BUILD_CORES"/);
  assert.match(recipe, /tmux\.c server\.c proc\.c spawn\.c compat\/fdforkpty\.c/);
  assert.match(recipe, /fork\(/);
  assert.match(recipe, /forkpty\(/);
  assert.doesNotMatch(recipe, /wasm-linux-fork-finalize|fork-shim|vfork/);

  for (const option of [
    "--disable-utempter",
    "--disable-utf8proc",
    "--disable-systemd",
    "--disable-cgroups",
    "--with-TERM=tmux-256color",
  ])
    assert.ok(recipe.includes('"' + option + '"'), "missing configure option " + option);

  const build = phase("buildPhase");
  assert.match(build, /node --test \$\{\.\/\.\}\/package\.test\.js/);
  assert.match(build, /cmp "\$\{pkgs\.tmux\.src\}\/\$source_file"/);
  assert.match(build, /linux_user_poll_v2/);
  assert.match(recipe, /ncurses\.src\}\/COPYING/);
  assert.match(recipe, /libevent-runtime\.src\}\/LICENSE/);
  assert.match(recipe, /libevent-runtime\.buildMaterials/);
  assert.match(recipe, /fork-sdk/);
  assert.match(recipe, /installedTest/);
  assert.match(recipe, /meta\s*=\s*\{[\s\S]*?outputsToInstall\s*=\s*\[\s*"out"\s*\];/);
});

test("runtime requires socket server, real pane execution, PTY evidence, and restart", () => {
  assert.match(runtime, /mount -t devtmpfs devtmpfs \/dev/);
  assert.match(runtime, /mount -t proc proc \/proc/);
  assert.match(runtime, /mount -t devpts devpts \/dev\/pts/);
  assert.match(runtime, /new-session -d -s/);
  assert.match(runtime, /send-keys -l/);
  assert.match(runtime, /pane-result/);
  assert.match(runtime, /pane-ready/);
  assert.match(runtime, /capture-pane -p/);
  assert.match(runtime, /pane_pid/);
  assert.match(runtime, /pane_tty/);
  assert.match(runtime, /kill-server/);
  assert.match(runtime, /server_process_alive/);
  assert.match(runtime, /wait_for_server_exit/);
  assert.match(runtime, /-N has-session -t "\$session_name"/);
  assert.match(runtime, /old_server_pid=\$server_pid/);
  assert.match(runtime, /\[ "\$server_pid" != "\$old_server_pid" \]/);
  assert.match(runtime, /restart new-session -d/);
  assert.match(runtime, /server_pid/);
  assert.match(runtime, /trap cleanup 0/);
  assert.match(runtime, /watchdog/);
  const killedServer = runtime.indexOf("run_tmux stage3-kill-server kill-server");
  const waitedForExit = runtime.indexOf("wait_for_server_exit || fail 'server process remained");
  const checkedStaleSocket = runtime.indexOf("run_tmux stage3-stale-socket-check -N has-session");
  const restartedServer = runtime.indexOf("run_tmux stage3-restart new-session");
  assert.ok(
    killedServer >= 0 &&
      killedServer < waitedForExit &&
      waitedForExit < checkedStaleSocket &&
      checkedStaleSocket < restartedServer,
    "kill-server must exit, stale socket must be checked, then tmux must restart",
  );
  assert.match(nativeReference, /TMUX_FORK_PROGRAM/);
  assert.match(nativeReference, /NATIVE_REFERENCE=1/);
  assert.match(nativeReference, /runtime-test\.sh/);
});
