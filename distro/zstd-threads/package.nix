# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  stdenv,
  platform,
  sdk,
  zstd,
  llvm-toolchain,
  vm-test,
  busybox,
  extraChecks ? { },
}:
stdenv.mkDerivation (finalAttrs: {
  pname = "zstd-threads";
  inherit (zstd) version src;
  outputs = [
    "out"
    "buildMaterials"
  ];

  patches = [ ../zstd/mmap.patch ];

  nativeBuildInputs = [
    sdk
    pkgs.nodejs
  ];

  makeFlags = [
    "-C"
    "programs"
    "CC=${sdk}/bin/wasm-linux-cc"
    "HAVE_PTHREAD=1"
    "zstd"
  ];

  postBuild = ''
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      programs/zstd ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    printf '%s\n' '${zstd.version}' > zstd-source-version.txt
    test -x ${llvm-toolchain}/bin/clang
    test -x ${llvm-toolchain}/bin/wasm-ld
    ${sdk}/bin/wasm-linux-cc --version | sed -n '1p' > sdk-compiler-version.txt
    ${llvm-toolchain}/bin/clang --version | sed -n '1p' > llvm-toolchain-version.txt
    ${sdk}/bin/wasm-linux-cc -O2 -Wall -Wextra -Werror \
      ${./runtime.c} -o zstd-threads-runtime.wasm
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      zstd-threads-runtime.wasm ${toString platform.addressBits} \
      ${toString platform.maximumMemoryBytes}
  '';

  installPhase = ''
        runHook preInstall
        zstd_bin="$out/opt/zstd-threads/bin/zstd"
        install -Dm755 programs/zstd "$zstd_bin"
        ln -s zstd "$(dirname "$zstd_bin")/unzstd"
        ln -s zstd "$(dirname "$zstd_bin")/zstdcat"

        node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
          "$zstd_bin" ${toString platform.addressBits} \
          ${toString platform.maximumMemoryBytes}
        install -Dm755 zstd-threads-runtime.wasm \
          "$out/libexec/zstd-threads/runtime.wasm"

        notices="$out/share/licenses/zstd-threads"
        mkdir -p "$notices"
        cp ${zstd.src}/LICENSE "$notices/LICENSE-BSD"
        cp ${zstd.src}/COPYING "$notices/COPYING-GPLv2"
        cp ${../sdk/LICENSE.MIT} "$notices/LOCAL-ADDITIONS.MIT"
        cp ${sdk}/share/linux-wasm-sdk/licenses/SDK-MIT.txt "$notices/SDK-MIT.txt"
        cp -r ${sdk}/share/linux-wasm-sdk/licenses "$notices/standard-sdk"

        materials="$buildMaterials/share/zstd-threads-materials"
        mkdir -p "$materials/licenses/upstream"
    cp ${./package.nix} ${./runtime.c} \
          ${../busybox/check-binary.mjs} \
          ${../../packages/kernel/src/wasm_binary.ts} \
          programs/zstd zstd-threads-runtime.wasm zstd-source-version.txt \
          sdk-compiler-version.txt llvm-toolchain-version.txt \
          "$materials/"
        cp ${zstd.src}/LICENSE "$materials/licenses/upstream/LICENSE-BSD"
        cp ${zstd.src}/COPYING "$materials/licenses/upstream/COPYING-GPLv2"
        cp ${../sdk/LICENSE.MIT} "$materials/LOCAL-ADDITIONS.MIT"
        cp ${sdk}/share/linux-wasm-sdk/licenses/SDK-MIT.txt "$materials/SDK-MIT.txt"
        cp -r ${sdk}/share/linux-wasm-sdk/licenses "$materials/standard-sdk-licenses"
        ln -s ${zstd.src} "$materials/source"
        cp ${../zstd/package.nix} "$materials/zstd-source-package.nix"
        ln -s ${sdk.buildMaterials} "$materials/standard-sdk"
        install -Dm755 "$zstd_bin" "$materials/bin/zstd"
        cat > "$materials/build-config.txt" <<'EOF'
    source: Zstandard ${zstd.version} from the distro zstd source pin
    threaded CLI: make -C programs CC=${sdk}/bin/wasm-linux-cc HAVE_PTHREAD=1 zstd
    runtime: zstd -q -T2 -B256K -1 -k -c input
    EOF
        runHook postInstall
  '';

  meta = {
    description = "Zstandard CLI with POSIX multithreaded compression";
    homepage = "https://facebook.github.io/zstd/";
    license = lib.licenses.bsd3;
  };

  passthru.apk.license = "BSD-3-Clause AND MIT AND Apache-2.0 WITH LLVM-exception";
  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "zstd-threads-${platform.wasmArch}";
      init = "${finalAttrs.finalPackage}/libexec/zstd-threads/runtime.wasm";
      contents = [ busybox ];
      files = {
        "/usr/bin/zstd" = "${finalAttrs.finalPackage}/opt/zstd-threads/bin/zstd";
      };
      cpus = 2;
    };
  }
  // extraChecks;
})
