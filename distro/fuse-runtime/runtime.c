// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stddef.h>
#include <linux/fuse.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>

#define MNT_DIR "/tmp/fuse-test"
#define NODE_RO 2ULL
#define NODE_RW 3ULL

static void require(int ok, const char *what)
{
	if (ok) return;
	fprintf(stderr, "fuse-runtime: %s (errno=%d: %s)\n", what, errno,
		strerror(errno));
	exit(1);
}

struct fuse_state {
	int fuse_fd;
	pthread_mutex_t lock;
	int created_present;
	char created_buf[4096];
	size_t created_len;
	int stop;
};

static const char ro_content[] = "fuse-readonly-v1";

static void fill_attr(struct fuse_attr *a, uint64_t ino, uint32_t mode,
		      uint64_t size, uint32_t nlink)
{
	memset(a, 0, sizeof(*a));
	a->ino = ino;
	a->mode = mode;
	a->nlink = nlink;
	a->size = size;
	a->blksize = 4096;
	a->blocks = (size + 511) / 512;
}

static void send_reply(int fd, uint64_t unique, int32_t error,
		       const void *payload, size_t payload_len)
{
	char buf[8192];
	struct fuse_out_header hdr;
	require(sizeof(hdr) + payload_len <= sizeof(buf), "fuse reply size");
	hdr.len = (uint32_t)(sizeof(hdr) + payload_len);
	hdr.error = error;
	hdr.unique = unique;
	memcpy(buf, &hdr, sizeof(hdr));
	if (payload_len > 0) memcpy(buf + sizeof(hdr), payload, payload_len);

	ssize_t n = write(fd, buf, hdr.len);
	if (n < 0 && (errno == ENODEV || errno == EBADF)) return;
	require(n == (ssize_t)hdr.len, "write fuse reply");
}

static size_t append_dirent(char *buf, size_t cap, size_t pos, uint64_t ino,
			    uint64_t off, uint32_t type, const char *name)
{
	size_t namelen = strlen(name);
	size_t rec_len = FUSE_DIRENT_ALIGN(FUSE_NAME_OFFSET + namelen);
	if (pos + rec_len > cap) return pos;
	struct fuse_dirent *d = (struct fuse_dirent *)(buf + pos);
	d->ino = ino;
	d->off = off;
	d->namelen = (uint32_t)namelen;
	d->type = type;
	memcpy(d->name, name, namelen);
	if (rec_len > FUSE_NAME_OFFSET + namelen) {
		memset(buf + pos + FUSE_NAME_OFFSET + namelen, 0,
		       rec_len - (FUSE_NAME_OFFSET + namelen));
	}
	return pos + rec_len;
}

static void *fuse_daemon_main(void *arg)
{
	struct fuse_state *st = (struct fuse_state *)arg;
	char req_buf[131072];

	for (;;) {
		ssize_t n = read(st->fuse_fd, req_buf, sizeof(req_buf));
		if (n < 0) {
			if (errno == EINTR) continue;
			if (errno == ENODEV || errno == EBADF) break;
			require(0, "read /dev/fuse");
		}
		if (n < (ssize_t)sizeof(struct fuse_in_header)) continue;

		const struct fuse_in_header *in =
			(const struct fuse_in_header *)req_buf;
		const char *body = req_buf + sizeof(*in);

		switch (in->opcode) {
		case FUSE_INIT: {
			const struct fuse_init_in *init_in =
				(const struct fuse_init_in *)body;
			struct fuse_init_out out;
			memset(&out, 0, sizeof(out));
			out.major = FUSE_KERNEL_VERSION;
			out.minor = init_in->minor < FUSE_KERNEL_MINOR_VERSION
					    ? init_in->minor
					    : FUSE_KERNEL_MINOR_VERSION;
			out.max_readahead = 65536;
			out.max_write = 65536;
			send_reply(st->fuse_fd, in->unique, 0, &out,
				   sizeof(out));
			break;
		}
		case FUSE_FORGET:
		case FUSE_BATCH_FORGET:
			break;
		case FUSE_DESTROY:
			send_reply(st->fuse_fd, in->unique, 0, NULL, 0);
			return NULL;
		case FUSE_GETATTR: {
			struct fuse_attr_out out;
			memset(&out, 0, sizeof(out));
			out.attr_valid = 1;
			pthread_mutex_lock(&st->lock);
			if (in->nodeid == FUSE_ROOT_ID) {
				fill_attr(&out.attr, FUSE_ROOT_ID,
					  S_IFDIR | 0755, 0, 2);
				pthread_mutex_unlock(&st->lock);
				send_reply(st->fuse_fd, in->unique, 0, &out,
					   sizeof(out));
			} else if (in->nodeid == NODE_RO) {
				fill_attr(&out.attr, NODE_RO, S_IFREG | 0444,
					  sizeof(ro_content) - 1, 1);
				pthread_mutex_unlock(&st->lock);
				send_reply(st->fuse_fd, in->unique, 0, &out,
					   sizeof(out));
			} else if (in->nodeid == NODE_RW &&
				   st->created_present) {
				fill_attr(&out.attr, NODE_RW, S_IFREG | 0644,
					  st->created_len, 1);
				pthread_mutex_unlock(&st->lock);
				send_reply(st->fuse_fd, in->unique, 0, &out,
					   sizeof(out));
			} else {
				pthread_mutex_unlock(&st->lock);
				send_reply(st->fuse_fd, in->unique, -ENOENT,
					   NULL, 0);
			}
			break;
		}
		case FUSE_LOOKUP: {
			const char *name = body;
			struct fuse_entry_out out;
			memset(&out, 0, sizeof(out));
			out.entry_valid = 1;
			out.attr_valid = 1;
			pthread_mutex_lock(&st->lock);
			if (in->nodeid == FUSE_ROOT_ID &&
			    strcmp(name, "readme.txt") == 0) {
				out.nodeid = NODE_RO;
				out.generation = 1;
				fill_attr(&out.attr, NODE_RO, S_IFREG | 0444,
					  sizeof(ro_content) - 1, 1);
				pthread_mutex_unlock(&st->lock);
				send_reply(st->fuse_fd, in->unique, 0, &out,
					   sizeof(out));
			} else if (in->nodeid == FUSE_ROOT_ID &&
				   strcmp(name, "created.txt") == 0 &&
				   st->created_present) {
				out.nodeid = NODE_RW;
				out.generation = 1;
				fill_attr(&out.attr, NODE_RW, S_IFREG | 0644,
					  st->created_len, 1);
				pthread_mutex_unlock(&st->lock);
				send_reply(st->fuse_fd, in->unique, 0, &out,
					   sizeof(out));
			} else {
				pthread_mutex_unlock(&st->lock);
				send_reply(st->fuse_fd, in->unique, -ENOENT,
					   NULL, 0);
			}
			break;
		}
		case FUSE_OPENDIR:
		case FUSE_OPEN: {
			struct fuse_open_out out;
			memset(&out, 0, sizeof(out));
			out.fh = in->nodeid;
			send_reply(st->fuse_fd, in->unique, 0, &out,
				   sizeof(out));
			break;
		}
		case FUSE_READDIR: {
			const struct fuse_read_in *rin =
				(const struct fuse_read_in *)body;
			char dbuf[4096];
			size_t pos = 0;
			size_t cap = rin->size < sizeof(dbuf) ? rin->size
							      : sizeof(dbuf);
			pthread_mutex_lock(&st->lock);
			if (rin->offset < 1) {
				pos = append_dirent(dbuf, cap, pos, FUSE_ROOT_ID,
						    1, DT_DIR, ".");
			}
			if (rin->offset < 2) {
				pos = append_dirent(dbuf, cap, pos, FUSE_ROOT_ID,
						    2, DT_DIR, "..");
			}
			if (rin->offset < 3) {
				pos = append_dirent(dbuf, cap, pos, NODE_RO, 3,
						    DT_REG, "readme.txt");
			}
			if (rin->offset < 4 && st->created_present) {
				pos = append_dirent(dbuf, cap, pos, NODE_RW, 4,
						    DT_REG, "created.txt");
			}
			pthread_mutex_unlock(&st->lock);
			send_reply(st->fuse_fd, in->unique, 0, dbuf, pos);
			break;
		}
		case FUSE_CREATE: {
			const struct fuse_create_in *cin =
				(const struct fuse_create_in *)body;
			const char *name = body + sizeof(*cin);
			if (in->nodeid != FUSE_ROOT_ID ||
			    strcmp(name, "created.txt") != 0) {
				send_reply(st->fuse_fd, in->unique, -EACCES,
					   NULL, 0);
				break;
			}
			struct {
				struct fuse_entry_out entry;
				struct fuse_open_out open;
			} out;
			memset(&out, 0, sizeof(out));
			pthread_mutex_lock(&st->lock);
			st->created_present = 1;
			st->created_len = 0;
			out.entry.nodeid = NODE_RW;
			out.entry.generation = 1;
			out.entry.entry_valid = 1;
			out.entry.attr_valid = 1;
			fill_attr(&out.entry.attr, NODE_RW, S_IFREG | 0644, 0,
				  1);
			out.open.fh = NODE_RW;
			pthread_mutex_unlock(&st->lock);
			send_reply(st->fuse_fd, in->unique, 0, &out,
				   sizeof(out));
			break;
		}
		case FUSE_READ: {
			const struct fuse_read_in *rin =
				(const struct fuse_read_in *)body;
			const char *src = NULL;
			size_t total = 0;
			pthread_mutex_lock(&st->lock);
			if (in->nodeid == NODE_RO) {
				src = ro_content;
				total = sizeof(ro_content) - 1;
			} else if (in->nodeid == NODE_RW &&
				   st->created_present) {
				src = st->created_buf;
				total = st->created_len;
			}
			if (!src) {
				pthread_mutex_unlock(&st->lock);
				send_reply(st->fuse_fd, in->unique, -ENOENT,
					   NULL, 0);
				break;
			}
			size_t avail = 0;
			if (rin->offset < total) {
				avail = total - (size_t)rin->offset;
				if (avail > rin->size) avail = rin->size;
			}
			char tmp[4096];
			if (avail > sizeof(tmp)) avail = sizeof(tmp);
			if (avail > 0) memcpy(tmp, src + rin->offset, avail);
			pthread_mutex_unlock(&st->lock);
			send_reply(st->fuse_fd, in->unique, 0, tmp, avail);
			break;
		}
		case FUSE_WRITE: {
			const struct fuse_write_in *win =
				(const struct fuse_write_in *)body;
			const char *data = body + sizeof(*win);
			pthread_mutex_lock(&st->lock);
			if (in->nodeid != NODE_RW || !st->created_present) {
				pthread_mutex_unlock(&st->lock);
				send_reply(st->fuse_fd, in->unique, -EACCES,
					   NULL, 0);
				break;
			}
			size_t to_write = win->size;
			if (win->offset >= sizeof(st->created_buf)) {
				to_write = 0;
			} else if (win->offset + to_write >
				   sizeof(st->created_buf)) {
				to_write = sizeof(st->created_buf) -
					   (size_t)win->offset;
			}
			if (to_write > 0) {
				memcpy(st->created_buf + win->offset, data,
				       to_write);
				if ((size_t)win->offset + to_write >
				    st->created_len) {
					st->created_len =
						(size_t)win->offset + to_write;
				}
			}
			pthread_mutex_unlock(&st->lock);
			struct fuse_write_out out;
			memset(&out, 0, sizeof(out));
			out.size = (uint32_t)to_write;
			send_reply(st->fuse_fd, in->unique, 0, &out,
				   sizeof(out));
			break;
		}
		case FUSE_UNLINK: {
			const char *name = body;
			pthread_mutex_lock(&st->lock);
			if (in->nodeid == FUSE_ROOT_ID &&
			    strcmp(name, "created.txt") == 0 &&
			    st->created_present) {
				st->created_present = 0;
				st->created_len = 0;
				pthread_mutex_unlock(&st->lock);
				send_reply(st->fuse_fd, in->unique, 0, NULL, 0);
			} else {
				pthread_mutex_unlock(&st->lock);
				send_reply(st->fuse_fd, in->unique, -ENOENT,
					   NULL, 0);
			}
			break;
		}
		case FUSE_STATFS: {
			struct fuse_statfs_out out;
			memset(&out, 0, sizeof(out));
			out.st.blocks = 1024;
			out.st.bfree = 512;
			out.st.bavail = 512;
			out.st.bsize = 4096;
			out.st.namelen = 255;
			send_reply(st->fuse_fd, in->unique, 0, &out,
				   sizeof(out));
			break;
		}
		case FUSE_FLUSH:
		case FUSE_RELEASE:
		case FUSE_RELEASEDIR:
		case FUSE_FSYNC:
			send_reply(st->fuse_fd, in->unique, 0, NULL, 0);
			break;
		default:
			send_reply(st->fuse_fd, in->unique, -ENOSYS, NULL, 0);
			break;
		}
	}
	return NULL;
}

static int dir_has_entry(const char *path, const char *target)
{
	DIR *d = opendir(path);
	require(d != NULL, "opendir fuse mount");
	int found = 0;
	struct dirent *ent;
	while ((ent = readdir(d)) != NULL) {
		if (strcmp(ent->d_name, target) == 0) found = 1;
	}
	require(closedir(d) == 0, "closedir fuse mount");
	return found;
}

int main(void)
{
	setvbuf(stdout, NULL, _IONBF, 0);

	require(mkdir(MNT_DIR, 0755) == 0, "mkdir fuse mountpoint");

	struct fuse_state state;
	memset(&state, 0, sizeof(state));
	pthread_mutex_init(&state.lock, NULL);
	state.fuse_fd = open("/dev/fuse", O_RDWR | O_CLOEXEC);
	require(state.fuse_fd >= 0, "open /dev/fuse");

	pthread_t daemon;
	require(pthread_create(&daemon, NULL, fuse_daemon_main, &state) == 0,
		"pthread_create fuse daemon");

	char opts[128];
	int olen = snprintf(opts, sizeof(opts),
			    "fd=%d,rootmode=40000,user_id=0,group_id=0",
			    state.fuse_fd);
	require(olen > 0 && (size_t)olen < sizeof(opts), "format fuse opts");
	require(mount("fuse-test", MNT_DIR, "fuse", 0, opts) == 0,
		"mount fuse");

	require(dir_has_entry(MNT_DIR, "readme.txt"),
		"readdir sees readme.txt");

	int rfd = open(MNT_DIR "/readme.txt", O_RDONLY);
	require(rfd >= 0, "open readme.txt O_RDONLY");
	char buf[64] = { 0 };
	ssize_t rn = read(rfd, buf, sizeof(buf) - 1);
	require(rn == (ssize_t)(sizeof(ro_content) - 1) &&
			strcmp(buf, ro_content) == 0,
		"read readme.txt matches");
	require(close(rfd) == 0, "close readme.txt");

	const char *written = "fuse-written-v2";
	int wfd = open(MNT_DIR "/created.txt", O_CREAT | O_RDWR, 0644);
	require(wfd >= 0, "create created.txt O_CREAT|O_RDWR");
	require(write(wfd, written, strlen(written)) ==
			(ssize_t)strlen(written),
		"write created.txt");
	require(close(wfd) == 0, "close created.txt after write");

	require(dir_has_entry(MNT_DIR, "created.txt"),
		"readdir sees created.txt");

	int cfd = open(MNT_DIR "/created.txt", O_RDONLY);
	require(cfd >= 0, "reopen created.txt O_RDONLY");
	memset(buf, 0, sizeof(buf));
	rn = read(cfd, buf, sizeof(buf) - 1);
	require(rn == (ssize_t)strlen(written) && strcmp(buf, written) == 0,
		"read back created.txt matches");
	require(close(cfd) == 0, "close created.txt after read");

	require(unlink(MNT_DIR "/created.txt") == 0, "unlink created.txt");
	struct stat st;
	errno = 0;
	require(stat(MNT_DIR "/created.txt", &st) == -1 && errno == ENOENT,
		"stat created.txt after unlink returns ENOENT");

	require(umount2(MNT_DIR, 0) == 0, "umount2 fuse mount");
	require(close(state.fuse_fd) == 0, "close /dev/fuse");
	require(pthread_join(daemon, NULL) == 0, "pthread_join fuse daemon");
	require(rmdir(MNT_DIR) == 0, "rmdir fuse mountpoint");

	puts("fuse runtime: init, lookup, readdir, create, read, write, unlink and umount pass");
	return 0;
}
