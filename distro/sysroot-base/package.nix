# musl and kernel headers only: enough to build the compiler runtimes without
# depending on them.
{
  pkgs,
  platform,
  linux,
  musl,
}:

pkgs.runCommand "sysroot-base-${platform.wasmArch}" { } ''
  mkdir -p $out/lib $out/include

  cp -r ${linux.headers}/include/* $out/include/
  chmod -R u+w $out/include
  cp -r ${musl}/include/* $out/include/
  cp ${musl}/lib/* $out/lib/
''
