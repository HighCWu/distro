/* SPDX-License-Identifier: MIT */
/* Exercise the actual executor handshake without booting a kernel or running
 * its PID 1 entry point. Local socket pairs never leave this process. */
#define main embedded_agent_main
#include "agent.c"
#undef main
#include <assert.h>

static void check(uint16_t version, uint16_t abi, bool accepted, bool bad_magic,
		  uint16_t expected_version)
{
	int sockets[2];
	uint8_t hello[8], reply[8];
	assert(socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, sockets) == 0);
	store_u32(hello, protocol_magic ^ (bad_magic ? 1 : 0));
	hello[4] = version;
	hello[5] = version >> 8;
	hello[6] = abi;
	hello[7] = abi >> 8;
	assert(write_all(sockets[0], hello, sizeof(hello)) == 0);
	int result = handshake(sockets[1], expected_version);
	assert((result >= 0) == accepted);
	if (accepted) {
		assert(result == version);
		assert(read_all(sockets[0], reply, sizeof(reply)) == 0);
		assert(memcmp(hello, reply, sizeof(hello)) == 0);
	} else {
		assert(recv(sockets[0], reply, sizeof(reply), MSG_DONTWAIT) == -1);
		assert(errno == EAGAIN || errno == EWOULDBLOCK);
	}
	close(sockets[0]);
	close(sockets[1]);
}

int main(void)
{
	_Static_assert(sizeof(void *) == sizeof(long), "agent requires ILP32 or LP64");
	check(3, 0, protocol_abi == 32, false, 0);
	check(4, protocol_abi, true, false, 0);
	check(4, protocol_abi == 32 ? 64 : 32, false, false, 0);
	check(4, 0, false, false, 0);
	check(3, 32, false, false, 0);
	check(5, protocol_abi, false, false, 0);
	check(4, protocol_abi, false, true, 0);
	check(4, protocol_abi, false, false, 3);
	check(4, protocol_abi, true, false, 4);
	printf("agent handshake: native ABI %d, legacy admission and v4 identity verified\n", protocol_abi);
	return 0;
}
