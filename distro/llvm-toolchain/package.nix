# The build-platform toolchain with the wasm runtimes in clang's resource
# directory. This is what gets cc-wrapped into the scope's stdenv, and what the
# devshell exposes for compiling wasm by hand. Its target is always wasm, so
# `ld` is wasm-ld.
{
  pkgs,
  lib,
  platform,
  llvm-runtimes,
  llvm-toolchain-unwrapped,
}:

let
  inherit (llvm-toolchain-unwrapped) version;
  llvmMajorVersion = lib.versions.major version;
in

pkgs.runCommand "llvm-toolchain-${platform.wasmArch}-${version}"
  {
    passthru = {
      isClang = true;
      hardeningUnsupportedFlags = [
        "bindnow"
        "fortify"
        "fortify3"
        "pic"
        "pie"
        "relro"
        "shadowstack"
        "stackclashprotection"
        "stackprotector"
        "strictoverflow"
        "trivialautovarinit"
        "zerocallusedregs"
      ];
    };
  }
  ''
    cp -r ${llvm-toolchain-unwrapped} $out
    chmod -R u+w $out
    mkdir -p $out/lib/clang/${llvmMajorVersion}/lib

    # Keep libc++ discoverable by an unwrapped clang++ as well as by the Nix
    # cc-wrapper. Clang searches this installation-relative location before
    # falling back to target sysroot conventions.
    cp -r ${llvm-runtimes}/include/c++ $out/include/
    mkdir -p $out/include/${platform.targetTriple}
    cp -r ${llvm-runtimes}/include/${platform.targetTriple}/c++ $out/include/${platform.targetTriple}/

    cp -r ${llvm-runtimes}/lib/clang/${llvmMajorVersion}/lib/${platform.targetTriple} $out/lib/clang/${llvmMajorVersion}/lib/
    cp -r ${llvm-runtimes}/lib/clang/${llvmMajorVersion}/lib/${platform.wasmArch} $out/lib/clang/${llvmMajorVersion}/lib/
    cp -r ${llvm-runtimes}/lib/clang/${llvmMajorVersion}/lib/${platform.wasmArch}-unknown $out/lib/clang/${llvmMajorVersion}/lib/

    # This installation is a dedicated wasm toolchain. Keep the C++ runtime
    # selection in Clang's public driver configuration so plain clang++ uses
    # the matching libc++, libc++abi, and libunwind from the selected sysroot.
    cat > $out/bin/clang++.cfg <<EOF
    -stdlib=libc++
    --unwindlib=libunwind
    -mexception-handling
    -lunwind
    EOF

    ln -sf wasm-ld $out/bin/ld
  ''
