# Native clone3 empty mount namespace

This independent static C fork-profile candidate forwards the existing Linux
CLONE_EMPTY_MNTNS u64 flag. Private capability bit 10 and native transport are
required. Linux implies CLONE_NEWNS, selects the root-only mount view, resets
the child's root/cwd and validates the CLONE_FS conflict. The host does not
unshare after child startup or manipulate mounts on the program's behalf.

`clone-empty-mount-check-both` needs four stages per pointer width: ordinary
NEWNS retains both fixture mounts and cwd; EMPTY_MNTNS exposes underlying root
inodes and resets cwd; explicit EMPTY_MNTNS|NEWNS does the same; invalid shared
FS leaves the parent unchanged, and ordinary fork/cleanup recovers. Every child
also mounts its own ramfs; the parent must retain its original marker inodes and
must never see that child-only file. Children are reaped once; parent mounts and
underlying fixtures are removed before the single final pass and shutdown gate.

The workload runs only in the isolated Linux/Wasm target. Local checks compile
and analyze it but never execute mounts on the host. They do not establish
kernel namespace behavior. No libc API, syscall number, shared mapping or
multithreaded fork support is added. Original code is MIT; materials retain
upstream licenses.
