# SPDX-License-Identifier: MIT
{
  assets,
  bytes,
  kernel,
  node-workspace,
  pkgs,
  userland ? false,
  networking ? false,
  profile ? "public${
    if networking then
      "-network"
    else if userland then
      "-userland"
    else
      ""
  }",
  testFile ? "agent-wasm64-public-runtime.ts",
}:
assert !networking || userland;
pkgs.stdenvNoCC.mkDerivation {
  pname = "linux-agent-${profile}-wasm64";
  version = "0.0.0";
  src = ../..;
  passthru.ci.heavy = true;
  passthru.runtimeBootDisk = assets.runtimeBootDisk;
  passthru.runtimeRootfs = assets.runtimeRootfs;
  env.CI = "true";
  env.AGENT_WASM64_BOOT_DISK = assets.runtimeBootDisk;
  env.AGENT_WASM64_ROOTFS = assets.runtimeRootfs;
  env.AGENT_WASM64_USERLAND = if userland then "1" else "";
  env.AGENT_WASM64_NETWORKING = if networking then "1" else "";
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
      node --test ${pkgs.lib.escapeShellArg testFile}
    runHook postBuild
  '';
  installPhase = ''
    mkdir $out
  '';
}
