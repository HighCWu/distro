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

static void check_trace(void)
{
	int output[2], saved_stderr;
	char buffer[256];
	ssize_t length;

	assert(pipe2(output, O_CLOEXEC | O_NONBLOCK) == 0);
	saved_stderr = dup(STDERR_FILENO);
	assert(saved_stderr >= 0);
	assert(dup2(output[1], STDERR_FILENO) >= 0);
	trace_sessions = false;
	errno = EDOM;
	trace_session_stage("disabled stage");
	assert(errno == EDOM);
	assert(read(output[0], buffer, sizeof(buffer)) == -1);
	assert(errno == EAGAIN || errno == EWOULDBLOCK);
	trace_sessions = true;
	errno = ERANGE;
	trace_session_stage("trace-test-stage");
	assert(errno == ERANGE);
	fflush(stderr);
	assert(dup2(saved_stderr, STDERR_FILENO) >= 0);
	close(saved_stderr);
	close(output[1]);
	length = read(output[0], buffer, sizeof(buffer) - 1);
	assert(length > 0);
	buffer[length] = 0;
	assert(strstr(buffer, "linux-guest-agent: trace pid="));
	assert(strstr(buffer, " trace-test-stage\n"));
	close(output[0]);
	trace_sessions = false;
}

int main(void)
{
	_Static_assert(sizeof(void *) == sizeof(long), "agent requires ILP32 or LP64");
	check_trace();
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
