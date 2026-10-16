# SPDX-License-Identifier: MIT
{ pkgs, lib }:

{
  name,
  filesystem,
  partitionLabel,
}:
assert lib.assertMsg (
  builtins.isString partitionLabel
  && builtins.stringLength partitionLabel <= 36
  && builtins.match "[A-Za-z0-9._-]+" partitionLabel != null
) "GPT partition label must contain 1 to 36 ASCII letters, digits, dots, underscores, or hyphens";
pkgs.runCommand name
  {
    nativeBuildInputs = [ pkgs.gptfdisk ];
    passthru = (filesystem.passthru or { }) // {
      inherit partitionLabel;
    };
  }
  ''
    sector_size=512
    # GPT occupies sectors 0-33 at the front and 33 sectors at the back.
    # This virtual, immutable disk needs no physical-device alignment gap.
    partition_start=34
    filesystem_bytes=$(stat -c %s ${filesystem})
    filesystem_sectors=$(((filesystem_bytes + sector_size - 1) / sector_size))
    partition_end=$((partition_start + filesystem_sectors - 1))
    disk_sectors=$((partition_start + filesystem_sectors + 33))

    truncate -s $((disk_sectors * sector_size)) "$out"
    sgdisk \
      --clear \
      --set-alignment=1 \
      --disk-guid=00000000-0000-0000-0000-000000000001 \
      --new=1:''${partition_start}:''${partition_end} \
      --typecode=1:0fc63daf-8483-4772-8e79-3d69d8477de4 \
      --partition-guid=1:00000000-0000-0000-0000-000000000002 \
      --change-name=1:${lib.escapeShellArg partitionLabel} \
      "$out"
    dd if=${filesystem} of="$out" bs=$sector_size seek=$partition_start conv=notrunc status=none
    sgdisk --verify "$out"
  ''
