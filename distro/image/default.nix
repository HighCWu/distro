{
  callPackage,
  apk ? null,
}:

let
  checkStoreReferences = if apk != null then apk.checkStoreReferences else null;
in
rec {
  mkInitramfs = callPackage ./initramfs.nix { inherit checkStoreReferences; };
  mkFilesystem = callPackage ./filesystem.nix { inherit checkStoreReferences; };
  mkGptDisk = callPackage ./gpt-disk.nix { };

  bootInitramfs = callPackage ./boot-initramfs.nix { inherit mkInitramfs; };

  recurseForDerivations = true;
}
