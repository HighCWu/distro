{
  pkgs,
  stdenv,
  src ? pkgs.fetchzip {
    url = "https://curl.se/download/curl-8.21.0.tar.xz";
    hash = "sha256-nrvbU5C6oeCMAecrEqYE3CNPyFVsTEqaqhhCoLe5fMo=";
  },
  openssl,
  ca-certificates,
  zlib,
  vm-test,
  busybox,
  platform,
  image,
  sdk,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "curl";
  version = "8.21.0";
  inherit src;
  meta.license = pkgs.lib.licenses.curl;
  passthru.apk.license = "curl AND Zlib AND Apache-2.0 AND MIT AND Apache-2.0 WITH LLVM-exception";

  buildInputs = [
    openssl
    zlib
  ];

  # curl's configure resolves OpenSSL through pkg-config whenever the staged
  # openssl.pc is reachable, and falls back to --with-openssl path probing when
  # pkg-config is absent. Those two paths embed different locations into the
  # installed metadata, so pkg-config's presence is part of the build contract:
  # declare it to make the resolution -- and therefore the produced metadata --
  # deterministic regardless of the build environment.
  nativeBuildInputs = [
    pkgs.pkg-config
    pkgs.nodejs
  ];

  # Static-only, OpenSSL backend, zlib for content encoding. Everything that
  # would pull in an unavailable transport or a library we do not ship is
  # turned off explicitly so the cross configure cannot latch onto a stray
  # host copy. Plain HTTP/HTTPS/FILE transfers need no fork; the threaded
  # resolver is disabled so name lookups stay in-process (numeric addresses
  # in the Linux check resolve without DNS regardless). Direct HTTPS uses
  # OpenSSL and the distribution CA bundle unless --cacert overrides it. The
  # optional host Fetch adapter is a separate plaintext HTTP transport, not a TLS tunnel.
  configureFlags = [
    "--disable-shared"
    "--enable-static"
    "--with-openssl=${openssl}"
    "--with-zlib=${zlib}"
    "--enable-http"
    "--enable-file"
    "--disable-threaded-resolver"
    "--disable-ares"
    "--disable-ldap"
    "--disable-ldaps"
    "--disable-manual"
    "--disable-docs"
    "--disable-ntlm"
    "--without-brotli"
    "--without-zstd"
    "--without-libpsl"
    "--without-libidn2"
    "--without-nghttp2"
    "--without-nghttp3"
    "--without-ngtcp2"
    "--without-libssh2"
    "--without-libssh"
    "--with-ca-bundle=/etc/ssl/cert.pem"
    "--without-ca-path"
    "--without-ca-embed"
  ];

  postBuild = ''
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      src/curl ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
  '';

  postInstall = ''
    mkdir -p $out/share/licenses/curl
    cp COPYING $out/share/licenses/curl/curl-COPYING
    cp ${../sdk/LICENSE.MIT} $out/share/licenses/curl/integration-MIT
    cp ${zlib.src}/zlib.h $out/share/licenses/curl/zlib.h
    cp ${openssl}/share/licenses/openssl/LICENSE.txt $out/share/licenses/curl/openssl-LICENSE.txt
    cp ${openssl}/share/licenses/openssl/musl-COPYRIGHT $out/share/licenses/curl/musl-COPYRIGHT
    cp ${openssl}/share/licenses/openssl/compiler-rt-LICENSE.TXT $out/share/licenses/curl/compiler-rt-LICENSE.TXT
  '';

  # Configure must find the Nix-staged OpenSSL and zlib while cross-building,
  # but the installed metadata (curl-config, libcurl.la, libcurl.pc) describes
  # the guest runtime. The build-time prefixes leak in through --with-openssl
  # and --with-zlib: curl-config echoes the full configure line, zlib's
  # detection records -L$prefix/lib, and OpenSSL's pkg-config metadata may or
  # may not have been used. Rewrite the two known build roots to the guest FHS
  # root wherever they appear. --replace-quiet, not --replace-fail, is
  # deliberate: pkg-config already yields guest paths for a file in some
  # configurations, and the build must not depend on which resolution path
  # configure took.
  postFixup = ''
    substituteInPlace "$out/bin/curl-config" "$out/lib/libcurl.la" \
      --replace-quiet "${openssl}/lib" /lib \
      --replace-quiet "${openssl}/include" /include \
      --replace-quiet "${zlib}/lib" /lib \
      --replace-quiet "${zlib}/include" /include \
      --replace-quiet ${openssl} / \
      --replace-quiet ${zlib} /
    substituteInPlace "$out/lib/pkgconfig/libcurl.pc" \
      --replace-quiet "${openssl}/lib" /lib \
      --replace-quiet "${openssl}/include" /include \
      --replace-quiet ${openssl} /
  '';

  passthru.apk.depends = [
    "busybox"
    "ca-certificates"
  ];

  # A separate, copyable development installation. Do not move headers or
  # curl-config out of the existing runtime output as part of this addition.
  passthru.development =
    pkgs.runCommand "libcurl-development-${platform.wasmArch}"
      {
        nativeBuildInputs = [ pkgs.nodejs ];
        passthru.apk.license = finalAttrs.passthru.apk.license;
      }
      ''
        mkdir -p $out/include $out/lib/pkgconfig $out/share/licenses $out/share/doc/libcurl/examples
        for package in ${finalAttrs.finalPackage} ${openssl} ${zlib}; do
          cp -rL "$package/include/." $out/include/
          cp "$package"/lib/*.a $out/lib/
          install -m644 "$package"/lib/pkgconfig/*.pc "$out/lib/pkgconfig/"
        done
        # Keep upstream static dependency declarations, but use the copied layout.
        node ${./relocate-metadata.mjs} $out ${finalAttrs.finalPackage} ${openssl} ${zlib}
        cp -r ${finalAttrs.finalPackage}/share/licenses/curl $out/share/licenses/
        cp ${./fetch-example.c} $out/share/doc/libcurl/examples/fetch.c
        cp ${./CMakeLists.txt} $out/share/doc/libcurl/examples/CMakeLists.txt
        cp ${./development-README.md} $out/share/doc/libcurl/examples/README.md
        cp ${../sdk/LICENSE.MIT} $out/share/doc/libcurl/examples/LICENSE.MIT
      '';

  passthru.developmentApplication =
    pkgs.runCommand "libcurl-installed-application-${platform.wasmArch}"
      {
        nativeBuildInputs = [ pkgs.nodejs ];
        passthru.apk.license = finalAttrs.passthru.apk.license;
      }
      ''
        mkdir -p $out/bin $out/share/licenses relocated
        cp -r ${finalAttrs.finalPackage.development}/. original/
        chmod u+w original
        mv original relocated/installation
        export WASM_PKG_CONFIG_PATH="$PWD/relocated/installation/lib/pkgconfig"
        export WASM_PKG_CONFIG_SYSROOT_DIR=/
        cflags_text=$(${sdk}/bin/wasm-linux-pkg-config --cflags libcurl)
        libs_text=$(${sdk}/bin/wasm-linux-pkg-config --libs libcurl)
        read -ra cflags <<< "$cflags_text"
        read -ra libs <<< "$libs_text"
        case "$cflags_text $libs_text" in
          *${finalAttrs.finalPackage.development}*|*"$PWD/original"*|*/nix/store/*)
            echo 'libcurl flags escaped the relocated development installation' >&2; exit 1 ;;
        esac
        case "$cflags_text $libs_text" in
          *"$PWD/relocated/installation"*) ;;
          *) echo 'libcurl flags did not select the copied installation' >&2; exit 1 ;;
        esac
        cp relocated/installation/share/doc/libcurl/examples/fetch.c fetch.c
        ${sdk}/bin/wasm-linux-cc -O2 -Wall -Wextra -Werror \
          "''${cflags[@]}" fetch.c "''${libs[@]}" -o $out/bin/libcurl-fetch
        node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
          $out/bin/libcurl-fetch ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
        cp -r relocated/installation/share/licenses/curl $out/share/licenses/
        cp relocated/installation/share/doc/libcurl/examples/LICENSE.MIT $out/share/licenses/curl/example-MIT
      '';

  # An independent consumer of the installed CMake project. Keep the direct
  # compiler consumer above: neither build path substitutes for the other.
  passthru.developmentCmakeApplication =
    pkgs.runCommand "libcurl-installed-cmake-application-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          pkgs.cmake
          pkgs.ninja
          pkgs.nodejs
        ];
        passthru.apk.license = finalAttrs.passthru.apk.license;
      }
      ''
        mkdir -p $out/bin $out/share/licenses relocated
        cp -r ${finalAttrs.finalPackage.development}/. original/
        chmod u+w original
        mv original relocated/installation
        export WASM_PKG_CONFIG_PATH="$PWD/relocated/installation/lib/pkgconfig"
        export WASM_PKG_CONFIG_SYSROOT_DIR=/
        cmake -S relocated/installation/share/doc/libcurl/examples -B build -G Ninja \
          -DCMAKE_BUILD_TYPE=Release \
          -DCMAKE_TOOLCHAIN_FILE=${sdk}/share/cmake/linux-wasm.cmake \
          -DCMAKE_STAGING_PREFIX="$PWD/relocated/installation"
        cmake --build build --verbose
        cmake --install build --prefix "$PWD/installed"
        cp installed/bin/libcurl-fetch.wasm $out/bin/libcurl-fetch
        node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
          $out/bin/libcurl-fetch ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
        cp -r installed/share/licenses/curl $out/share/licenses/
        # A fresh configure must not recover a missing target dependency from
        # host packages or the successful build's CMake/pkg-config cache.
        cp -r relocated/installation missing
        chmod u+w missing/lib/pkgconfig
        rm missing/lib/pkgconfig/libcrypto.pc
        export WASM_PKG_CONFIG_PATH="$PWD/missing/lib/pkgconfig"
        if cmake -S missing/share/doc/libcurl/examples -B missing-build -G Ninja \
          -DCMAKE_TOOLCHAIN_FILE=${sdk}/share/cmake/linux-wasm.cmake \
          -DCMAKE_STAGING_PREFIX="$PWD/missing" > missing.log 2>&1; then
          echo 'CMake accepted missing target libcrypto metadata' >&2; exit 1
        fi
        cat missing.log
        grep -q libcrypto missing.log
      '';

  passthru.runtimeAssets = rec {
    init = ./tests/https-test.sh;
    contents = [
      busybox
      ca-certificates
      openssl
      finalAttrs.finalPackage
    ];
    httpsInitramfs = image.mkInitramfs {
      name = "curl-verified-https-${platform.wasmArch}";
      inherit init contents;
    };
    development = {
      init = ./tests/development-test.sh;
      contents = [
        busybox
        ca-certificates
        openssl
        finalAttrs.finalPackage.developmentApplication
      ];
    };
    developmentInitramfs = image.mkInitramfs {
      name = "libcurl-installed-application-${platform.wasmArch}";
      inherit (development) init contents;
    };
  };

  passthru.checks = {
    development = vm-test.installedTest {
      name = "libcurl-installed-application-${platform.wasmArch}";
      inherit (finalAttrs.finalPackage.runtimeAssets.development) init contents;
    };
    development-cmake = vm-test.installedTest {
      name = "libcurl-installed-cmake-application-${platform.wasmArch}";
      inherit (finalAttrs.finalPackage.runtimeAssets.development) init;
      contents = [
        busybox
        ca-certificates
        openssl
        finalAttrs.finalPackage.developmentCmakeApplication
      ];
    };
    https = vm-test.installedTest {
      name = "curl-verified-https-${platform.wasmArch}";
      inherit (finalAttrs.finalPackage.runtimeAssets) init contents;
    };
    transfers = vm-test.installedTest {
      name = "curl-transfers";
      init = ./tests/transfers-test.sh;
      contents = [
        # curl-config and wcurl are shell scripts. Runnable distro images
        # always install BusyBox as their /bin/sh provider.
        busybox
        ca-certificates
        finalAttrs.finalPackage
      ];
    };
  };
})
