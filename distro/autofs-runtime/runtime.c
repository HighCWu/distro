/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/auto_dev-ioctl.h>
#include <linux/magic.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <unistd.h>

static void check(int ok, const char *stage)
{
	if (ok)
		return;

	fprintf(stderr, "::vm-test::fail: autofs: %s (errno=%d)\n", stage, errno);
	exit(1);
}

static void verify_control_device(int control_fd)
{
	struct autofs_dev_ioctl arg;
	init_autofs_dev_ioctl(&arg);
	arg.ver_minor = 0;
	check(ioctl(control_fd, AUTOFS_DEV_IOCTL_VERSION, &arg) == 0,
	      "query control device version");
	check(arg.ver_major == AUTOFS_DEV_IOCTL_VERSION_MAJOR &&
	      arg.ver_minor == AUTOFS_DEV_IOCTL_VERSION_MINOR,
	      "control device version response");
}

static void verify_mount_controls(int control_fd, int mount_fd)
{
	struct autofs_dev_ioctl arg;
	init_autofs_dev_ioctl(&arg);
	arg.ioctlfd = mount_fd;
	check(ioctl(control_fd, AUTOFS_DEV_IOCTL_PROTOVER, &arg) == 0 &&
	      arg.protover.version == 5, "query mounted protocol version");

	init_autofs_dev_ioctl(&arg);
	arg.ioctlfd = mount_fd;
	arg.timeout.timeout = 37;
	check(ioctl(control_fd, AUTOFS_DEV_IOCTL_TIMEOUT, &arg) == 0 &&
	      arg.timeout.timeout == 0, "set mount expiry timeout");
	arg.timeout.timeout = 0;
	check(ioctl(control_fd, AUTOFS_DEV_IOCTL_TIMEOUT, &arg) == 0 &&
	      arg.timeout.timeout == 37, "restore and verify mount expiry timeout");
}

int main(void)
{
	const char mountpoint[] = "/tmp/autofs-runtime";
	int pipe_fds[2];
	char options[80];

	check(mount("devtmpfs", "/dev", "devtmpfs", MS_NOSUID, NULL) == 0,
	      "mount devtmpfs");
	int control_fd = open("/dev/" AUTOFS_DEVICE_NAME, O_RDONLY | O_CLOEXEC);
	check(control_fd >= 0, "open autofs control device");
	verify_control_device(control_fd);
	check(mkdir(mountpoint, 0700) == 0, "create mountpoint");
	check(pipe2(pipe_fds, O_CLOEXEC) == 0, "create daemon notification pipe");
	int length = snprintf(options, sizeof(options), "fd=%d,minproto=5,maxproto=5,indirect",
			      pipe_fds[1]);
	check(length >= 0 && (size_t)length < sizeof(options), "format mount options");
	check(mount("autofs-test", mountpoint, "autofs", MS_NOSUID | MS_NODEV, options) == 0,
	      "mount indirect autofs");
	check(close(pipe_fds[1]) == 0, "close daemon's copy of the pipe writer");

	int mount_fd = open(mountpoint, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
	check(mount_fd >= 0, "open mounted autofs root");
	struct statfs status;
	check(fstatfs(mount_fd, &status) == 0 && status.f_type == AUTOFS_SUPER_MAGIC,
	      "confirm the autofs filesystem is mounted");
	verify_mount_controls(control_fd, mount_fd);
	puts("autofs: protocol 5 mount and expiry timeout round-trip pass");

	struct pollfd reader = {.fd = pipe_fds[0], .events = POLLIN};
	check(poll(&reader, 1, 0) == 0, "active mount must retain the notification writer");
	struct autofs_dev_ioctl arg;
	init_autofs_dev_ioctl(&arg);
	arg.ioctlfd = mount_fd;
	check(ioctl(control_fd, AUTOFS_DEV_IOCTL_CATATONIC, &arg) == 0, "deactivate mount");
	check(poll(&reader, 1, 1000) == 1 && (reader.revents & POLLHUP),
	      "deactivation must release the notification writer");

	check(close(pipe_fds[0]) == 0, "close notification reader");
	check(close(mount_fd) == 0, "close mounted root");
	check(close(control_fd) == 0, "close autofs control device");
	check(umount(mountpoint) == 0, "unmount autofs");
	check(rmdir(mountpoint) == 0, "remove the underlying mountpoint");
	check(umount("/dev") == 0, "unmount devtmpfs");
	puts("autofs: deactivation, notification pipe release and unmount pass");
	puts("::vm-test::pass");
	fflush(stdout);
	for (;;)
		sleep(1);
}
