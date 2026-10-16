# SPDX-License-Identifier: MIT
{
  apk,
  apk-wasm64,
  busybox-wasm64,
  image,
  platform-wasm64,
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
  package = apk.mkPackage {
    name = "linux-guest-agent-native";
    version = "0-r0";
    arch = platform-wasm64.apkArch;
    license = "MIT";
    payload = agent;
  };
  repository = apk.mkRepository {
    name = "native-agent-boot";
    arch = platform-wasm64.apkArch;
    packages.agent = package;
  };
  bootFilesystem = image.mkFilesystem {
    name = "native-agent-wasm64-boot";
    label = "LOWLAND_AGENT";
    root = apk.mkSystem {
      name = "native-agent-wasm64-boot";
      arch = platform-wasm64.apkArch;
      repositories = [ repository ];
      packages = [ package ];
      files = {
        "/init" = {
          source = "${agent}/bin/linux-guest-agent";
          mode = "0755";
        };
        "/lower/.mountpoint" = pkgs.emptyFile;
        "/overlay/.mountpoint" = pkgs.emptyFile;
      };
    };
  };
in
agent
// {
  inherit bootFilesystem;
  # A real minimal system root, without runtime-child or test marker files.
  # Keep it independent of the default wasm32 distribution repository.
  rootfs = import ../npm/linux-guest/rootfs.nix {
    inherit image pkgs;
    apk = apk-wasm64;
    busybox = busybox-wasm64;
    # Identity lookup for the existing root process, not login credentials.
    extraFiles = {
      "/etc/passwd" = pkgs.writeText "passwd" ''
        root:x:0:0:root:/root:/bin/sh
      '';
      "/etc/group" = pkgs.writeText "group" ''
        root:x:0:
      '';
    };
    extraLinks."/etc/mtab" = "/proc/mounts";
    repository = apk-wasm64.mkRepository {
      name = "native-wasm64-minimal";
      arch = platform-wasm64.apkArch;
      packages.busybox = busybox-wasm64;
    };
  };
  # Native PID 1 directly; no wasm32 shell or BusyBox in this boot image.
  bootDisk = image.mkGptDisk {
    name = "native-agent-wasm64.img";
    filesystem = bootFilesystem;
    partitionLabel = "LOWLAND_AGENT";
  };
  # The unmodified production entry point, not runtime-init.c. It discovers
  # LOWLAND_ROOT and pivots into that filesystem before accepting sessions.
  bootInitramfs = image.mkInitramfs {
    name = "native-agent-wasm64";
    init = "${agent}/bin/linux-guest-agent";
    files."/mnt/.mountpoint" = pkgs.emptyFile;
  };
}
