# SPDX-License-Identifier: MIT

.PHONY: all
all: fork.wasm exec-child.wasm

runtime.o: runtime.c
	$(CC) -O0 -pthread -Wall -Wextra -Werror -c $< -o $@

raw-clone.o: raw-clone.c
	$(CC) -O0 -Wall -Wextra -Werror -c $< -o $@

combined.o: runtime.o raw-clone.o
	$(CC) -r $^ -o $@

fork.wasm: combined.o
	$(CC) -pthread $< -o $@

exec-child.wasm: exec-child.c raw-clone.c
	$(HELPER_CC) -O0 -Wall -Wextra -Werror $^ -o $@
