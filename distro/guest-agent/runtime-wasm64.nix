# SPDX-License-Identifier: MIT
{
  bytes,
  image,
  kernel,
  node-workspace,
  pkgs,
  sdk-wasm64,
  apk ? null,
  platform-wasm64 ? null,
  production ? null,
  bootDisk ? false,
  extraRootPackages ? { },
}:
let
  program = pkgs.runCommand "agent-runtime-init-wasm64" { } ''
    mkdir $out
    ${sdk-wasm64}/bin/wasm-linux-cc -Wall -Wextra -Werror -pthread \
      -I${./.} ${./runtime-init.c} -o $out/init.wasm
    ${sdk-wasm64}/bin/wasm-linux-cc -Wall -Wextra -Werror \
      ${./runtime-child.c} -o $out/child.wasm
  '';
  fixtureInitramfs = image.mkInitramfs {
    name = "agent-runtime-wasm64";
    init = "${program}/init.wasm";
    files."/bin/agent-runtime-child" = "${program}/child.wasm";
  };
  childPayload = pkgs.runCommand "native-agent-root-payload" { } ''
    mkdir -p $out/bin
    cp ${program}/child.wasm $out/bin/agent-runtime-child
    mkdir -p $out/share/licenses/agent-runtime-child
    cp ${../../license.md} $out/share/licenses/agent-runtime-child/MIT.txt
    cp ${sdk-wasm64}/share/linux-wasm-sdk/licenses/musl/COPYRIGHT \
      $out/share/licenses/agent-runtime-child/musl-COPYRIGHT
    cp ${sdk-wasm64}/share/linux-wasm-sdk/licenses/llvm-runtimes/compiler-rt-LICENSE.TXT \
      $out/share/licenses/agent-runtime-child/compiler-rt-LICENSE.TXT
  '';
  childPackage = apk.mkPackage {
    name = "agent-runtime-child";
    version = "0-r0";
    arch = platform-wasm64.apkArch;
    license = "MIT";
    payload = childPayload;
  };
  childRepository = apk.mkRepository {
    name = "native-agent-runtime";
    arch = platform-wasm64.apkArch;
    packages = extraRootPackages // {
      child = childPackage;
    };
  };
  rootfs = image.mkFilesystem {
    name = "native-agent-runtime-root";
    root = apk.mkSystem {
      name = "native-agent-runtime";
      arch = platform-wasm64.apkArch;
      repositories = [ childRepository ];
      packages = [ childPackage ] ++ builtins.attrValues extraRootPackages;
      files."/etc/agent-runtime-root" = pkgs.writeText "agent-runtime-root-marker" "native-wasm64-root\n";
    };
  };
  initramfs =
    if bootDisk then
      null
    else if production == null then
      fixtureInitramfs
    else
      production.bootInitramfs;
in
assert !bootDisk || production != null;
assert !(extraRootPackages ? child);
pkgs.stdenvNoCC.mkDerivation {
  pname =
    if bootDisk then
      "linux-agent-boot-disk-wasm64"
    else if production == null then
      "linux-agent-runtime-wasm64"
    else
      "linux-agent-production-wasm64";
  version = "0.0.0";
  src = ../..;
  passthru.ci.heavy = true;
  passthru.runtimeInitramfs = initramfs;
  passthru.runtimeRootfs = if production == null then null else rootfs;
  passthru.runtimeBootDisk = if bootDisk then production.bootDisk else null;
  env.CI = "true";
  env.AGENT_WASM64_INITRAMFS = if initramfs == null then "" else initramfs;
  env.AGENT_WASM64_ROOTFS = if production == null then "" else rootfs;
  env.AGENT_WASM64_BOOT_DISK = if bootDisk then production.bootDisk else "";
  pnpmDeps = node-workspace.deps;
  nativeBuildInputs = [
    pkgs.nodejs
    pkgs.pnpmConfigHook
    node-workspace.pnpm
  ];
  buildPhase = ''
    runHook preBuild
    cp ${kernel}/vmlinux.wasm packages/kernel/vmlinux.wasm
    cp -rT ${kernel}/dist packages/kernel/dist
    cp -rT ${bytes}/dist packages/bytes/dist
    pnpm --filter=@lowland/guest-tests check
    timeout --kill-after=5 180 pnpm --filter=@lowland/guest-tests exec \
      node --test agent-wasm64-runtime.ts
    runHook postBuild
  '';
  installPhase = ''
    mkdir $out
  '';
}
