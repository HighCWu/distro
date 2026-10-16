# SPDX-License-Identifier: MIT
{
  image,
  pkgs,
  sdk-wasm64,
}:
let
  agent =
    pkgs.runCommand "linux-guest-agent-wasm64"
      {
        meta.license = pkgs.lib.licenses.mit;
        allowedReferences = [ ];
      }
      ''
        mkdir -p $out/bin
        ${sdk-wasm64}/bin/wasm-linux-cc -Wall -Wextra -Werror -pthread \
          -include ${./native-wasm64.h} \
          ${./agent.c} -o $out/bin/linux-guest-agent
        notices=$out/share/licenses/linux-guest-agent
        mkdir -p "$notices"
        cp ${../../license.md} "$notices/MIT.txt"
        cp ${./native-notices.md} "$notices/README.md"
        cp ${sdk-wasm64}/share/linux-wasm-sdk/licenses/musl/COPYRIGHT "$notices/musl-COPYRIGHT"
        cp ${sdk-wasm64}/share/linux-wasm-sdk/licenses/llvm-runtimes/compiler-rt-LICENSE.TXT \
          "$notices/compiler-rt-LICENSE.TXT"
      '';
in
agent
// {
  # The unmodified production entry point, not runtime-init.c. It discovers
  # LOWLAND_ROOT and pivots into that filesystem before accepting sessions.
  bootInitramfs = image.mkInitramfs {
    name = "native-agent-wasm64";
    init = "${agent}/bin/linux-guest-agent";
    files."/mnt/.mountpoint" = pkgs.emptyFile;
  };
}
