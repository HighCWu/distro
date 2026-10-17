{
  pkgs,
  stdenv,
  src ? pkgs.fetchzip {
    url = "https://github.com/openssl/openssl/releases/download/openssl-3.5.7/openssl-3.5.7.tar.gz";
    hash = "sha256-/xKRDxk7BhrzhcOzazbvkpEje2YejT+9U9QzqjQg1QA=";
  },
  vm-test,
  busybox,
  ca-certificates,
  platform,
  musl,
  llvm-runtimes,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "openssl";
  version = "3.5.7";
  inherit src;
  meta.license = pkgs.lib.licenses.asl20;
  passthru.apk.license = "Apache-2.0 AND MIT AND Apache-2.0 WITH LLVM-exception";

  # Keep apps/speed.c's optional -mlock mode explicitly unsupported. Bounded
  # direct anonymous mappings do not provide locked/protected secure pages.
  # This existing port patch is not a replacement for kernel page protection.
  patches = [ ./speed-no-mlock-on-wasm.patch ];

  # Configure and the generated build scripts are perl; the wasm stdenv brings
  # no interpreter of its own, and #!/usr/bin/env perl has no /usr/bin/env in
  # the sandbox, so hand Configure to the build-platform perl directly.
  nativeBuildInputs = [
    pkgs.perl
    pkgs.nodejs
  ];

  # OpenSSL ships its own perl Configure rather than autotools, so it never
  # reads the stdenv's CONFIG_SITE (the mmap/dlopen answers there are for
  # autoconf). We drive Configure by hand instead of the generic
  # configurePhase, which would append --host/--build/--prefix flags Configure
  # rejects. CC/AR/RANLIB come from the wasm toolchain the stdenv exports.
  #
  # Select the matching generic C target for each pointer width, with no OpenSSL
  # assembly (no asm_arch in this target, so Configure takes the pure-C bignum
  # and hash paths), and uses pthreads, which musl provides on this platform.
  #
  # Disabled, and why each is forced rather than left to detection:
  #   no-shared, no-dso, no-dynamic-engine  -- static-only target, no dlopen;
  #       nothing can be loaded at runtime, so the loader machinery is dead
  #       weight that would also pull in -ldl paths.
  #   no-async     -- the async job scheduler unwinds with makecontext/
  #       swapcontext, which musl does not implement on wasm.
  #   no-afalgeng  -- linux-generic32 enables the AF_ALG kernel-crypto engine
  #       by default; the guest has no AF_ALG socket, and we cannot validate
  #       it, so it is removed.
  #   no-tests     -- the test suite is not built or run in the cross sandbox
  #       (the VM checks below exercise the result instead).
  #   no-secure-memory -- the secure arena requires mlock and page protection,
  #       not merely the platform's bounded direct anonymous mmap support.
  #       CRYPTO_secure_malloc falls back to the ordinary heap; do not present
  #       it as protected/locked storage or claim an equivalent secure arena.
  #   no-apps is deliberately NOT set: the `openssl` CLI is useful userland
  #       and is installed to $out/bin.
  #
  # -DHAVE_FORK=0 compiles out the apps' HTTP/OCSP responder daemon, the only
  # code that calls fork() (absent on this platform); the CLI subcommands we
  # care about do not use it.
  configurePhase = ''
    runHook preConfigure
    perl ./Configure linux-generic${toString platform.addressBits} \
      "CC=$CC" "AR=$AR" "RANLIB=$RANLIB" \
      -DHAVE_FORK=0 \
      --prefix=/ \
      --libdir=lib \
      --openssldir=/etc/ssl \
      no-shared \
      no-dso \
      no-dynamic-engine \
      no-async \
      no-afalgeng \
      no-secure-memory \
      no-tests
    runHook postConfigure
  '';

  enableParallelBuilding = true;

  postBuild = ''
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      apps/openssl ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
  '';

  # install_sw installs the static libs, headers and the openssl binary;
  # install_ssldirs adds the default openssl.cnf the CLI loads (req/genpkey
  # want it present). Documentation targets are skipped: they run pod2man,
  # which is build-host work we do not need for the port.
  installTargets = [
    "install_sw"
    "install_ssldirs"
  ];
  installFlags = [ "DESTDIR=$(out)" ];

  postInstall = ''
    mkdir -p $out/share/licenses/openssl
    cp LICENSE.txt $out/share/licenses/openssl/LICENSE.txt
    cp ${musl.src}/COPYRIGHT $out/share/licenses/openssl/musl-COPYRIGHT
    cp ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT $out/share/licenses/openssl/compiler-rt-LICENSE.TXT
  '';

  # X509_get_default_cert_file() resolves /etc/ssl/cert.pem in the guest. The
  # shared trust bundle is packaged separately because apk-tools uses the same
  # path for HTTPS repositories.
  passthru.apk.depends = [ "ca-certificates" ];

  passthru.checks =
    let
      # A C program linked against the installed libssl.a/libcrypto.a that runs
      # a full TLS handshake in memory (see handshake.c). Proves the libraries
      # are usable by a consumer, not just the bundled CLI.
      handshake = stdenv.mkDerivation {
        pname = "openssl-handshake";
        inherit (finalAttrs) version;
        dontUnpack = true;
        buildInputs = [ finalAttrs.finalPackage ];
        nativeBuildInputs = [ pkgs.nodejs ];
        buildPhase = ''
          $CC -Wall -Wextra -Werror -o handshake ${./tests/handshake.c} \
            -lssl -lcrypto
          $CC -Wall -Wextra -Werror -o verified-handshake ${./tests/verified-handshake.c} \
            -lssl -lcrypto
          for program in handshake verified-handshake; do
            node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
              "$program" ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
          done
        '';
        installPhase = ''
          mkdir -p $out/bin
          cp handshake verified-handshake $out/bin/
          mkdir -p $out/share/licenses/openssl-tests
          cp ${../sdk/LICENSE.MIT} $out/share/licenses/openssl-tests/verified-handshake-MIT
        '';
      };
    in
    {
      cli = vm-test.installedTest {
        name = "openssl-cli";
        init = ./tests/cli-test.sh;
        contents = [
          busybox
          ca-certificates
          finalAttrs.finalPackage
          handshake
        ];
      };
    };
})
