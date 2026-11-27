# signal (mangle_uc_sigmask): exercises SA_SIGINFO signal mask blocking,
# ucontext_t.uc_sigmask mangling on sigreturn, and standard signal coalescing
# without fork, mmap, or architecture-specific assembly (sas is held out
# because it uses mmap and current_stack_pointer.h).
{
  dir = "tools/testing/selftests/signal";
  binaries = [ "mangle_uc_sigmask" ];
  run = ./signal-test.sh;
}
