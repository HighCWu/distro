/* SPDX-License-Identifier: MIT */
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/acl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

enum {
  ACL_TEST_UID = 1001,
  PERM_READ = 1,
  PERM_WRITE = 2,
  PERM_EXECUTE = 4,
};

static const char payload[] = "POSIX ACL named-user read works\n";

static int fail(const char *message) {
  fprintf(stderr, "acl runtime failure: %s: %s\n", message, strerror(errno));
  return 1;
}

static int set_entry_permissions(acl_entry_t entry, unsigned int flags) {
  acl_permset_t permissions;

  if (acl_get_permset(entry, &permissions) == -1 || acl_clear_perms(permissions) == -1)
    return -1;
  if ((flags & PERM_READ) != 0 && acl_add_perm(permissions, ACL_READ) == -1)
    return -1;
  if ((flags & PERM_WRITE) != 0 && acl_add_perm(permissions, ACL_WRITE) == -1)
    return -1;
  if ((flags & PERM_EXECUTE) != 0 && acl_add_perm(permissions, ACL_EXECUTE) == -1)
    return -1;
  return acl_set_permset(entry, permissions);
}

static int append_entry(acl_t *acl, acl_tag_t tag, unsigned int flags, int has_qualifier,
                        uid_t qualifier) {
  acl_entry_t entry;

  if (acl_create_entry(acl, &entry) == -1 || acl_set_tag_type(entry, tag) == -1)
    return -1;
  if (has_qualifier && acl_set_qualifier(entry, &qualifier) == -1)
    return -1;
  return set_entry_permissions(entry, flags);
}

static int text_entry_has_permissions(const char *line, size_t length, acl_tag_t tag,
                                      unsigned int expected) {
  const char *prefix;
  size_t prefix_length;
  char expected_permissions[3];

  switch (tag) {
    case ACL_USER_OBJ:
      prefix = "user::";
      break;
    case ACL_USER:
      prefix = "user:";
      break;
    case ACL_GROUP_OBJ:
      prefix = "group::";
      break;
    case ACL_MASK:
      prefix = "mask::";
      break;
    case ACL_OTHER:
      prefix = "other::";
      break;
    default:
      return 0;
  }

  prefix_length = strlen(prefix);
  if (length < prefix_length + 3 || memcmp(line, prefix, prefix_length) != 0 ||
      line[length - 4] != ':')
    return 0;
  if (tag == ACL_USER) {
    const char *qualifier_end = memchr(line + prefix_length, ':', length - prefix_length);
    if (qualifier_end == NULL || qualifier_end == line + prefix_length ||
        qualifier_end != line + length - 4)
      return 0;
  } else if (length != prefix_length + 3) {
    return 0;
  }

  expected_permissions[0] = (expected & PERM_READ) != 0 ? 'r' : '-';
  expected_permissions[1] = (expected & PERM_WRITE) != 0 ? 'w' : '-';
  expected_permissions[2] = (expected & PERM_EXECUTE) != 0 ? 'x' : '-';
  return memcmp(line + length - 3, expected_permissions, sizeof(expected_permissions)) == 0;
}

static int verify_acl(const char *path, int expect_named_user) {
  acl_t acl = acl_get_file(path, ACL_TYPE_ACCESS);
  acl_entry_t entry;
  acl_tag_t expected_tags[5];
  unsigned int expected_permissions[5];
  unsigned int seen = 0;
  int entry_count = 0;
  int result;

  if (acl == NULL)
    return fail("acl_get_file");
  if (acl_valid(acl) == -1) {
    acl_free(acl);
    return fail("acl_valid after read");
  }

  result = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry);
  while (result == 1) {
    acl_tag_t tag;
    unsigned int flags;
    unsigned int bit;

    if (acl_get_tag_type(entry, &tag) == -1) {
      acl_free(acl);
      return fail("acl_get_tag_type");
    }
    switch (tag) {
      case ACL_USER_OBJ:
        bit = 1u << 0;
        flags = PERM_READ | PERM_WRITE;
        break;
      case ACL_USER: {
        uid_t *qualifier = acl_get_qualifier(entry);
        if (qualifier == NULL) {
          acl_free(acl);
          return fail("acl_get_qualifier");
        }
        if (!expect_named_user || *qualifier != (uid_t)ACL_TEST_UID) {
          acl_free(qualifier);
          acl_free(acl);
          fprintf(stderr, "acl runtime failure: unexpected named ACL user\n");
          return 1;
        }
        acl_free(qualifier);
        bit = 1u << 1;
        flags = PERM_READ;
        break;
      }
      case ACL_GROUP_OBJ:
        bit = 1u << 2;
        flags = 0;
        break;
      case ACL_MASK:
        bit = 1u << 3;
        flags = PERM_READ;
        break;
      case ACL_OTHER:
        bit = 1u << 4;
        flags = 0;
        break;
      default:
        acl_free(acl);
        fprintf(stderr, "acl runtime failure: unexpected ACL tag %d\n", (int)tag);
        return 1;
    }

    if ((seen & bit) != 0) {
      acl_free(acl);
      fprintf(stderr, "acl runtime failure: duplicate ACL entry\n");
      return 1;
    }
    seen |= bit;
    expected_tags[entry_count] = tag;
    expected_permissions[entry_count] = flags;
    entry_count++;
    result = acl_get_entry(acl, ACL_NEXT_ENTRY, &entry);
  }
  if (result == -1) {
    acl_free(acl);
    return fail("acl_get_entry");
  }

  if (seen != (expect_named_user ? 0x1fu : 0x1du) ||
      entry_count != (expect_named_user ? 5 : 4)) {
    acl_free(acl);
    fprintf(stderr, "acl runtime failure: expected %d entries, observed %d (mask 0x%x)\n",
            expect_named_user ? 5 : 4, entry_count, seen);
    return 1;
  }

  {
    char *text = acl_to_text(acl, NULL);
    const char *line = text;
    int index;

    if (text == NULL) {
      acl_free(acl);
      return fail("acl_to_text after read");
    }
    for (index = 0; index < entry_count; index++) {
      const char *line_end = strchr(line, '\n');
      size_t line_length = line_end != NULL ? (size_t)(line_end - line) : strlen(line);

      if (!text_entry_has_permissions(line, line_length, expected_tags[index],
                                       expected_permissions[index])) {
        acl_free(text);
        acl_free(acl);
        fprintf(stderr, "acl runtime failure: ACL entry permissions differ from expectation\n");
        return 1;
      }
      line = line_end != NULL ? line_end + 1 : line + line_length;
    }
    if (*line != '\0') {
      acl_free(text);
      acl_free(acl);
      fprintf(stderr, "acl runtime failure: ACL text contains unexpected entries\n");
      return 1;
    }
    acl_free(text);
  }
  acl_free(acl);
  return 0;
}

static int read_payload(int fd) {
  char buffer[sizeof(payload)];
  size_t offset = 0;

  while (offset < sizeof(payload) - 1) {
    ssize_t count = read(fd, buffer + offset, sizeof(payload) - 1 - offset);
    if (count < 0 && errno == EINTR)
      continue;
    if (count <= 0)
      _exit(31);
    offset += (size_t)count;
  }
  if (memcmp(buffer, payload, sizeof(payload) - 1) != 0)
    _exit(32);
  for (;;) {
    char extra;
    ssize_t count = read(fd, &extra, sizeof(extra));
    if (count < 0 && errno == EINTR)
      continue;
    if (count != 0)
      _exit(33);
    break;
  }
  return 0;
}

static void child_check_permissions(const char *path, int expect_read) {
  int fd;

  if (setgid((gid_t)ACL_TEST_UID) == -1)
    _exit(10);
  if (setuid((uid_t)ACL_TEST_UID) == -1)
    _exit(11);
  if (getgid() != (gid_t)ACL_TEST_UID || geteuid() != (uid_t)ACL_TEST_UID)
    _exit(12);

  fd = open(path, O_RDONLY | O_CLOEXEC);
  if (expect_read) {
    if (fd == -1)
      _exit(20);
    (void)read_payload(fd);
    if (close(fd) == -1)
      _exit(34);
    fd = open(path, O_WRONLY | O_CLOEXEC);
    if (fd != -1) {
      (void)close(fd);
      _exit(35);
    }
    if (errno != EACCES)
      _exit(36);
    _exit(0);
  }

  if (fd != -1) {
    (void)close(fd);
    _exit(40);
  }
  if (errno != EACCES)
    _exit(41);
  _exit(0);
}

static int run_child_check(const char *path, int expect_read) {
  uid_t uid_before = getuid();
  uid_t euid_before = geteuid();
  gid_t gid_before = getgid();
  gid_t egid_before = getegid();
  pid_t child = fork();
  int status;
  pid_t waited;

  if (child == -1)
    return fail("fork");
  if (child == 0)
    child_check_permissions(path, expect_read);

  do {
    waited = waitpid(child, &status, 0);
  } while (waited == -1 && errno == EINTR);
  if (waited == -1)
    return fail("waitpid");
  if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
    if (WIFEXITED(status))
      fprintf(stderr, "acl runtime failure: child exited with status %d\n", WEXITSTATUS(status));
    else
      fprintf(stderr, "acl runtime failure: child did not exit normally\n");
    return 1;
  }
  if (getuid() != uid_before || geteuid() != euid_before || getgid() != gid_before ||
      getegid() != egid_before) {
    fprintf(stderr, "acl runtime failure: parent credentials changed across child check\n");
    return 1;
  }
  return 0;
}

static int remove_named_user(const char *path) {
  acl_t acl = acl_get_file(path, ACL_TYPE_ACCESS);
  acl_entry_t entry;
  acl_entry_t target = NULL;
  int result;

  if (acl == NULL)
    return fail("acl_get_file before removal");
  result = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry);
  while (result == 1) {
    acl_tag_t tag;
    if (acl_get_tag_type(entry, &tag) == -1) {
      acl_free(acl);
      return fail("acl_get_tag_type before removal");
    }
    if (tag == ACL_USER) {
      uid_t *qualifier = acl_get_qualifier(entry);
      if (qualifier == NULL) {
        acl_free(acl);
        return fail("acl_get_qualifier before removal");
      }
      if (*qualifier == (uid_t)ACL_TEST_UID) {
        if (target != NULL) {
          acl_free(qualifier);
          acl_free(acl);
          fprintf(stderr, "acl runtime failure: duplicate named ACL user before removal\n");
          return 1;
        }
        target = entry;
      }
      acl_free(qualifier);
    }
    result = acl_get_entry(acl, ACL_NEXT_ENTRY, &entry);
  }
  if (result == -1) {
    acl_free(acl);
    return fail("acl_get_entry before removal");
  }
  if (target == NULL || acl_delete_entry(acl, target) == -1 || acl_valid(acl) == -1) {
    acl_free(acl);
    return fail("removing named ACL user");
  }
  if (acl_set_file(path, ACL_TYPE_ACCESS, acl) == -1) {
    acl_free(acl);
    return fail("acl_set_file after removal");
  }
  acl_free(acl);
  return 0;
}

int main(int argc, char **argv) {
  const char *path;
  struct stat info;
  int fd;
  acl_t acl;

  if (argc != 2) {
    fprintf(stderr, "usage: %s FILE\n", argv[0]);
    return 2;
  }
  path = argv[1];
  if (getuid() != 0 || geteuid() != 0) {
    fprintf(stderr, "acl runtime failure: test must begin as uid 0\n");
    return 1;
  }

  fd = open(path, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
  if (fd == -1)
    return fail("creating root-owned ACL fixture");
  if (fchown(fd, (uid_t)0, (gid_t)0) == -1 || fstat(fd, &info) == -1) {
    (void)close(fd);
    (void)unlink(path);
    return fail("setting or reading fixture ownership");
  }
  if (info.st_uid != 0 || info.st_gid != 0) {
    (void)close(fd);
    (void)unlink(path);
    fprintf(stderr, "acl runtime failure: fixture is not owned by uid/gid 0\n");
    return 1;
  }
  if (write(fd, payload, sizeof(payload) - 1) != (ssize_t)(sizeof(payload) - 1) ||
      fsync(fd) == -1 || close(fd) == -1)
    return fail("writing ACL fixture");

  acl = acl_init(5);
  if (acl == NULL)
    return fail("acl_init");
  if (append_entry(&acl, ACL_USER_OBJ, PERM_READ | PERM_WRITE, 0, 0) == -1 ||
      append_entry(&acl, ACL_USER, PERM_READ, 1, (uid_t)ACL_TEST_UID) == -1 ||
      append_entry(&acl, ACL_GROUP_OBJ, 0, 0, 0) == -1 ||
      append_entry(&acl, ACL_MASK, PERM_READ, 0, 0) == -1 ||
      append_entry(&acl, ACL_OTHER, 0, 0, 0) == -1 || acl_valid(acl) == -1) {
    acl_free(acl);
    (void)unlink(path);
    return fail("building the POSIX access ACL");
  }
  if (acl_set_file(path, ACL_TYPE_ACCESS, acl) == -1) {
    acl_free(acl);
    (void)unlink(path);
    return fail("acl_set_file");
  }
  acl_free(acl);
  if (verify_acl(path, 1) != 0)
    return 1;
  if (stat(path, &info) == -1)
    return fail("stat after setting ACL");
  if ((info.st_mode & 0777) != 0640) {
    fprintf(stderr, "acl runtime failure: ACL mask did not produce mode 0640 (got %04o)\n",
            (unsigned int)(info.st_mode & 0777));
    return 1;
  }
  puts("acl: requested access entries and mode mask were read back");

  if (run_child_check(path, 1) != 0)
    return 1;
  puts("acl: uid/gid 1001 read the payload, write was EACCES, and parent credentials stayed root");

  if (remove_named_user(path) != 0 || verify_acl(path, 0) != 0)
    return 1;
  if (run_child_check(path, 0) != 0)
    return 1;
  puts("acl: removing the named user denied the next child read and the child was reaped");

  if (unlink(path) == -1)
    return fail("removing ACL fixture");
  return 0;
}
