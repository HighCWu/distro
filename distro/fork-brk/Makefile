# SPDX-License-Identifier: MIT

.PHONY: all
all: fork-limits.wasm brk-existing.wasm fork-existing.wasm exec-child.wasm

# GNU make predefines CC=cc. Use the fork SDK wrapper only for that builtin
# default, and preserve environment or command-line selections.
ifeq ($(origin CC),default)
CC = wasm-linux-fork-cc
endif
HELPER_CC ?= wasm-linux-cc

fork-limits.o: runtime.c
	$(CC) -O2 -fno-builtin-malloc -pthread -Wall -Wextra -Werror -c $< -o $@

fork-limits.wasm: fork-limits.o
	$(CC) -pthread $< -o $@

brk-existing.o: brk-existing.c
	$(CC) -O2 -fno-builtin-malloc -pthread -Wall -Wextra -Werror -c $< -o $@

brk-existing.wasm: brk-existing.o
	$(CC) -pthread $< -o $@

fork-existing.o: fork-existing.c
	$(CC) -O2 -pthread -Wall -Wextra -Werror -c $< -o $@

fork-existing-raw-clone.o: raw-clone.c
	$(CC) -O2 -pthread -Wall -Wextra -Werror -c $< -o $@

fork-existing.wasm: fork-existing.o fork-existing-raw-clone.o
	$(CC) -pthread $^ -o $@

exec-child.o: exec-child.c
	$(HELPER_CC) -O2 -Wall -Wextra -Werror -c $< -o $@

exec-child-raw-clone.o: raw-clone.c
	$(HELPER_CC) -O2 -Wall -Wextra -Werror -c $< -o $@

exec-child.wasm: exec-child.o exec-child-raw-clone.o
	$(HELPER_CC) -O2 -Wall -Wextra -Werror $^ -o $@
