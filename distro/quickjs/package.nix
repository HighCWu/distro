{
  pkgs,
  stdenv,
  src ? pkgs.fetchFromGitHub {
    owner = "quickjs-ng";
    repo = "quickjs";
    rev = "v0.15.1";
    hash = "sha256-d52EFtBrOO6+DG93R+aWVUisX7SSk2eYLKhWWqX/lII=";
  },
  vm-test,
  busybox,
  platform,
  musl,
  llvm-runtimes,
  image,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "quickjs";
  version = "0.15.1";
  inherit src;
  meta.license = pkgs.lib.licenses.mit;
  passthru.apk.license = "MIT AND Apache-2.0 WITH LLVM-exception";
  nativeBuildInputs = [ pkgs.nodejs ];

  # quickjs-ng over Bellard's quickjs: it is actively maintained and ships the
  # pre-generated gen/repl.c and gen/standalone.c in the release, so the qjs CLI
  # builds without ever running qjsc on the build host. That removes the only
  # real cross-compilation hazard (build-time JS->C codegen needing a native
  # engine, the way busybox/sqlite need depsBuildBuild), so no native quickjs is
  # required here.
  #
  # Upstream builds with CMake, but the source set is tiny -- the engine is four
  # .c files, cutils/list/dtoa are header-only, and the CLI just adds the two
  # generated sources -- so a direct cross compile is clearer than wiring up a
  # CMake toolchain file. -D_GNU_SOURCE is the only compile define CMake adds for
  # the engine. QuickJS's own exceptions are return-value based (it does not use
  # setjmp/longjmp), so unlike lua this needs no -mllvm -wasm-enable-sjlj. Its JS
  # stack limit is derived from __builtin_frame_address (the wasm shadow-stack
  # pointer) against a 1 MiB default, comfortably inside the 8 MiB shadow stack,
  # so recursion limits behave without tuning. os.Worker uses threads, which the
  # platform supports. Upstream's pthread wrapper type-puns its void-returning
  # callback into pthread's pointer-returning callback type. wasm function
  # tables enforce exact signatures, so a small typed trampoline bridges the
  # callback and returns NULL normally.
  #
  # os.exec uses posix_spawn on wasm: file actions cover stdio, closefrom, and
  # cwd, while uid/gid/groups fail explicitly because spawn cannot express
  # arbitrary credential changes. This preserves both blocking and asynchronous
  # process execution without requiring fork().
  patches = [
    ./wasm-posix-spawn.patch
    ./worker-pthread-trampoline.patch
  ];

  dontConfigure = true;

  # The engine sources plus the libc; the CLI adds the two generated modules and
  # qjs.c. qjsc.c is the bytecode compiler; built here as a guest binary too (it
  # links against the same objects and needs no host engine). -lm is a no-op
  # archive on musl but kept to mirror upstream's link line.
  buildPhase = ''
    runHook preBuild
    engine="dtoa.c libregexp.c libunicode.c quickjs.c quickjs-libc.c"
    $CC -D_GNU_SOURCE -O2 -I. -o qjs $engine gen/repl.c gen/standalone.c qjs.c -lm
    $CC -D_GNU_SOURCE -O2 -I. -o qjsc $engine qjsc.c -lm
    runHook postBuild
  '';

  postBuild = ''
    for program in qjs qjsc; do
      node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
        "$program" ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    done
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin $out/include
    cp qjs qjsc $out/bin/
    cp quickjs.h quickjs-libc.h $out/include/
    mkdir -p $out/share/licenses/quickjs
    cp LICENSE $out/share/licenses/quickjs/quickjs-LICENSE
    cp ${musl.src}/COPYRIGHT $out/share/licenses/quickjs/musl-COPYRIGHT
    cp ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT $out/share/licenses/quickjs/compiler-rt-LICENSE.TXT
    runHook postInstall
  '';

  # Run the exact workload against unchanged package output paths. Do not add
  # aliases which could hide an installed-system path mismatch in the test.
  passthru.browserInitramfs = image.mkInitramfs {
    name = "quickjs-language-${platform.wasmArch}";
    init = ./language-test.sh;
    contents = [
      busybox
      finalAttrs.finalPackage
    ];
  };

  passthru.checks = {
    language = vm-test.installedTest {
      name = "quickjs-language";
      init = ./language-test.sh;
      contents = [
        busybox
        finalAttrs.finalPackage
      ];
    };
  };
})
