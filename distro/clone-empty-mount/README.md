# Native clone3 empty mount namespace

This independent static C fork-profile candidate forwards the existing Linux
CLONE_EMPTY_MNTNS u64 flag. Private capability bit 10 and native transport are
required. Linux implies CLONE_NEWNS, selects the root-only mount view, resets
the child's root/cwd and validates the CLONE_FS conflict. The host does not
unshare after child startup or manipulate mounts on the program's behalf.

`clone-empty-mount-check-both` needs four stages per pointer width: ordinary
NEWNS retains both fixture mounts and cwd; EMPTY_MNTNS exposes the immutable
empty nullfs namespace root and resets cwd; explicit EMPTY_MNTNS|NEWNS does the
same; invalid shared FS leaves the parent unchanged, and ordinary fork/cleanup
recovers. Empty children must not initially see `/init` or either fixture path.
The caller prepares a nonrecursive detached copy of its visible root through
standard open_tree. Only after checking the empty root does the child attach
that copy with move_mount, select it through fchdir/chroot, and verify the
underlying rootfs inodes without the parent's child mounts. Every child
also mounts its own ramfs; the parent must retain its original marker inodes and
must never see that child-only file. Children are reaped once; parent mounts and
underlying fixtures are removed before the single final pass and shutdown gate.

The earlier candidate incorrectly equated the namespace root with the visible
initramfs root. Fixed Linux init_mount_tree places mutable rootfs above nullfs;
copy_mnt_ns with EMPTY_MNTNS copies only nullfs. The revised workload follows
that kernel contract rather than changing it to satisfy the old expectation.

The workload runs only in the isolated Linux/Wasm target. Local checks compile
and analyze it but never execute mounts on the host. They do not establish
kernel namespace behavior. No libc API, syscall number, shared mapping or
multithreaded fork support is added. Original code is MIT; materials retain
upstream licenses.
