// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/genetlink.h>
#include <linux/netlink.h>
#include <linux/taskstats.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#define IO_FILE "/tmp/taskstats-io.bin"

static uint32_t next_seq = 1;

static void require(int ok, const char *what)
{
	if (ok) return;
	fprintf(stderr, "taskstats-runtime: %s (errno=%d: %s)\n", what, errno,
		strerror(errno));
	exit(1);
}

static void add_nlattr(struct nlmsghdr *nlh, size_t maxlen, uint16_t type,
		       const void *data, size_t len)
{
	size_t attr_len = NLA_HDRLEN + len;
	require(NLMSG_ALIGN(nlh->nlmsg_len) + NLA_ALIGN(attr_len) <= maxlen,
		"netlink buffer capacity");
	struct nlattr *nla =
		(struct nlattr *)(((char *)nlh) + NLMSG_ALIGN(nlh->nlmsg_len));
	nla->nla_type = type;
	nla->nla_len = (uint16_t)attr_len;
	if (len > 0) memcpy(((char *)nla) + NLA_HDRLEN, data, len);
	nlh->nlmsg_len =
		(uint32_t)(NLMSG_ALIGN(nlh->nlmsg_len) + NLA_ALIGN(attr_len));
}

static uint16_t resolve_taskstats_family(int nl_fd)
{
	struct {
		struct nlmsghdr nlh;
		struct genlmsghdr genl;
		char attrs[128];
	} req;
	memset(&req, 0, sizeof(req));
	req.nlh.nlmsg_len = NLMSG_LENGTH(GENL_HDRLEN);
	req.nlh.nlmsg_type = GENL_ID_CTRL;
	req.nlh.nlmsg_flags = NLM_F_REQUEST;
	req.nlh.nlmsg_seq = next_seq++;
	req.genl.cmd = CTRL_CMD_GETFAMILY;
	req.genl.version = 1;

	add_nlattr(&req.nlh, sizeof(req), CTRL_ATTR_FAMILY_NAME,
		   TASKSTATS_GENL_NAME, strlen(TASKSTATS_GENL_NAME) + 1);

	struct sockaddr_nl kernel = { .nl_family = AF_NETLINK };
	ssize_t sent = sendto(nl_fd, &req, req.nlh.nlmsg_len, 0,
			      (const struct sockaddr *)&kernel, sizeof(kernel));
	require(sent == (ssize_t)req.nlh.nlmsg_len,
		"send CTRL_CMD_GETFAMILY");

	char buf[4096];
	ssize_t n = recv(nl_fd, buf, sizeof(buf), 0);
	require(n >= (ssize_t)NLMSG_LENGTH(GENL_HDRLEN),
		"recv CTRL_CMD_GETFAMILY");

	const struct nlmsghdr *resp = (const struct nlmsghdr *)buf;
	require(NLMSG_OK(resp, (size_t)n), "valid genetlink response");
	require(resp->nlmsg_type != NLMSG_ERROR,
		"CTRL_CMD_GETFAMILY succeeded");

	uint16_t family_id = 0;
	int rem = (int)NLMSG_PAYLOAD(resp, GENL_HDRLEN);
	const struct nlattr *nla =
		(const struct nlattr *)(((const char *)NLMSG_DATA(resp)) +
					GENL_HDRLEN);
	for (; rem >= NLA_HDRLEN && nla->nla_len >= NLA_HDRLEN &&
	       (int)nla->nla_len <= rem;) {
		if ((nla->nla_type & NLA_TYPE_MASK) == CTRL_ATTR_FAMILY_ID &&
		    nla->nla_len >= NLA_HDRLEN + sizeof(uint16_t)) {
			memcpy(&family_id, ((const char *)nla) + NLA_HDRLEN,
			       sizeof(family_id));
		}
		int step = NLA_ALIGN(nla->nla_len);
		rem -= step;
		nla = (const struct nlattr *)(((const char *)nla) + step);
	}
	require(family_id > 0, "resolved non-zero TASKSTATS family id");
	return family_id;
}

static void query_taskstats(int nl_fd, uint16_t family_id, uint16_t cmd_attr,
			    uint32_t id, uint16_t expected_aggr_type,
			    struct taskstats *out)
{
	struct {
		struct nlmsghdr nlh;
		struct genlmsghdr genl;
		char attrs[128];
	} req;
	memset(&req, 0, sizeof(req));
	req.nlh.nlmsg_len = NLMSG_LENGTH(GENL_HDRLEN);
	req.nlh.nlmsg_type = family_id;
	req.nlh.nlmsg_flags = NLM_F_REQUEST;
	req.nlh.nlmsg_seq = next_seq++;
	req.genl.cmd = TASKSTATS_CMD_GET;
	req.genl.version = TASKSTATS_GENL_VERSION;

	add_nlattr(&req.nlh, sizeof(req), cmd_attr, &id, sizeof(id));

	struct sockaddr_nl kernel = { .nl_family = AF_NETLINK };
	ssize_t sent = sendto(nl_fd, &req, req.nlh.nlmsg_len, 0,
			      (const struct sockaddr *)&kernel, sizeof(kernel));
	require(sent == (ssize_t)req.nlh.nlmsg_len, "send TASKSTATS_CMD_GET");

	char buf[8192];
	ssize_t n = recv(nl_fd, buf, sizeof(buf), 0);
	require(n >= (ssize_t)NLMSG_LENGTH(GENL_HDRLEN),
		"recv TASKSTATS_CMD_GET");

	const struct nlmsghdr *resp = (const struct nlmsghdr *)buf;
	require(NLMSG_OK(resp, (size_t)n), "valid TASKSTATS response");
	require(resp->nlmsg_type == family_id, "TASKSTATS response family");

	int found_stats = 0;
	int rem = (int)NLMSG_PAYLOAD(resp, GENL_HDRLEN);
	const struct nlattr *nla =
		(const struct nlattr *)(((const char *)NLMSG_DATA(resp)) +
					GENL_HDRLEN);
	for (; rem >= NLA_HDRLEN && nla->nla_len >= NLA_HDRLEN &&
	       (int)nla->nla_len <= rem;) {
		if ((nla->nla_type & NLA_TYPE_MASK) == expected_aggr_type) {
			int inner_rem = (int)nla->nla_len - NLA_HDRLEN;
			const struct nlattr *inner =
				(const struct nlattr *)(((const char *)nla) +
							NLA_HDRLEN);
			for (; inner_rem >= NLA_HDRLEN &&
			       inner->nla_len >= NLA_HDRLEN &&
			       (int)inner->nla_len <= inner_rem;) {
				if ((inner->nla_type & NLA_TYPE_MASK) ==
					    TASKSTATS_TYPE_STATS &&
				    inner->nla_len >=
					    NLA_HDRLEN + sizeof(*out)) {
					memcpy(out,
					       ((const char *)inner) +
						       NLA_HDRLEN,
					       sizeof(*out));
					found_stats = 1;
				}
				int istep = NLA_ALIGN(inner->nla_len);
				inner_rem -= istep;
				inner = (const struct nlattr
						 *)(((const char *)inner) +
						    istep);
			}
		}
		int step = NLA_ALIGN(nla->nla_len);
		rem -= step;
		nla = (const struct nlattr *)(((const char *)nla) + step);
	}
	require(found_stats, "unpacked TASKSTATS_TYPE_STATS");
}

static void run_cpu_and_io_workload(void)
{
	volatile uint64_t acc = 0;
	for (uint64_t i = 0; i < 2000000ULL; i++) {
		acc += (i * 13ULL) ^ (i >> 3);
	}
	(void)acc;

	int fd = open(IO_FILE, O_CREAT | O_RDWR | O_TRUNC, 0644);
	require(fd >= 0, "open workload file");

	char buf[4096];
	memset(buf, 0x5a, sizeof(buf));
	for (int i = 0; i < 16; i++) {
		require(write(fd, buf, sizeof(buf)) == (ssize_t)sizeof(buf),
			"write workload block");
	}
	require(fsync(fd) == 0, "fsync workload file");
	require(lseek(fd, 0, SEEK_SET) == 0, "lseek workload file");
	for (int i = 0; i < 16; i++) {
		require(read(fd, buf, sizeof(buf)) == (ssize_t)sizeof(buf),
			"read workload block");
	}
	require(close(fd) == 0, "close workload file");
	require(unlink(IO_FILE) == 0, "unlink workload file");
}

int main(void)
{
	setvbuf(stdout, NULL, _IONBF, 0);

	int nl_fd = socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_GENERIC);
	require(nl_fd >= 0, "socket(AF_NETLINK, NETLINK_GENERIC)");

	struct sockaddr_nl local = { .nl_family = AF_NETLINK };
	require(bind(nl_fd, (const struct sockaddr *)&local, sizeof(local)) ==
			0,
		"bind NETLINK_GENERIC");

	uint16_t family_id = resolve_taskstats_family(nl_fd);
	uint32_t tid = (uint32_t)gettid();
	uint32_t tgid = (uint32_t)getpid();

	struct taskstats before_pid, after_pid;
	struct taskstats before_tgid, after_tgid;

	query_taskstats(nl_fd, family_id, TASKSTATS_CMD_ATTR_PID, tid,
			TASKSTATS_TYPE_AGGR_PID, &before_pid);
	query_taskstats(nl_fd, family_id, TASKSTATS_CMD_ATTR_TGID, tgid,
			TASKSTATS_TYPE_AGGR_TGID, &before_tgid);

	require(before_pid.version >= 1 && before_pid.ac_pid == tid,
		"before_pid version and ac_pid valid");
	require(before_tgid.version >= 1 && before_tgid.ac_pid == tgid,
		"before_tgid version and ac_pid valid");

	run_cpu_and_io_workload();

	query_taskstats(nl_fd, family_id, TASKSTATS_CMD_ATTR_PID, tid,
			TASKSTATS_TYPE_AGGR_PID, &after_pid);
	query_taskstats(nl_fd, family_id, TASKSTATS_CMD_ATTR_TGID, tgid,
			TASKSTATS_TYPE_AGGR_TGID, &after_tgid);

	require(after_pid.ac_pid == tid &&
			after_pid.version == before_pid.version,
		"after_pid identity and version consistent");
	require(after_pid.cpu_run_real_total >= before_pid.cpu_run_real_total,
		"cpu_run_real_total monotonic");
	require(after_pid.ac_etime >= before_pid.ac_etime,
		"ac_etime monotonic");
	require(after_pid.write_char > before_pid.write_char,
		"write_char increased after 64 KiB write");
	require(after_pid.read_char > before_pid.read_char,
		"read_char increased after 64 KiB read");
	require(after_tgid.cpu_run_real_total >= before_tgid.cpu_run_real_total,
		"tgid cpu_run_real_total monotonic");
	require(after_tgid.write_char >= before_tgid.write_char,
		"tgid write_char monotonic");

	require(close(nl_fd) == 0, "close NETLINK_GENERIC");
	puts("taskstats runtime: genetlink family, PID/TGID stats and monotonic CPU/IO pass");
	return 0;
}
