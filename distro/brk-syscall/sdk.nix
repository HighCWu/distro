# SPDX-License-Identifier: MIT
{
  platform,
  musl,
  sysroot-base,
  sysroot,
  sdk,
}:
let
  routedMusl = musl.override { enableBrkSyscall = true; };
  routedRoot = sysroot.override {
    sysroot-base = sysroot-base.override { musl = routedMusl; };
  };
in
sdk.override {
  sysroot = routedRoot;
  platform = platform // {
    linkerFlags = platform.linkerFlags ++ [
      "--undefined=__wasm_brk_layout_v1"
      "--undefined=__wasm_brk_update_v1"
    ];
  };
}
