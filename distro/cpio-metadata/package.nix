# SPDX-License-Identifier: MIT
{
  pkgs,
  sdk,
  platform,
  kernel,
  vm-test,
}:

let
  init =
    pkgs.runCommand "cpio-metadata-init-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          sdk
          pkgs.nodejs
        ];
      }
      ''
        ${sdk}/bin/wasm-linux-cc -std=c11 -O2 -Wall -Wextra -Werror \
          ${./runtime.c} -o init
        node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
          init ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
        mkdir -p $out/bin
        install -m 0755 init $out/bin/init
      '';

  initramfs =
    pkgs.runCommand "cpio-metadata-${platform.wasmArch}.cpio"
      {
        nativeBuildInputs = [
          pkgs.coreutils
          pkgs.cpio
          pkgs.findutils
        ];
      }
      ''
        mkdir -p root/metadata/cpio/sub
        printf 'initramfs metadata payload\n' > root/metadata/cpio/file
        ln root/metadata/cpio/file root/metadata/cpio/hardlink
        ln -s file root/metadata/cpio/symlink
        printf 'nested payload\n' > root/metadata/cpio/sub/nested

        chmod 0750 root/metadata/cpio
        chmod 0640 root/metadata/cpio/file
        chmod 0710 root/metadata/cpio/sub
        chmod 0600 root/metadata/cpio/sub/nested
        touch -h -d @1600000000 \
          root/metadata/cpio/file \
          root/metadata/cpio/hardlink \
          root/metadata/cpio/symlink \
          root/metadata/cpio/sub/nested \
          root/metadata/cpio/sub \
          root/metadata/cpio
        cp ${init}/bin/init root/init
        chmod 0755 root/init

        cd root
        find . -print0 | sort -z | cpio --null --reproducible --owner=0:0 -H newc -o > $out
      '';

  runtime =
    pkgs.runCommand "vm-test-cpio-metadata-${platform.wasmArch}"
      {
        nativeBuildInputs = [ pkgs.nodejs ];
        passthru.ci.heavy = true;
      }
      ''
        timeout --kill-after=5 300 node ${vm-test.runner}/run-test.js \
          --cpus 1 ${kernel}/dist/index.js ${initramfs}
        mkdir -p $out
      '';
in
init.overrideAttrs (old: {
  passthru = (old.passthru or { }) // {
    checks.runtime = runtime;
  };
})
