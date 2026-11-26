{
  pkgs,
  stdenv,
  src ? pkgs.fetchzip {
    url = "https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-1.7.1.tar.gz";
    hash = "sha256-Ti1rQ7Va0oTE4Z0ouYfQS+yMNX3nFQtHfVkIYBHg3O4=";
  },
  vm-test,
  busybox,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "jq";
  version = "1.7.1";
  inherit src;

  dontDisableStatic = true;
  configureFlags = [
    "--disable-shared"
    "--disable-docs"
    # No cross-built system oniguruma exists; build the bundled copy as a
    # sub-package so regex filters keep working.
    "--with-oniguruma=builtin"
  ];

  postInstall = ''
    # libtool can leave the bundled regex code in a separate archive.
    # Generate static link flags from the installed target archives.
    llvm-nm --defined-only "$out/lib/libjq.a" > libjq-symbols
    privateLibs=-lm
    if ! grep -Eq '[[:space:]]T[[:space:]]onig_new$' libjq-symbols; then
      llvm-nm --defined-only "$out/lib/libonig.a" > libonig-symbols
      grep -Eq '[[:space:]]T[[:space:]]onig_new$' libonig-symbols
      privateLibs="-lonig $privateLibs"
    fi
    substituteInPlace "$out/lib/pkgconfig/libjq.pc" \
      --replace-fail 'Cflags:' "Libs.private: $privateLibs"$'\nCflags:'
  '';

  passthru.checks =
    let
      check =
        name: init:
        vm-test.installedTest {
          name = "jq-${name}";
          inherit init;
          contents = [
            finalAttrs.finalPackage
            busybox
          ];
        };
      client = stdenv.mkDerivation {
        pname = "libjq-static-pkg-config-client";
        version = "1";
        dontUnpack = true;
        nativeBuildInputs = [ pkgs.pkg-config ];
        buildPhase = ''
          runHook preBuild
          export PKG_CONFIG_LIBDIR=${finalAttrs.finalPackage}/lib/pkgconfig
          export PKG_CONFIG_SYSROOT_DIR=${finalAttrs.finalPackage}
          export PKG_CONFIG_PATH=
          export PKG_CONFIG_SYSTEM_INCLUDE_PATH=
          export PKG_CONFIG_SYSTEM_LIBRARY_PATH=
          flags=$(pkg-config --static --cflags --libs libjq)
          read -ra linkFlags <<<"$flags"
          $CC -Wall -Wextra -Werror ${./linked-client.c} "''${linkFlags[@]}" -o libjq-static-client
          runHook postBuild
        '';
        installPhase = ''
          runHook preInstall
          install -Dm755 libjq-static-client "$out/bin/libjq-static-client"
          runHook postInstall
        '';
      };
    in
    {
      filters = check "filters" ./filters-test.sh;
      libjq = vm-test.installedTest {
        name = "jq-libjq";
        init = ./linked-client-test.sh;
        recordRuntimeLog = true;
        contents = [
          busybox
          client
        ];
      };
    };
})
