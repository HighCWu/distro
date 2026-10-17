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
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "lua";
  version = "5.4.8";
  inherit src;
  meta.license = pkgs.lib.licenses.mit;
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
      INSTALL_LMOD="$out/usr/share/lua/5.4" \
      INSTALL_CMOD="$out/usr/lib/lua/5.4" \
      CC="$CC" AR="llvm-ar rcu" RANLIB="llvm-ranlib"
    mkdir -p $out/share/licenses/lua
    # Preserve the complete upstream HTML, which contains the MIT notice.
    cp doc/readme.html $out/share/licenses/lua/lua-readme.html
    cp ${musl.src}/COPYRIGHT $out/share/licenses/lua/musl-COPYRIGHT
    cp ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT $out/share/licenses/lua/compiler-rt-LICENSE.TXT
    runHook postInstall
  '';

  passthru.checks =
    let
      check =
        name: init:
        vm-test.installedTest {
          name = "lua-${name}";
          inherit init;
          contents = [
            finalAttrs.finalPackage
            busybox
          ];
          files = {
            "/usr/share/lua/5.4/platform_test.lua" = builtins.toFile "platform-test.lua" ''
              return { answer = 42 }
            '';
          };
        };
    in
    {
      language = check "language" ./language-test.sh;
    };
})
