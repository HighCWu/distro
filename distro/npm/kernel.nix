{
  bytes,
  linux,
  node-workspace,
  pkgs,
  lib,
  copyFaultTest ? false,
  forkSignalTest ? false,
}:

pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "lowland-kernel";
  inherit ((builtins.fromJSON (builtins.readFile ../../packages/kernel/package.json))) version;
  src = ../..;
  env.CI = "true";
  pnpmDeps = node-workspace.deps;
  nativeBuildInputs = [
    pkgs.nodejs
    pkgs.pnpmConfigHook
    node-workspace.pnpm
  ];

  postPatch =
    lib.optionalString copyFaultTest ''
      substituteInPlace packages/kernel/src/copy-fault.ts \
        --replace-fail 'export const copy_fault_test = false;' 'export const copy_fault_test = true;'
    ''
    + lib.optionalString forkSignalTest ''
      substituteInPlace packages/kernel/src/fork-signal-test.ts \
        --replace-fail 'export const fork_signal_test = false;' 'export const fork_signal_test = true;'
    '';

  buildPhase = ''
    runHook preBuild

    cp ${linux}/vmlinux.wasm packages/kernel/vmlinux.wasm
    cp -r ${linux}/linux-build packages/kernel/linux-build
    cp -rT ${bytes}/dist packages/bytes/dist
    pnpm --filter=@lowland/kernel check
    pnpm --filter=@lowland/kernel test
    pnpm --filter=@lowland/kernel build

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out
    node scripts/pack-package.mjs packages/kernel --out $out/package.tgz
    tar -xzf $out/package.tgz --strip-components=1 -C $out
    # Verify what was actually packed, not only the build-tree copy.
    (cd $out && sha256sum --check linux-build/SHA256SUMS)

    runHook postInstall
  '';
  passthru.sourceBundle = import ../linux/source-bundle.nix { inherit pkgs linux; };
  passthru.checks.source-bundle = finalAttrs.finalPackage.sourceBundle.check;
  passthru.checks.build-materials =
    pkgs.runCommand "npm-kernel-build-materials-check"
      {
        passthru.ci.heavy = true;
        nativeBuildInputs = [ pkgs.nodejs ];
      }
      ''
        # Share one Linux build while also enforcing its source-side profile check.
        test -e ${linux.checks.build-materials}
        node ${./check-kernel-package.mjs} ${finalAttrs.finalPackage}/package.tgz \
          ${linux} ${../../packages/kernel/package.json} ${../../packages/kernel/LICENSE}
        touch $out
      '';
})
