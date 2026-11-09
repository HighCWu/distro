{
  pkgs,
  lib,
  debug,
  wasmBits ? 32,
  deduplicateMmapSearch ? true,
  enableForkContinuation ? false,
  enableDynamicLoader ? false,
  enableBrkSyscall ? false,
  enableCooperativePoll ? false,
  llvm-toolchain-unwrapped,
  src ? pkgs.fetchFromGitHub {
    owner = "HighCWu";
    repo = "musl";
    rev = "980170315dfe0e9ade04182684879b46e27cdba8";
    hash = "sha256-u6MPDMQ32QMVnKln83Gh6NsHoushBVCmqZIyYd6mJcg=";
  },
}:

let
  platform = import ../platform.nix { inherit lib wasmBits; };
in
assert builtins.elem wasmBits [
  32
  64
];
assert !(enableForkContinuation && enableDynamicLoader);
assert !(enableCooperativePoll && enableDynamicLoader);

pkgs.stdenvNoCC.mkDerivation (
  {
    name = "musl-wasm${toString wasmBits}${lib.optionalString enableCooperativePoll "-poll"}";
    inherit src;

    nativeBuildInputs = [ llvm-toolchain-unwrapped ];

    # TODO: split for size, only relevant for dynamic linking
    # outputs = [ "out" "dev" ];
    configurePhase = ''
      runHook preConfigure

      cat >config.mak <<EOF
      ARCH=wasm32
      WASM_BITS=${toString wasmBits}
      prefix=$out
      syslibdir=$out
      # LLVM 22 requires an explicit policy for the executable-owned heap
      # globals and SjLj tag used by the retained PIC libc.so output. This
      # affects its link only; ordinary executables keep strict resolution.
      LDFLAGS_AUTO=-Wl,--unresolved-symbols=import-dynamic,--shared-memory,--import-memory,--max-memory=${toString platform.maximumMemoryBytes}
      CFLAGS=${lib.optionalString debug "-g"}${
        lib.optionalString (!deduplicateMmapSearch) " -DWASM_MMAP_DEDUP_SEARCH=0"
      }${lib.optionalString enableForkContinuation " -DWASM_FORK_CONTINUATION=1"}${lib.optionalString enableDynamicLoader " -DWASM_DYNAMIC_LOADER=1"}${lib.optionalString enableBrkSyscall " -DWASM_BRK_SYSCALL=1"}${lib.optionalString enableCooperativePoll " -fsanitize-coverage=trace-pc,no-prune,edge"}
      EOF

      ${lib.optionalString enableCooperativePoll ''
        # Keep the clone/native-TLS transition free of compiler callbacks. Its
        # inherited parent TLS may cease to be live before the child owns TLS.
        # Both pthread and C11 startup initialize native TLS before other calls.
        cat >>config.mak <<'EOF'
        obj/src/thread/wasm32/clone.o obj/src/thread/wasm32/clone.lo obj/src/thread/pthread_create.o obj/src/thread/pthread_create.lo: CFLAGS_ALL += -fno-sanitize-coverage=trace-pc,no-prune,edge
        EOF
      ''}

      runHook postConfigure
    '';

    buildPhase = ''
      runHook preBuild
      make clean
      make -j$NIX_BUILD_CORES
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir $out
      make -j$NIX_BUILD_CORES install-libs install-headers
      runHook postInstall
    '';
  }
  // {
    patches = [
      ./wasm-crt1.patch
    ]
    ++ lib.optional enableForkContinuation ./fork-continuation.patch
    ++ lib.optional enableDynamicLoader ./dynamic-loader.patch
    ++ lib.optional enableCooperativePoll ./cooperative-poll.patch;
  }
)
