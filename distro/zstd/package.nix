{
  pkgs,
  stdenv,
  src ? pkgs.fetchzip {
    url = "https://github.com/facebook/zstd/releases/download/v1.5.6/zstd-1.5.6.tar.gz";
    hash = "sha256-qcd92hQqVBjMT3hyntjcgk29o9wGQsg5Hg7HE5C0UNc=";
  },
  busybox,
  musl,
  llvm-runtimes,
  platform,
  image,
  vm-test,
  vm-test-file,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "zstd";
  version = "1.5.6";
  inherit src;
  meta.license = pkgs.lib.licenses.bsd3;
  passthru.apk.license = "BSD-3-Clause AND MIT AND Apache-2.0 WITH LLVM-exception";
  nativeBuildInputs = [ pkgs.nodejs ];

  # Only the CLI is wanted, and building just `programs/zstd` links the library
  # sources straight into a static binary, sidestepping the shared-library
  # targets that `make install` would otherwise build for this no-shared-libs
  # platform. HAVE_PTHREAD=0 keeps this a single-threaded pass.
  makeFlags = [
    "-C"
    "programs"
    "CC=${stdenv.cc.targetPrefix}cc"
    "HAVE_PTHREAD=0"
    "zstd"
  ];

  patches = [ ./mmap.patch ];

  postBuild = ''
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      programs/zstd ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 programs/zstd $out/bin/zstd
    for alias in unzstd zstdcat; do
      ln -s zstd $out/bin/$alias
    done
    mkdir -p $out/share/licenses/zstd
    cp LICENSE $out/share/licenses/zstd/LICENSE-BSD
    cp ${musl.src}/COPYRIGHT $out/share/licenses/zstd/musl-COPYRIGHT
    cp ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT $out/share/licenses/zstd/compiler-rt-LICENSE.TXT
    runHook postInstall
  '';

  passthru.checks = {
    roundtrip = vm-test.installedTest {
      name = "zstd-roundtrip";
      init = ./roundtrip-test.sh;
      contents = [
        finalAttrs.finalPackage
        busybox
      ];
    };
    file =
      let
        # finalPackage has overrideAttrs, not callPackage's outer override.
        # Use the ordinary platform's private execution export, not special
        # application link flags. Omit recursive checks on the variant.
        candidate = finalAttrs.finalPackage.overrideAttrs (previous: {
          passthru = builtins.removeAttrs (previous.passthru or { }) [ "checks" ];
        });
        dictionaries =
          pkgs.runCommand "zstd-mmap-dictionaries.erofs" { nativeBuildInputs = [ pkgs.erofs-utils ]; }
            ''
              mkdir root
              for size in 65535 65536 65537 131071 131072 131073; do
                head -c "$size" /dev/zero > root/dictionary-$size
              done
              mkfs.erofs --all-root -T 0 -x-1 "$out" root
            '';
      in
      pkgs.runCommand "zstd-file-mmap-checks-${platform.wasmArch}"
        {
          passthru.ci.heavy = true;
          passthru.browserAssets = {
            initramfs = image.mkInitramfs {
              name = "zstd-file-mmap-${platform.wasmArch}-initramfs";
              init = ./file-mmap-test.sh;
              contents = [
                candidate
                busybox
              ];
            };
            disk = dictionaries;
          };
          mapped = vm-test-file.rawInitramfsTest {
            name = "zstd-file-mmap-${platform.wasmArch}";
            init = ./file-mmap-test.sh;
            contents = [
              candidate
              busybox
            ];
            disks = [
              dictionaries
              dictionaries
            ];
            snapshotFirstDisk = true;
            readOnlyDisks = true;
          };
          # Having the export must not open the default kernel's mmap policy.
          releaseConfig = vm-test.installedTest {
            name = "zstd-export-default-${platform.wasmArch}";
            init = ./roundtrip-test.sh;
            contents = [
              candidate
              busybox
            ];
          };
        }
        ''
          mkdir $out
          ln -s "$mapped" $out/mapped
          ln -s "$releaseConfig" $out/default
        '';
  };
})
