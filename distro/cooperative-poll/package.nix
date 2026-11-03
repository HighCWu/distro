# SPDX-License-Identifier: MIT
{
  pkgs,
  platform,
  sdk-cooperative-poll,
  vm-test,
  cpuTimers ? false,
  libraryCoverage ? false,
  extraChecks ? { },
}:
let
  suffix =
    if cpuTimers then
      "-cpu"
    else if libraryCoverage then
      "-libc"
    else
      "";
  program =
    pkgs.runCommand "cooperative-poll${suffix}-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          sdk-cooperative-poll
          pkgs.nodejs
        ];
        passthru.checks = {
          runtime = vm-test.rawInitramfsTest {
            name = "cooperative-poll${suffix}-${platform.wasmArch}";
            init = "${program}/cooperative-poll.wasm";
            files."/poll-helper" = "${program}/cooperative-poll.wasm";
            cpus = 2;
          };
        }
        // extraChecks;
      }
      ''
        mkdir $out
        wasm-linux-cc ${if cpuTimers then "-DCOOPERATIVE_CPU_TIMERS=1" else ""} \
          ${if libraryCoverage then "-DCOOPERATIVE_LIBRARY_POLL=1" else ""} \
          -O2 -pthread -Wall -Wextra -Werror ${./runtime.c} -o $out/cooperative-poll.wasm
        node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
          $out/cooperative-poll.wasm ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
        chmod 0755 $out/cooperative-poll.wasm
      '';
in
program
