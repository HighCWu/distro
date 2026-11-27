{
  pkgs,
  lib,
  stdenv,
  src ? pkgs.fetchzip {
    url = "https://astron.com/pub/file/file-5.48.tar.gz";
    hash = "sha256-9OtdGy2HegeyiCVUuDo75A0REr+Z0ReR3jk2ORVAgp0=";
  },
  zlib,
  vm-test,
  busybox,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "file";
  version = "5.48";
  inherit src;
  passthru.apk.replaces = [ "busybox" ];

  buildInputs = [ zlib ];

  # Cross builds cannot run the freshly built target `file` to compile the
  # magic database, so use a build-platform file of the same version. The
  # pinned source and pkgs.file must stay in lockstep.
  makeFlags = [
    "FILE_COMPILE=${lib.getExe pkgs.file}"
    # APK payloads are rooted at /, so compile the guest path rather than the
    # Nix build-time prefix into libmagic.
    "pkgdatadir=/usr/share/misc"
  ];

  configureFlags = [
    "--disable-shared"
    "--enable-static"
    "--disable-libseccomp"
  ];

  postInstall = ''
    pc="$out/lib/pkgconfig/libmagic.pc"
    if ! grep -Eq '^(Requires\.private:.*\bzlib\b|Libs\.private:.*-lz([[:space:]]|$))' "$pc"; then
      substituteInPlace "$pc" \
        --replace-fail 'Cflags:' $'Requires.private: zlib\nCflags:'
    fi
  '';

  passthru.checks =
    let
      # Sample files of known types for the detection test.
      fixtures = pkgs.runCommand "file-test-fixtures" { } ''
        mkdir -p $out/fixtures
        printf 'hello, this is plain ascii text\n' > $out/fixtures/hello.txt
        printf 'hello gzip payload\n' | ${pkgs.gzip}/bin/gzip -c > $out/fixtures/hello.gz
      '';
      client = stdenv.mkDerivation {
        pname = "libmagic-static-pkg-config-client";
        version = "1";
        dontUnpack = true;
        nativeBuildInputs = [ pkgs.pkg-config ];
        buildPhase = ''
          runHook preBuild
          export PKG_CONFIG_LIBDIR=${finalAttrs.finalPackage}/lib/pkgconfig:${zlib}/lib/pkgconfig
          export PKG_CONFIG_PATH=
          export PKG_CONFIG_SYSTEM_INCLUDE_PATH=
          export PKG_CONFIG_SYSTEM_LIBRARY_PATH=
          flags=$(pkg-config --static --cflags --libs libmagic)
          read -ra linkFlags <<<"$flags"
          $CC -Wall -Wextra -Werror ${./linked-client.c} "''${linkFlags[@]}" -o libmagic-static-client
          runHook postBuild
        '';
        installPhase = ''
          runHook preInstall
          install -Dm755 libmagic-static-client "$out/bin/libmagic-static-client"
          runHook postInstall
        '';
      };
    in
    {
      detect = vm-test.installedTest {
        name = "file-detect";
        init = ./detect-test.sh;
        contents = [
          finalAttrs.finalPackage
          busybox
          fixtures
        ];
      };
      libmagic = vm-test.installedTest {
        name = "file-libmagic";
        init = ./linked-client-test.sh;
        contents = [
          finalAttrs.finalPackage
          busybox
          client
        ];
      };
    };
})
