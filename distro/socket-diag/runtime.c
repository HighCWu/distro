/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/netlink.h>
#include <linux/netlink_diag.h>
#include <linux/sock_diag.h>
#include <netinet/in.h>
#include <poll.h>
#include <stddef.h>
#include <spawn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

static void fail(const char *what)
{
	printf("::vm-test::fail: socket diagnostics: %s errno=%d\n", what, errno);
	fflush(stdout);
	exit(1);
}
#define CHECK(ok, what) do { if (!(ok)) fail(what); } while (0)

struct sample {
	int fd;
	unsigned long long inode;
	uint32_t port;
	const char *mode;
	char address[128];
};
static char output[65537];

/* Match a complete inode token on one row, never an inode's decimal prefix. */
static const char *inode_row(const char *text, unsigned long long inode)
{
	char token[64];
	snprintf(token, sizeof(token), "ino:%llu", inode);
	for (const char *row = text; *row;) {
		const char *end = strchr(row, '\n');
		if (!end) end = row + strlen(row);
		const char *found = strstr(row, token);
		if (found && found < end &&
		    (found == row || isspace((unsigned char)found[-1])) &&
		    (found + strlen(token) == end || isspace((unsigned char)found[strlen(token)])))
			return row;
		row = *end ? end + 1 : end;
	}
	return NULL;
}

static int row_has(const char *row, const char *text)
{
	const char *end = strchr(row, '\n'), *found = strstr(row, text);
	return found && (!end || found < end) &&
		(found == row || found[-1] == '@' || isspace((unsigned char)found[-1])) &&
		(!found[strlen(text)] || isspace((unsigned char)found[strlen(text)]));
}

static void close_fd(int fd)
{
	CHECK(!close(fd), "close descriptor");
	errno = 0;
	CHECK(fcntl(fd, F_GETFD) == -1 && errno == EBADF, "descriptor released");
}

static void ss(const char *mode)
{
	int channel[2];
	CHECK(!pipe2(channel, O_CLOEXEC), "capture pipe");
	posix_spawn_file_actions_t actions;
	CHECK(!posix_spawn_file_actions_init(&actions), "spawn actions");
	CHECK(!posix_spawn_file_actions_adddup2(&actions, channel[1], STDOUT_FILENO) &&
	      !posix_spawn_file_actions_addclose(&actions, channel[0]) &&
	      !posix_spawn_file_actions_addclose(&actions, channel[1]), "redirect tool stdout");
	char *arguments[] = {"ss", "-H", "-a", "-n", "-e", (char *)mode, NULL, NULL, NULL};
	if (!strcmp(mode, "netlink")) {
		arguments[5] = "-f";
		arguments[6] = "netlink";
	} else if (strcmp(mode, "-x")) {
		arguments[6] = "-4";
	}
	char *environment[] = {"PATH=/bin:/sbin:/usr/bin:/usr/sbin", "LC_ALL=C", NULL};
	pid_t child;
	int error = posix_spawn(&child, "/sbin/ss", &actions, NULL, arguments, environment);
	if (error) {
		errno = error;
		fail("spawn upstream ss");
	}
	CHECK(!posix_spawn_file_actions_destroy(&actions), "destroy spawn actions");
	close_fd(channel[1]);
	size_t used = 0;
	for (;;) {
		CHECK(used < sizeof(output) - 1, "bounded diagnostic output");
		ssize_t size = read(channel[0], output + used, sizeof(output) - 1 - used);
		if (size < 0 && errno == EINTR) continue;
		CHECK(size >= 0, "read tool output");
		if (!size) break;
		used += (size_t)size;
	}
	output[used] = 0;
	close_fd(channel[0]);
	int status;
	pid_t reaped;
	do { reaped = waitpid(child, &status, 0); } while (reaped < 0 && errno == EINTR);
	CHECK(reaped == child && WIFEXITED(status) && !WEXITSTATUS(status), "tool exit and single reap");
}

static struct sample create(const char *mode)
{
	struct sample sample = {.mode = mode};
	if (!strcmp(mode, "-x")) {
		sample.fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
		CHECK(sample.fd >= 0, "UNIX socket");
		struct sockaddr_un address = {.sun_family = AF_UNIX};
		snprintf(sample.address, sizeof(sample.address), "linux-wasm-ss-%ld-%lu",
			 (long)getpid(), (unsigned long)getuid());
		CHECK(strlen(sample.address) + 1 < sizeof(address.sun_path), "abstract name bound");
		memcpy(address.sun_path + 1, sample.address, strlen(sample.address));
		CHECK(!bind(sample.fd, (struct sockaddr *)&address,
		      offsetof(struct sockaddr_un, sun_path) + 1 + strlen(sample.address)), "abstract UNIX bind");
		CHECK(!listen(sample.fd, 1), "UNIX listener");
	} else {
		int type = !strcmp(mode, "-u") ? SOCK_DGRAM : SOCK_STREAM;
		sample.fd = socket(AF_INET, type | SOCK_CLOEXEC, 0);
		CHECK(sample.fd >= 0, "INET socket");
		struct sockaddr_in address = {.sin_family = AF_INET,
			.sin_addr.s_addr = htonl(INADDR_LOOPBACK)};
		CHECK(!bind(sample.fd, (struct sockaddr *)&address, sizeof(address)), "ephemeral loopback bind");
		socklen_t length = sizeof(address);
		CHECK(!getsockname(sample.fd, (struct sockaddr *)&address, &length) &&
		      length == sizeof(address) && address.sin_port, "actual ephemeral address");
		snprintf(sample.address, sizeof(sample.address), "127.0.0.1:%u", ntohs(address.sin_port));
		if (type == SOCK_STREAM) CHECK(!listen(sample.fd, 1), "TCP listener");
	}
	struct stat state;
	CHECK(!fstat(sample.fd, &state) && S_ISSOCK(state.st_mode) && state.st_ino, "socket inode identity");
	sample.inode = state.st_ino;
	CHECK(fcntl(sample.fd, F_GETFD) & FD_CLOEXEC, "fixtures are not inherited by ss");
	return sample;
}

static void verify(struct sample *samples, int present)
{
	for (int i = 0; i < 3; i++) {
		ss(samples[i].mode);
		const char *row = inode_row(output, samples[i].inode);
		if (present) {
			if (!row || !row_has(row, samples[i].address)) {
				printf("ss diagnostic: mode=%s inode=%llu expected=%s output=%.4096s\n",
				       samples[i].mode, samples[i].inode, samples[i].address, output);
				fail("own socket inode and address in real ss output");
			}
			if (getuid()) {
				char uid[48];
				snprintf(uid, sizeof(uid), "uid:%lu", (unsigned long)getuid());
				CHECK(row_has(row, uid), "ordinary user's kernel socket identity");
			}
		} else {
			CHECK(!row, "closed socket absent from a new dump");
		}
	}
}

static struct sample create_netlink(void)
{
	struct sample sample = {.mode = "netlink"};
	sample.fd = socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_USERSOCK);
	CHECK(sample.fd >= 0, "usersock socket");
	struct sockaddr_nl address = {.nl_family = AF_NETLINK};
	CHECK(!bind(sample.fd, (struct sockaddr *)&address, sizeof(address)), "usersock autobind");
	socklen_t length = sizeof(address);
	CHECK(!getsockname(sample.fd, (struct sockaddr *)&address, &length) &&
	      length == sizeof(address) && address.nl_pid, "usersock actual port ID");
	sample.port = address.nl_pid;
	/* Upstream ss renders this protocol's u32 port ID as a signed int. */
	snprintf(sample.address, sizeof(sample.address), "usersock:%ld", (long)(int32_t)sample.port);
	struct stat state;
	CHECK(!fstat(sample.fd, &state) && S_ISSOCK(state.st_mode) &&
	      state.st_ino && (uint64_t)state.st_ino <= UINT32_MAX, "usersock diagnostic inode");
	sample.inode = state.st_ino;
	return sample;
}

static void netlink_dump(const struct sample *sample, int present)
{
	int fd = socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_SOCK_DIAG);
	CHECK(fd >= 0, "Netlink diagnostic socket");
	struct sockaddr_nl kernel = {.nl_family = AF_NETLINK};
	struct {
		struct nlmsghdr header;
		struct netlink_diag_req request;
	} query = {
		.header = {.nlmsg_len = sizeof(query), .nlmsg_type = SOCK_DIAG_BY_FAMILY,
			.nlmsg_flags = NLM_F_REQUEST | NLM_F_DUMP, .nlmsg_seq = 41},
		.request = {.sdiag_family = AF_NETLINK, .sdiag_protocol = NETLINK_USERSOCK,
			.ndiag_show = NDIAG_SHOW_GROUPS | NDIAG_SHOW_MEMINFO},
	};
	CHECK(sendto(fd, &query, sizeof(query), 0, (struct sockaddr *)&kernel,
	             sizeof(kernel)) == sizeof(query), "request usersock diagnostic dump");
	int found = 0, done = 0;
	for (unsigned packet = 0; !done && packet < 128; packet++) {
		struct pollfd readiness = {.fd = fd, .events = POLLIN};
		int ready;
		do { ready = poll(&readiness, 1, 5000); } while (ready < 0 && errno == EINTR);
		CHECK(ready == 1 && (readiness.revents & POLLIN), "bounded diagnostic reply wait");
		union {
			struct nlmsghdr alignment;
			unsigned char bytes[16384];
		} buffer;
		struct sockaddr_nl sender = {0};
		struct iovec vector = {.iov_base = buffer.bytes, .iov_len = sizeof(buffer.bytes)};
		struct msghdr message = {.msg_name = &sender, .msg_namelen = sizeof(sender),
			.msg_iov = &vector, .msg_iovlen = 1};
		ssize_t size;
		do { size = recvmsg(fd, &message, 0); } while (size < 0 && errno == EINTR);
		CHECK(size > 0 && !(message.msg_flags & (MSG_TRUNC | MSG_CTRUNC)) &&
		      message.msg_namelen == sizeof(sender) && sender.nl_family == AF_NETLINK &&
		      !sender.nl_pid, "complete kernel diagnostic datagram");
		unsigned int remaining = (unsigned int)size;
		for (struct nlmsghdr *header = (void *)buffer.bytes;
		     NLMSG_OK(header, remaining); header = NLMSG_NEXT(header, remaining)) {
			CHECK(!done && NLMSG_ALIGN(header->nlmsg_len) <= remaining,
			      "single completion and bounded message alignment");
			CHECK(header->nlmsg_seq == query.header.nlmsg_seq &&
			      !(header->nlmsg_flags & NLM_F_DUMP_INTR), "diagnostic sequence and snapshot");
			if (header->nlmsg_type == NLMSG_DONE) {
				CHECK(header->nlmsg_len >= NLMSG_LENGTH(sizeof(int)), "dump completion status size");
				int status;
				memcpy(&status, NLMSG_DATA(header), sizeof(status));
				CHECK(!status, "successful dump completion status");
				done = 1;
				continue;
			}
			CHECK(header->nlmsg_type == SOCK_DIAG_BY_FAMILY &&
			      header->nlmsg_len >= NLMSG_LENGTH(sizeof(struct netlink_diag_msg)),
			      "Netlink diagnostic record, not an error or unrelated reply");
			struct netlink_diag_msg record;
			memcpy(&record, NLMSG_DATA(header), sizeof(record));
			CHECK(record.ndiag_family == AF_NETLINK && record.ndiag_protocol == NETLINK_USERSOCK,
			      "requested family and protocol");
			if (record.ndiag_portid == sample->port || record.ndiag_ino == sample->inode) {
				CHECK(record.ndiag_portid == sample->port && record.ndiag_ino == sample->inode,
				      "port and inode identify the same socket");
				CHECK(record.ndiag_type == SOCK_RAW && !found, "unique socket type and identity");
				found = 1;
			}
		}
		CHECK(!remaining, "no malformed trailing diagnostic message");
	}
	CHECK(done && found == present, "complete dump has expected live socket identity");
	close_fd(fd);
}

static void verify_netlink(const struct sample *sample, int present)
{
	/* ss's Netlink renderer omits inode/UID. Verify the kernel inode independently,
	 * then require the real tool to render this same protocol/port, without procfs. */
	netlink_dump(sample, present);
	ss("netlink");
	int found = 0;
	for (const char *row = output; *row;) {
		if (row_has(row, sample->address)) found++;
		const char *end = strchr(row, '\n');
		if (!end) break;
		row = end + 1;
	}
	CHECK(found == present, "upstream ss Netlink protocol/port live and closed identity");
}

int main(void)
{
	/* ss may fall back to procfs. Keep it unavailable so an absent Netlink
	 * handler cannot masquerade as successful socket-diag support. */
	const char *fallback[] = {"/proc/net/unix", "/proc/net/tcp", "/proc/net/udp", "/proc/net/netlink"};
	for (size_t i = 0; i < sizeof(fallback) / sizeof(fallback[0]); i++) {
		errno = 0;
		CHECK(access(fallback[i], F_OK) == -1 && errno == ENOENT, "proc fallback unavailable");
	}
	struct sample samples[] = {create("-x"), create("-u"), create("-t")};
	verify(samples, 1);
	puts("socket diagnostics: upstream ss identifies live UNIX/UDP/TCP sockets through Netlink pass");
	for (int i = 0; i < 3; i++) close_fd(samples[i].fd);
	verify(samples, 0);
	puts("socket diagnostics: exact closed inodes disappear from fresh upstream dumps pass");
	struct sample netlink = create_netlink();
	verify_netlink(&netlink, 1);
	puts("socket diagnostics: Netlink inode and port match the raw dump and upstream ss pass");
	close_fd(netlink.fd);
	verify_netlink(&netlink, 0);
	puts("socket diagnostics: closed Netlink socket disappears from raw and upstream dumps pass");
	CHECK(!setgroups(0, NULL) && !setgid(65534) && !setuid(65534), "ordinary user credentials");
	CHECK(getuid() == 65534 && geteuid() == 65534, "credentials applied");
	samples[0] = create("-x"); samples[1] = create("-u"); samples[2] = create("-t");
	verify(samples, 1);
	for (int i = 0; i < 3; i++) close_fd(samples[i].fd);
	verify(samples, 0);
	puts("socket diagnostics: unprivileged upstream ss, UID metadata and descriptor cleanup pass");
	netlink = create_netlink();
	verify_netlink(&netlink, 1);
	close_fd(netlink.fd);
	verify_netlink(&netlink, 0);
	puts("socket diagnostics: unprivileged Netlink monitoring and descriptor cleanup pass");
	return 0;
}
