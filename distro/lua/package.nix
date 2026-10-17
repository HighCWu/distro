{
  pkgs,
  stdenv,
  src ? pkgs.fetchzip {
    url = "https://www.lua.org/ftp/lua-5.4.8.tar.gz";
    hash = "sha256-6TMsVp2D3WtvnwyhvwodjQH3kvTXz1rSMWwiHazvKys=";
  },
  vm-test,
  busybox,
  platform,
  musl,
  llvm-runtimes,
  sdk,
  image,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "lua";
  version = "5.4.8";
  inherit src;
  outputs = [
    "out"
    "dev"
  ];
  meta = {
    license = pkgs.lib.licenses.mit;
    outputsToInstall = [ "out" ];
  };
  passthru.apk.license = "MIT AND Apache-2.0 WITH LLVM-exception";
  nativeBuildInputs = [ pkgs.nodejs ];

  # Package outputs are overlaid at the Linux root. Compile Lua's module search
  # paths for that runtime filesystem instead of its /usr/local default.
  postPatch = ''
    substituteInPlace src/luaconf.h \
      --replace-fail '"/usr/local/"' '"/usr/"'
  '';

  # The plain Makefile hardcodes gcc/ar/ranlib; point them at the wasm
  # toolchain. The `posix` target enables POSIX libc features without
  # LUA_USE_DLOPEN, so package.loadlib compiles but fails gracefully at runtime
  # rather than requiring dlopen, which the platform does not provide.
  buildPhase = ''
    runHook preBuild
    make -j$NIX_BUILD_CORES posix CC="$CC" AR="llvm-ar rcu" RANLIB="llvm-ranlib"
    runHook postBuild
  '';

  postBuild = ''
    for program in src/lua src/luac; do
      node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
        "$program" ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    done
  '';

  installPhase = ''
    runHook preInstall
    make install \
      INSTALL_TOP="$out" \
      INSTALL_INC="$dev/include" \
      INSTALL_LIB="$dev/lib" \
      INSTALL_LMOD="$out/usr/share/lua/5.4" \
      INSTALL_CMOD="$out/usr/lib/lua/5.4" \
      CC="$CC" AR="llvm-ar rcu" RANLIB="llvm-ranlib"
    mkdir -p $dev/lib/pkgconfig
    cp ${pkgs.replaceVars ./lua.pc.in { inherit (finalAttrs) version; }} $dev/lib/pkgconfig/lua.pc
    mkdir -p $out/share/licenses/lua
    # Preserve the complete upstream HTML, which contains the MIT notice.
    cp doc/readme.html $out/share/licenses/lua/lua-readme.html
    cp ${musl.src}/COPYRIGHT $out/share/licenses/lua/musl-COPYRIGHT
    cp ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT $out/share/licenses/lua/compiler-rt-LICENSE.TXT
    mkdir -p $dev/share/licenses
    cp -r $out/share/licenses/lua $dev/share/licenses/
    runHook postInstall
  '';

  passthru.runtimeAssets =
    let
      consumer =
        pkgs.runCommand "lua-installed-consumer-${platform.wasmArch}"
          {
            nativeBuildInputs = [ pkgs.nodejs ];
          }
          ''
            mkdir -p $out relocated
            cp -r ${finalAttrs.finalPackage.dev}/. relocated/
            export WASM_PKG_CONFIG_PATH="$PWD/relocated/lib/pkgconfig"
            export WASM_PKG_CONFIG_SYSROOT_DIR=/
            cflags_text=$(${sdk}/bin/wasm-linux-pkg-config --cflags lua)
            libs_text=$(${sdk}/bin/wasm-linux-pkg-config --libs lua)
            read -ra cflags <<< "$cflags_text"
            read -ra libs <<< "$libs_text"
            case "''${cflags[*]} ''${libs[*]}" in
              *${finalAttrs.finalPackage.dev}*) echo 'Lua metadata did not relocate' >&2; exit 1 ;;
            esac
            case "''${cflags[*]} ''${libs[*]}" in
              *"$PWD/relocated"*) ;;
              *) echo 'Lua flags did not select the relocated installation' >&2; exit 1 ;;
            esac
            cp ${../sdk/lua-example.c} lua-example.c
            ${sdk}/bin/wasm-linux-cc -O2 -Wall -Wextra -Werror \
              "''${cflags[@]}" lua-example.c "''${libs[@]}" -o $out/lua-consumer.wasm
            node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
              $out/lua-consumer.wasm ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
          '';
      files = {
        "/usr/share/lua/5.4/platform_test.lua" = builtins.toFile "platform-test.lua" ''
          return { answer = 42 }
        '';
      };
    in
    {
      inherit files;
      languageInitramfs = image.mkInitramfs {
        name = "lua-language-${platform.wasmArch}";
        init = ./language-test.sh;
        contents = [
          finalAttrs.finalPackage
          busybox
        ];
        inherit files;
      };
      developmentProgram = "${consumer}/lua-consumer.wasm";
    };

  passthru.checks = {
    language = vm-test.installedTest {
      name = "lua-language";
      init = ./language-test.sh;
      contents = [
        finalAttrs.finalPackage
        busybox
      ];
      files = finalAttrs.finalPackage.runtimeAssets.files;
    };
    development = vm-test.rawInitramfsTest {
      name = "lua-installed-development-${platform.wasmArch}";
      init = finalAttrs.finalPackage.runtimeAssets.developmentProgram;
    };
  };
})
