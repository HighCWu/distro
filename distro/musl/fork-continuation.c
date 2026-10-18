// SPDX-License-Identifier: MIT
// Opt-in execution ABI only. Process creation uses the existing Linux clone.
#include <stdint.h>
#include <signal.h>
#include "syscall.h"

__attribute__((import_module("linux_fork_v1"), import_name("checkpoint")))
extern int fork_checkpoint(uintptr_t descriptor);

static unsigned char saved_frames[256 * 1024] __attribute__((aligned(16)));
static struct {
	uintptr_t cursor;
	uintptr_t end;
} descriptor;

int __wasm_fork_checkpoint_call(void)
{
	descriptor.cursor = (uintptr_t)saved_frames;
	descriptor.end = (uintptr_t)(saved_frames + sizeof saved_frames);
	return fork_checkpoint((uintptr_t)&descriptor);
}

/* The loader recognizes this callback and resumes _start's saved continuation.
 * Never execute an ordinary C callback using a copied, active parent C stack. */
static int fork_child(void *unused)
{
	(void)unused;
	__builtin_trap();
}

__attribute__((export_name("__wasm_fork_abi")))
int __wasm_fork_abi(void)
{
	return 1;
}

__attribute__((export_name("__wasm_fork_child_entry")))
uintptr_t __wasm_fork_child_entry(void)
{
	return (uintptr_t)fork_child;
}

__attribute__((export_name("__wasm_fork_clone")))
long __wasm_fork_clone(void)
{
	return __syscall(SYS_clone, fork_child, 0, SIGCHLD, 0, 0, 0);
}
