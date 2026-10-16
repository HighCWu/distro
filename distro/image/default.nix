{ callPackage }:

rec {
  mkInitramfs = callPackage ./initramfs.nix { };
  mkFilesystem = callPackage ./filesystem.nix { };
  mkGptDisk = callPackage ./gpt-disk.nix { };

  bootInitramfs = callPackage ./boot-initramfs.nix { inherit mkInitramfs; };

  recurseForDerivations = true;
}
