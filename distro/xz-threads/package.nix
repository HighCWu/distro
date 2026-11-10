# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  stdenv,
  platform,
  sdk,
  vm-test,
  xz,
  extraChecks ? { },
}:
stdenv.mkDerivation (finalAttrs: {
  pname = "xz-threads";
  inherit (xz) version src;
  outputs = [
    "out"
    "buildMaterials"
  ];
  setOutputFlags = false;
  moveToDev = false;
  installFlags = [ "DESTDIR=$(out)" ];
  nativeBuildInputs = [
    sdk
    pkgs.nodejs
  ];

  configureFlags = [
    "--prefix=/opt/xz-threads"
    "--enable-threads=posix"
    "--disable-shared"
    "--disable-nls"
    "--disable-sandbox"
    "--disable-doc"
    "--disable-scripts"
  ];

  postConfigure = ''
    actual_version="$(cd ${xz.src} && sh build-aux/version.sh)"
    test "$actual_version" = "${xz.version}"
    printf '%s\n' "$actual_version" > xz-source-version.txt
  '';

  postBuild = ''
    wasm-linux-cc -O2 -Wall -Wextra -Werror \
      ${./runtime.c} -o xz-threads-runtime.wasm
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      xz-threads-runtime.wasm ${toString platform.addressBits} \
      ${toString platform.maximumMemoryBytes}
  '';

  postInstall = ''
        xz_bin="$out/opt/xz-threads/bin/xz"
        test -x "$xz_bin"
        test -s "$out/opt/xz-threads/lib/liblzma.a"
        node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
          "$xz_bin" ${toString platform.addressBits} \
          ${toString platform.maximumMemoryBytes}

        install -Dm755 xz-threads-runtime.wasm \
          "$out/libexec/xz-threads/runtime.wasm"
        install -Dm644 ${./runtime.c} "$out/share/xz-threads/runtime.c"
        cp ${./package.nix} "$out/share/xz-threads/package.nix"
        notices="$out/share/licenses/xz-threads"
        mkdir -p "$notices/upstream"
        cp ${xz.src}/COPYING* "$notices/upstream/"
        cp -r ${sdk}/share/linux-wasm-sdk/licenses "$notices/standard-sdk"
        cp ${sdk}/share/linux-wasm-sdk/licenses/SDK-MIT.txt "$notices/SDK-MIT.txt"
        cp ${../sdk/LICENSE.MIT} "$notices/LOCAL-ADDITIONS.MIT"

        materials="$buildMaterials/share/xz-threads-materials"
        mkdir -p "$materials/licenses/upstream"
        cp ${./package.nix} ${./runtime.c} \
          ${../busybox/check-binary.mjs} \
          ${../../packages/kernel/src/wasm_binary.ts} \
          xz-threads-runtime.wasm xz-source-version.txt \
          "$materials/"
        cp ${xz.src}/COPYING* "$materials/licenses/upstream/"
        cp -r ${sdk}/share/linux-wasm-sdk/licenses "$materials/standard-sdk-licenses"
        cp ${sdk}/share/linux-wasm-sdk/licenses/SDK-MIT.txt "$materials/SDK-MIT.txt"
        cp ${../sdk/LICENSE.MIT} "$materials/LOCAL-ADDITIONS.MIT"
        ln -s ${xz.src} "$materials/source"
        ln -s ${sdk.buildMaterials} "$materials/standard-sdk"
        install -Dm755 "$xz_bin" "$materials/bin/xz"
        install -Dm644 "$out/opt/xz-threads/lib/liblzma.a" \
          "$materials/lib/liblzma.a"
        install -Dm644 config.log "$materials/config.log"
        cp ${../xz/package.nix} "$materials/xz-source-package.nix"
        cat > "$materials/build-config.txt" <<'EOF'
    source: XZ Utils ${xz.version} from the distro xz source pin
    configure: --prefix=/opt/xz-threads --enable-threads=posix --disable-shared --disable-nls --disable-sandbox --disable-doc --disable-scripts
    compile: wasm-linux-cc -O2 -Wall -Wextra -Werror runtime.c -o xz-threads-runtime.wasm
    runtime: xz --block-size=64KiB -T2 -1 -k -c input
    EOF
  '';

  meta = {
    description = "XZ Utils with POSIX multithreaded compression and decompression";
    homepage = "https://tukaani.org/xz/";
    license = with lib.licenses; [
      bsd0
      lgpl21Plus
    ];
  };

  passthru.apk.license = "0BSD AND LGPL-2.1-or-later AND MIT AND Apache-2.0 WITH LLVM-exception";
  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "xz-threads-${platform.wasmArch}";
      init = "${finalAttrs.finalPackage}/libexec/xz-threads/runtime.wasm";
      files = {
        "/usr/bin/xz" = "${finalAttrs.finalPackage}/opt/xz-threads/bin/xz";
      };
      cpus = 2;
    };
  }
  // extraChecks;
})
