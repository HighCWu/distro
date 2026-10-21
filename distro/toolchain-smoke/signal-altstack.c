/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <sched.h>
#include <setjmp.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

/* Linux UAPI flag, kept test-local instead of adding a musl public macro. */
#define TEST_AUTODISARM (1U << 31)
static unsigned char *alternate;
static unsigned char *replacement;
static size_t alternate_size = 65536;
static volatile sig_atomic_t error_code, outer_count, inner_count, ordinary_count, mode;
static volatile sig_atomic_t jumps;
static volatile uintptr_t outer_address, inner_address;
static sigjmp_buf escape;
static int in_alternate(const volatile void *pointer)
{
	uintptr_t p = (uintptr_t)pointer, low = (uintptr_t)alternate;
	return p >= low && p < low + alternate_size;
}
static void check_handler(int ok, int code)
{
	if (!ok && !error_code) error_code = code;
}
static void nested(int sig, siginfo_t *info, void *raw_context)
{
	volatile unsigned char marker[128] = {0};
	stack_t observed;
	(void)raw_context;
	inner_address = (uintptr_t)marker;
	check_handler(sig == SIGUSR2 && info && info->si_signo == sig && in_alternate(marker), 10);
	check_handler(sigaltstack(NULL, &observed) == 0, 11);
	check_handler((mode == 1 || mode == 2 || mode == 4) ? (observed.ss_flags & SS_DISABLE) : (observed.ss_flags & SS_ONSTACK), 12);
	inner_count++;
}
static void outer(int sig, siginfo_t *info, void *raw_context)
{
	volatile unsigned char marker[128] = {0};
	stack_t observed, disable = {.ss_flags = SS_DISABLE};
	ucontext_t *context = raw_context;
	outer_address = (uintptr_t)marker;
	check_handler(sig == SIGUSR1 && info && info->si_signo == sig && in_alternate(marker), 20);
	check_handler(context && context->uc_stack.ss_sp == alternate && context->uc_stack.ss_size == alternate_size &&
	              (unsigned)context->uc_stack.ss_flags == ((mode == 1 || mode == 2 || mode == 4) ? TEST_AUTODISARM : 0) &&
	              sigismember(&context->uc_sigmask, SIGUSR1) == 0, 21);
	check_handler(sigaltstack(NULL, &observed) == 0, 22);
	if (mode == 1 || mode == 2 || mode == 4) check_handler(observed.ss_flags & SS_DISABLE, 23);
	else {
		check_handler(observed.ss_flags & SS_ONSTACK, 24);
		check_handler(sigaltstack(&disable, NULL) == -1 && errno == EPERM, 25);
	}
	outer_count++;
	if (mode == 2) siglongjmp(escape, 41);
	check_handler(raise(SIGUSR2) == 0, 26);
	check_handler(inner_address < outer_address && outer_address - inner_address >= sizeof(marker), 27);
	if (mode >= 3 && context) {
		context->uc_stack.ss_sp = replacement;
		context->uc_stack.ss_size = alternate_size;
		context->uc_stack.ss_flags = 0;
		check_handler(sigaddset(&context->uc_sigmask, SIGWINCH) == 0 &&
		              sigaddset(&context->uc_sigmask, SIGKILL) == 0 &&
		              sigaddset(&context->uc_sigmask, SIGSTOP) == 0, 28);
	}
}
static void ordinary(int sig)
{
	volatile unsigned char marker[128] = {0};
	check_handler(sig == SIGWINCH && !in_alternate(marker), 30);
	ordinary_count++;
}
static void require(int ok, const char *what)
{
	if (ok) return;
	printf("::vm-test::fail: signal-altstack: %s errno=%d handler=%d\n", what, errno, error_code);
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#else
	exit(1);
#endif
}
int main(void)
{
	volatile unsigned char canary[256];
	for (unsigned i = 0; i < sizeof(canary); i++) canary[i] = (unsigned char)i;
	alternate = aligned_alloc(16, alternate_size);
	require(alternate != NULL, "allocate alternative stack");
	stack_t selected = {.ss_sp = alternate, .ss_size = alternate_size}, observed;
	require(sigaltstack(NULL, &observed) == 0 && (observed.ss_flags & SS_DISABLE), "initial disabled state");
	stack_t invalid = selected;
	invalid.ss_size = 1;
	require(syscall(SYS_sigaltstack, (long)&invalid, 0L, 0L, 0L, 0L, 0L) == -1 && errno == ENOMEM,
	        "kernel rejects undersized registration");
	invalid = selected;
	invalid.ss_flags = 0x40000000;
	require(sigaltstack(&invalid, NULL) == -1 && errno == EINVAL, "invalid flags");
	require(syscall(SYS_sigaltstack, -4096L, 0L, 0L, 0L, 0L, 0L) == -1 && errno == EFAULT,
	        "bad registration pointer");
	require(sigaltstack(&selected, &observed) == 0 && (observed.ss_flags & SS_DISABLE), "register and return old state");
	require(sigaltstack(NULL, &observed) == 0 && observed.ss_sp == alternate && observed.ss_size == alternate_size &&
	        observed.ss_flags == 0, "registered query");
	puts("signal-altstack: standard registration, query and kernel error paths pass");

	struct sigaction action = {.sa_sigaction = outer, .sa_flags = SA_SIGINFO | SA_ONSTACK | SA_RESTART};
	require(sigemptyset(&action.sa_mask) == 0 && sigaction(SIGUSR1, &action, NULL) == 0, "outer sigaction");
	action.sa_sigaction = nested;
	require(sigaction(SIGUSR2, &action, NULL) == 0, "nested sigaction");
	struct sigaction plain = {.sa_handler = ordinary};
	require(sigemptyset(&plain.sa_mask) == 0 && sigaction(SIGWINCH, &plain, NULL) == 0, "ordinary sigaction");
	require(raise(SIGUSR1) == 0 && !error_code && outer_count == 1 && inner_count == 1, "nested alternative stack delivery");
	require(raise(SIGWINCH) == 0 && ordinary_count == 1 && !error_code, "ordinary delivery on original stack");
	puts("signal-altstack: siginfo context, nested on-stack delivery and normal return pass");

	mode = 1;
	selected.ss_flags = (int)TEST_AUTODISARM;
	require(sigaltstack(&selected, NULL) == 0 && raise(SIGUSR1) == 0 && !error_code &&
	        outer_count == 2 && inner_count == 2, "autodisarm nested delivery");
	require(sigaltstack(NULL, &observed) == 0 && observed.ss_sp == alternate &&
	        (unsigned)observed.ss_flags == TEST_AUTODISARM, "normal return restores autodisarm registration");
	puts("signal-altstack: autodisarm visibility, nested delivery and registration restoration pass");

	mode = 2;
	sigset_t mask;
	while (jumps < 16) {
		require(sigaltstack(&selected, NULL) == 0, "re-arm escaping alternative stack");
		int result = sigsetjmp(escape, 1);
		if (!result) {
			require(raise(SIGUSR1) == 0, "raise escaping handler");
			require(0, "siglongjmp did not leave handler");
		}
		require(result == 41 && !error_code &&
		        sigaltstack(NULL, &observed) == 0 && (observed.ss_flags & SS_DISABLE), "non-local exit keeps stack disarmed");
		require(sigprocmask(SIG_SETMASK, NULL, &mask) == 0 && sigismember(&mask, SIGUSR1) == 0,
		        "siglongjmp restored signal mask");
		jumps++;
	}
	mode = 0;
	selected.ss_flags = 0;
	require(sigaltstack(&selected, NULL) == 0 && raise(SIGUSR1) == 0 && !error_code &&
	        outer_count == 19 && inner_count == 3 && raise(SIGWINCH) == 0 && ordinary_count == 2,
	        "delivery recovers after non-local exit");
	for (unsigned i = 0; i < sizeof(canary); i++) require(canary[i] == (unsigned char)i, "original frame preserved");
	puts("signal-altstack: repeated SjLj escape, mask and original-frame recovery pass");

	replacement = aligned_alloc(16, alternate_size);
	require(replacement != NULL, "allocate replacement alternative stack");
	sigset_t before_edit;
	require(sigprocmask(SIG_SETMASK, NULL, &before_edit) == 0, "save context-edit mask");
	mode = 3;
	int delivered = raise(SIGUSR1), queried = sigaltstack(NULL, &observed);
	require(delivered == 0 && queried == 0 && !error_code && outer_count == 20 && inner_count == 4 &&
	        observed.ss_sp == alternate && observed.ss_flags == 0,
	        "normal on-stack context edit retains protected registration");
	require(sigprocmask(SIG_SETMASK, NULL, &mask) == 0 && sigismember(&mask, SIGWINCH) == 1 &&
	        sigismember(&mask, SIGKILL) == 0 && sigismember(&mask, SIGSTOP) == 0 && sigismember(&mask, SIGUSR1) == 0,
	        "handler context changes mask but cannot block SIGKILL");
	require(sigprocmask(SIG_SETMASK, &before_edit, NULL) == 0, "restore context-edit mask");
	mode = 4;
	selected.ss_flags = (int)TEST_AUTODISARM;
	require(sigaltstack(&selected, NULL) == 0 && raise(SIGUSR1) == 0 && !error_code &&
	        outer_count == 21 && inner_count == 5 && sigaltstack(NULL, &observed) == 0 &&
	        observed.ss_sp == replacement && observed.ss_flags == 0,
	        "autodisarmed context edit installs replacement stack");
	require(sigprocmask(SIG_SETMASK, NULL, &mask) == 0 && sigismember(&mask, SIGWINCH) == 1 &&
	        sigismember(&mask, SIGKILL) == 0 && sigismember(&mask, SIGSTOP) == 0 &&
	        sigprocmask(SIG_SETMASK, &before_edit, NULL) == 0,
	        "autodisarmed context mask restored with unmaskable signals protected");
	unsigned char *first = alternate;
	alternate = replacement;
	mode = 0;
	require(raise(SIGUSR1) == 0 && !error_code && outer_count == 22 && inner_count == 6 &&
	        raise(SIGWINCH) == 0 && ordinary_count == 3, "delivery uses context-selected stack");
	stack_t disable = {.ss_flags = SS_DISABLE};
	require(sigaltstack(&disable, NULL) == 0 && sigaltstack(NULL, &observed) == 0 &&
	        (observed.ss_flags & SS_DISABLE), "disable before freeing stack");
	free(alternate);
	free(first);
	puts("signal-altstack: context stack/mask edits, SIGKILL protection, disable and cleanup pass");
	puts("::vm-test::pass");
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#endif
	return 0;
}
