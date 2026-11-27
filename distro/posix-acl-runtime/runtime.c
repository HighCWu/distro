#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/xattr.h>
#include <unistd.h>

#define EXT4_SUPER_MAGIC_VAL 0xEF53UL
#define POSIX_ACL_XATTR_VERSION 2U
#define ACL_UNDEFINED_ID 0xFFFFFFFFU

#define ACL_USER_OBJ 0x01U
#define ACL_USER 0x02U
#define ACL_GROUP_OBJ 0x04U
#define ACL_MASK 0x10U
#define ACL_OTHER 0x20U

#define XATTR_ACL_ACCESS "system.posix_acl_access"
#define XATTR_ACL_DEFAULT "system.posix_acl_default"

struct posix_acl_entry_le {
  uint16_t e_tag;
  uint16_t e_perm;
  uint32_t e_id;
};

struct posix_acl_xattr_5 {
  uint32_t a_version;
  struct posix_acl_entry_le entries[5];
};

static void require(int ok, const char *what) {
  if (ok) {
    return;
  }
  fprintf(stderr, "posix-acl-runtime: %s (errno=%d: %s)\n", what, errno,
          strerror(errno));
  exit(1);
}

static void fill_acl_5(struct posix_acl_xattr_5 *acl, uint16_t owner_perm,
                       uint32_t named_uid, uint16_t named_perm,
                       uint16_t group_perm, uint16_t mask_perm,
                       uint16_t other_perm) {
  memset(acl, 0, sizeof(*acl));
  acl->a_version = POSIX_ACL_XATTR_VERSION;
  acl->entries[0] = (struct posix_acl_entry_le){
      .e_tag = ACL_USER_OBJ, .e_perm = owner_perm, .e_id = ACL_UNDEFINED_ID};
  acl->entries[1] = (struct posix_acl_entry_le){
      .e_tag = ACL_USER, .e_perm = named_perm, .e_id = named_uid};
  acl->entries[2] = (struct posix_acl_entry_le){
      .e_tag = ACL_GROUP_OBJ, .e_perm = group_perm, .e_id = ACL_UNDEFINED_ID};
  acl->entries[3] = (struct posix_acl_entry_le){
      .e_tag = ACL_MASK, .e_perm = mask_perm, .e_id = ACL_UNDEFINED_ID};
  acl->entries[4] = (struct posix_acl_entry_le){
      .e_tag = ACL_OTHER, .e_perm = other_perm, .e_id = ACL_UNDEFINED_ID};
}

static void verify_acl_has_named_user(const char *path, const char *attr_name,
                                      uint32_t expected_uid,
                                      uint16_t expected_perm) {
  struct posix_acl_xattr_5 got;
  memset(&got, 0, sizeof(got));
  ssize_t n = getxattr(path, attr_name, &got, sizeof(got));
  require(n == (ssize_t)sizeof(got), "getxattr acl size");
  require(got.a_version == POSIX_ACL_XATTR_VERSION, "acl version");

  int found_user = 0;
  int found_mask = 0;
  for (size_t i = 0; i < 5; i++) {
    if (got.entries[i].e_tag == ACL_USER &&
        got.entries[i].e_id == expected_uid &&
        got.entries[i].e_perm == expected_perm) {
      found_user = 1;
    }
    if (got.entries[i].e_tag == ACL_MASK) {
      found_mask = 1;
    }
  }
  require(found_user && found_mask, "acl named user and mask present");
}

static int listxattr_contains(const char *path, const char *target) {
  char buf[512];
  ssize_t n = listxattr(path, buf, sizeof(buf));
  require(n > 0, "listxattr");
  size_t pos = 0;
  while (pos < (size_t)n) {
    const char *name = buf + pos;
    if (strcmp(name, target) == 0) {
      return 1;
    }
    pos += strlen(name) + 1;
  }
  return 0;
}

int main(void) {
  require(mount("/dev/vda", "/mnt", "ext4", 0, "acl") == 0,
          "mount(/dev/vda, ext4, acl)");

  struct statfs sfs;
  require(statfs("/mnt", &sfs) == 0, "statfs(/mnt)");
  require((unsigned long)sfs.f_type == EXT4_SUPER_MAGIC_VAL,
          "ext4 super magic");

  require(mkdir("/mnt/acl_dir", 0755) == 0, "mkdir(/mnt/acl_dir)");
  int fd = open("/mnt/acl_file", O_CREAT | O_RDWR | O_CLOEXEC, 0644);
  require(fd >= 0, "open(/mnt/acl_file)");
  require(close(fd) == 0, "close(/mnt/acl_file)");

  struct posix_acl_xattr_5 file_acl;
  fill_acl_5(&file_acl, 6U, 1000U, 4U, 4U, 6U, 0U);
  require(setxattr("/mnt/acl_file", XATTR_ACL_ACCESS, &file_acl,
                   sizeof(file_acl), 0) == 0,
          "setxattr(acl_file access)");
  require(listxattr_contains("/mnt/acl_file", XATTR_ACL_ACCESS),
          "listxattr(acl_file access)");
  verify_acl_has_named_user("/mnt/acl_file", XATTR_ACL_ACCESS, 1000U, 4U);

  struct posix_acl_xattr_5 dir_default_acl;
  fill_acl_5(&dir_default_acl, 7U, 1000U, 5U, 5U, 7U, 0U);
  require(setxattr("/mnt/acl_dir", XATTR_ACL_DEFAULT, &dir_default_acl,
                   sizeof(dir_default_acl), 0) == 0,
          "setxattr(acl_dir default)");
  require(listxattr_contains("/mnt/acl_dir", XATTR_ACL_DEFAULT),
          "listxattr(acl_dir default)");

  int child_fd = open("/mnt/acl_dir/child.txt", O_CREAT | O_RDWR | O_CLOEXEC,
                      0666);
  require(child_fd >= 0, "open(/mnt/acl_dir/child.txt)");
  require(close(child_fd) == 0, "close(child.txt)");
  verify_acl_has_named_user("/mnt/acl_dir/child.txt", XATTR_ACL_ACCESS, 1000U,
                            5U);

  require(mkdir("/mnt/acl_dir/sub", 0777) == 0, "mkdir(/mnt/acl_dir/sub)");
  verify_acl_has_named_user("/mnt/acl_dir/sub", XATTR_ACL_ACCESS, 1000U, 5U);
  verify_acl_has_named_user("/mnt/acl_dir/sub", XATTR_ACL_DEFAULT, 1000U, 5U);

  require(removexattr("/mnt/acl_dir", XATTR_ACL_DEFAULT) == 0,
          "removexattr(acl_dir default)");
  char tmp_buf[64];
  ssize_t rem = getxattr("/mnt/acl_dir", XATTR_ACL_DEFAULT, tmp_buf,
                         sizeof(tmp_buf));
  require(rem < 0 && errno == ENODATA, "getxattr after remove default ENODATA");

  require(removexattr("/mnt/acl_file", XATTR_ACL_ACCESS) == 0,
          "removexattr(acl_file access)");
  rem = getxattr("/mnt/acl_file", XATTR_ACL_ACCESS, tmp_buf, sizeof(tmp_buf));
  require(rem < 0 && errno == ENODATA, "getxattr after remove access ENODATA");

  require(unlink("/mnt/acl_dir/child.txt") == 0, "unlink(child.txt)");
  require(rmdir("/mnt/acl_dir/sub") == 0, "rmdir(sub)");
  require(rmdir("/mnt/acl_dir") == 0, "rmdir(acl_dir)");
  require(unlink("/mnt/acl_file") == 0, "unlink(acl_file)");
  require(umount("/mnt") == 0, "umount(/mnt)");

  printf("posix-acl-runtime: ok magic=0x%lx uid=1000 inherited+removed\n",
         (unsigned long)sfs.f_type);
  return 0;
}
