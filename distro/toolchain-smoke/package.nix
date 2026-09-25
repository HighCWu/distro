{
  pkgs,
  lib,
  platform,
  llvm-toolchain,
  sysroot,
}:

let
  cSource = pkgs.writeText "toolchain-smoke.c" ''
    #include <stdint.h>
    #include <stdlib.h>

    int main(void) {
      uint64_t *value = malloc(sizeof(*value));
      if (!value)
        return 1;
      *value = UINT64_C(0x123456789abcdef0);
      int result = *value != UINT64_C(0x123456789abcdef0);
      free(value);
      return result;
    }
  '';
  cxxSource = pkgs.writeText "toolchain-smoke.cc" ''
    #include <array>
    #include <cstdint>
    #include <memory>

    int main() {
      auto value = std::make_unique<std::array<std::uint64_t, 2>>();
      (*value)[1] = UINT64_C(0x123456789abcdef0);
      return (*value)[1] != UINT64_C(0x123456789abcdef0);
    }
  '';
  compileFlags = lib.escapeShellArgs (
    [
      "--target=${platform.targetTriple}"
      "--sysroot=${sysroot}"
    ]
    ++ platform.compilerFlags
    ++ map (flag: "-Wl,${flag}") platform.linkerFlags
  );
in

pkgs.runCommand "toolchain-smoke-${platform.wasmArch}"
  {
    nativeBuildInputs = [
      llvm-toolchain
      pkgs.wabt
    ];
  }
  ''
    mkdir -p $out
    clang ${compileFlags} ${cSource} -o $out/smoke-c.wasm
    clang++ ${compileFlags} ${cxxSource} -o $out/smoke-cxx.wasm
    wasm-validate --enable-memory64 --enable-threads $out/smoke-c.wasm
    wasm-validate --enable-memory64 --enable-threads $out/smoke-cxx.wasm
  ''
