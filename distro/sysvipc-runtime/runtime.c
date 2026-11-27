/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ipc.h>
#include <sys/msg.h>
#include <sys/sem.h>

static int sem_id = -1;
static int msg_id = -1;

struct test_msg {
	long mtype;
	char mtext[32];
};

union semun_val {
	int val;
	struct semid_ds *buf;
	unsigned short *array;
};

static void cleanup(void)
{
	if (sem_id >= 0) {
		(void)semctl(sem_id, 0, IPC_RMID);
		sem_id = -1;
	}
	if (msg_id >= 0) {
		(void)msgctl(msg_id, IPC_RMID, NULL);
		msg_id = -1;
	}
}

static void fail(const char *stage)
{
	int saved_errno = errno;

	fprintf(stderr, "linux sysvipc: %s failed (errno=%d)\n", stage,
		saved_errno);
	cleanup();
	errno = saved_errno;
	exit(1);
}

#define CHECK(condition, stage) do { if (!(condition)) fail(stage); } while (0)

int main(void)
{
	sem_id = semget(IPC_PRIVATE, 1, IPC_CREAT | 0600);
	CHECK(sem_id >= 0, "semget");

	union semun_val arg = { .val = 2 };
	CHECK(semctl(sem_id, 0, SETVAL, arg) == 0, "semctl SETVAL");
	CHECK(semctl(sem_id, 0, GETVAL) == 2, "semctl GETVAL");

	struct sembuf op_dec = { .sem_num = 0, .sem_op = -2, .sem_flg = IPC_NOWAIT };
	CHECK(semop(sem_id, &op_dec, 1) == 0, "semop -2");
	CHECK(semctl(sem_id, 0, GETVAL) == 0, "semctl GETVAL == 0");

	struct sembuf op_try = { .sem_num = 0, .sem_op = -1, .sem_flg = IPC_NOWAIT };
	errno = 0;
	CHECK(semop(sem_id, &op_try, 1) == -1 && errno == EAGAIN,
	      "semop IPC_NOWAIT empty -> EAGAIN");

	msg_id = msgget(IPC_PRIVATE, IPC_CREAT | 0600);
	CHECK(msg_id >= 0, "msgget");

	struct test_msg send1 = { .mtype = 1, .mtext = "sysv-msg-1" };
	struct test_msg send2 = { .mtype = 2, .mtext = "sysv-msg-2" };
	CHECK(msgsnd(msg_id, &send1, sizeof(send1.mtext), IPC_NOWAIT) == 0,
	      "msgsnd type 1");
	CHECK(msgsnd(msg_id, &send2, sizeof(send2.mtext), IPC_NOWAIT) == 0,
	      "msgsnd type 2");

	struct test_msg recv_buf;
	memset(&recv_buf, 0, sizeof(recv_buf));
	ssize_t n = msgrcv(msg_id, &recv_buf, sizeof(recv_buf.mtext), 2,
			   IPC_NOWAIT);
	CHECK(n == (ssize_t)sizeof(recv_buf.mtext), "msgrcv type 2 len");
	CHECK(recv_buf.mtype == 2 && strcmp(recv_buf.mtext, "sysv-msg-2") == 0,
	      "msgrcv type 2 payload");

	memset(&recv_buf, 0, sizeof(recv_buf));
	n = msgrcv(msg_id, &recv_buf, sizeof(recv_buf.mtext), 1, IPC_NOWAIT);
	CHECK(n == (ssize_t)sizeof(recv_buf.mtext), "msgrcv type 1 len");
	CHECK(recv_buf.mtype == 1 && strcmp(recv_buf.mtext, "sysv-msg-1") == 0,
	      "msgrcv type 1 payload");

	errno = 0;
	CHECK(msgrcv(msg_id, &recv_buf, sizeof(recv_buf.mtext), 0, IPC_NOWAIT) ==
	      -1 && errno == ENOMSG,
	      "msgrcv empty -> ENOMSG");

	cleanup();
	puts("LINUX_SYSVIPC_OK sem=0 msg=2,1");
	return 0;
}
