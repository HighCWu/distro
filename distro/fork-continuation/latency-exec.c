// SPDX-License-Identifier: MIT
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
static _Thread_local volatile int cookie = 11;
int main(int argc, char **argv)
{
  if (argc != 3 || strcmp(argv[1], "latency-exec-v1") || cookie != 11) return 121;
  const char *token = getenv("LATENCY_TOKEN");
  char *end;
  long parent = strtol(argv[2], &end, 10);
  if (!token || strcmp(token, "verified") || *end || parent <= 0 ||
    getppid() != parent || getpid() == parent) return 122;
  return 42;
}
