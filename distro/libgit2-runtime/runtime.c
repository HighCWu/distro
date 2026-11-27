// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <git2.h>

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

static const char first_contents[] = "libgit2 runtime: first commit\n";
static const char second_contents[] = "libgit2 runtime: second commit\n";
static const char dirty_contents[] = "uncommitted local change\n";

static void
fail(const char *operation)
{
	const git_error *error = git_error_last();
	fprintf(stderr, "libgit2-runtime: %s", operation);
	if (error != NULL && error->message != NULL)
		fprintf(stderr, ": %s", error->message);
	fputc('\n', stderr);
	printf("::vm-test::fail: libgit2-runtime: %s\n", operation);
	fflush(stdout);
	exit(1);
}

static void
require_git(int result, const char *operation)
{
	if (result < 0)
		fail(operation);
}

static void
require(int condition, const char *operation)
{
	if (!condition)
		fail(operation);
}

static void
join_path(char *out, size_t out_size, const char *directory, const char *name)
{
	int length = snprintf(out, out_size, "%s/%s", directory, name);
	if (length < 0 || (size_t)length >= out_size)
		fail("format temporary path");
}

static void
write_file(const char *path, const char *contents)
{
	int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
	if (fd < 0)
		fail("create worktree file");

	size_t remaining = strlen(contents);
	const char *cursor = contents;
	while (remaining > 0) {
		ssize_t written = write(fd, cursor, remaining);
		if (written < 0 && errno == EINTR)
			continue;
		if (written <= 0) {
			(void)close(fd);
			fail("write worktree file");
		}
		cursor += written;
		remaining -= (size_t)written;
	}

	if (close(fd) != 0)
		fail("close worktree file");
}

static int
file_equals(const char *path, const char *contents)
{
	int fd = open(path, O_RDONLY);
	if (fd < 0)
		fail("open worktree file");

	const size_t expected_size = strlen(contents);
	char buffer[128];
	size_t total = 0;
	int equal = 1;
	for (;;) {
		ssize_t count = read(fd, buffer, sizeof(buffer));
		if (count < 0 && errno == EINTR)
			continue;
		if (count < 0) {
			(void)close(fd);
			fail("read worktree file");
		}
		if (count == 0)
			break;
		if ((size_t)count > expected_size - total) {
			equal = 0;
			break;
		}
		if (memcmp(buffer, contents + total, (size_t)count) != 0)
			equal = 0;
		total += (size_t)count;
	}

	if (close(fd) != 0)
		fail("close worktree file after read");
	return equal && total == expected_size;
}

static void
make_commit(
	git_repository *repo,
	git_index *index,
	git_signature *signature,
	const char *worktree_file,
	const char *contents,
	const char *message,
	const git_oid *parent_oid,
	git_oid *commit_oid,
	git_oid *blob_oid)
{
	git_oid tree_oid;
	git_tree *tree = NULL;
	git_commit *parent = NULL;
	const git_commit *parents[1];
	size_t parent_count = 0;

	write_file(worktree_file, contents);
	require_git(git_index_add_bypath(index, "README.txt"), "stage worktree file");
	require_git(git_index_write(index), "write repository index");
	require_git(git_index_write_tree(&tree_oid, index), "write index tree");
	require_git(git_tree_lookup(&tree, repo, &tree_oid), "read index tree");

	if (parent_oid != NULL) {
		require_git(git_commit_lookup(&parent, repo, parent_oid), "lookup parent commit");
		parents[parent_count++] = parent;
	}

	const git_tree_entry *entry = git_tree_entry_byname(tree, "README.txt");
	require(entry != NULL, "find README blob in tree");
	git_oid_cpy(blob_oid, git_tree_entry_id(entry));
	require_git(git_commit_create(commit_oid, repo, "HEAD", signature, signature,
		"UTF-8", message, tree, parent_count, parents), "write repository commit");

	git_commit_free(parent);
	git_tree_free(tree);
}

static void
make_pack_only_objects(const char *base, const git_oid *commit_oid,
	git_repository *repo, const git_oid *blob_oid, const char *blob_contents)
{
	char objects_path[512];
	char pack_path[512];
	char pack_file[768];
	char index_file[768];
	struct stat pack_stat;
	struct stat index_stat;
	git_packbuilder *builder = NULL;
	git_odb *packed_odb = NULL;
	git_odb_object *object = NULL;

	join_path(objects_path, sizeof(objects_path), base, "packed-only-objects");
	require(mkdir(objects_path, 0700) == 0, "create isolated packed object database");
	join_path(pack_path, sizeof(pack_path), objects_path, "pack");
	require(mkdir(pack_path, 0700) == 0, "create pack directory");

	require_git(git_packbuilder_new(&builder, repo), "create pack builder");
	require_git(git_packbuilder_insert_commit(builder, commit_oid),
		"add commit graph to pack");
	require_git(git_packbuilder_write(builder, pack_path, 0644, NULL, NULL),
		"write pack and index");

	const char *pack_name = git_packbuilder_name(builder);
	require(pack_name != NULL && pack_name[0] != '\0', "get generated pack name");
	int pack_length = snprintf(pack_file, sizeof(pack_file), "%s/pack-%s.pack",
		pack_path, pack_name);
	int index_length = snprintf(index_file, sizeof(index_file), "%s/pack-%s.idx",
		pack_path, pack_name);
	require(pack_length >= 0 && (size_t)pack_length < sizeof(pack_file),
		"format generated pack path");
	require(index_length >= 0 && (size_t)index_length < sizeof(index_file),
		"format generated index path");
	require(stat(pack_file, &pack_stat) == 0 && pack_stat.st_size > 0,
		"verify generated pack file");
	require(stat(index_file, &index_stat) == 0 && index_stat.st_size > 0,
		"verify generated pack index");

	require_git(git_odb_new(&packed_odb), "create packed-only ODB");
	require_git(git_odb_add_disk_alternate(packed_odb, objects_path),
		"open packed-only ODB");
	require_git(git_odb_read(&object, packed_odb, blob_oid),
		"read blob through pack index");
	require(git_odb_object_type(object) == GIT_OBJECT_BLOB,
		"packed object has blob type");
	const void *data = git_odb_object_data(object);
	size_t data_size = git_odb_object_size(object);
	size_t expected_size = strlen(blob_contents);
	require(data != NULL && data_size == expected_size &&
		memcmp(data, blob_contents, expected_size) == 0,
		"packed blob bytes match committed content");

	git_odb_object_free(object);
	git_odb_free(packed_odb);
	git_packbuilder_free(builder);
}

int
main(void)
{
	char temporary_dir[] = "/tmp/libgit2-runtime-XXXXXX";
	char repo_path[512];
	char worktree_file[768];
	char pack_root[512];
	char main_ref[128];
	const char *topic_ref_name;
	git_repository_init_options init_options;
	git_checkout_options checkout_options;
	git_repository *repo = NULL;
	git_index *index = NULL;
	git_signature *signature = NULL;
	git_reference *head_ref = NULL;
	git_reference *topic_ref = NULL;
	git_commit *first_commit = NULL;
	git_tree *first_tree = NULL;
	git_tree *second_tree = NULL;
	git_oid first_commit_oid;
	git_oid second_commit_oid;
	git_oid second_blob_oid;
	int conflict_status;

	if (mkdir("/tmp", 0700) != 0 && errno != EEXIST)
		fail("create temporary parent");
	require(mkdtemp(temporary_dir) != NULL, "create isolated runtime directory");
	join_path(repo_path, sizeof(repo_path), temporary_dir, "repo");
	require_git(git_libgit2_init(), "initialize libgit2");
	require_git(git_repository_init_options_init(&init_options,
		GIT_REPOSITORY_INIT_OPTIONS_VERSION), "initialize repository options");
	init_options.flags = GIT_REPOSITORY_INIT_MKPATH;
	init_options.initial_head = "main";
	require_git(git_repository_init_ext(&repo, repo_path, &init_options),
		"initialize temporary repository");
	join_path(worktree_file, sizeof(worktree_file), repo_path, "README.txt");
	require_git(git_repository_index(&index, repo), "open repository index");
	require_git(git_signature_new(&signature, "Wasm Runtime", "runtime@example.invalid",
		1735689600, 0), "create commit signature");

	git_oid first_blob_oid;
	make_commit(repo, index, signature, worktree_file, first_contents,
		"first runtime commit", NULL, &first_commit_oid, &first_blob_oid);
	require_git(git_commit_lookup(&first_commit, repo, &first_commit_oid),
		"lookup first commit");
	require_git(git_commit_tree(&first_tree, first_commit), "read first commit tree");

	const git_commit *parents[] = { first_commit };
	git_oid second_tree_oid;
	write_file(worktree_file, second_contents);
	require_git(git_index_add_bypath(index, "README.txt"), "stage second worktree state");
	require_git(git_index_write(index), "write second index state");
	require_git(git_index_write_tree(&second_tree_oid, index), "write second index tree");
	require_git(git_tree_lookup(&second_tree, repo, &second_tree_oid), "read second tree");
	const git_tree_entry *second_entry = git_tree_entry_byname(second_tree, "README.txt");
	require(second_entry != NULL, "find second commit blob");
	git_oid_cpy(&second_blob_oid, git_tree_entry_id(second_entry));
	require_git(git_commit_create(&second_commit_oid, repo, "HEAD", signature, signature,
		"UTF-8", "second runtime commit", second_tree, 1, parents),
		"write second repository commit");

	require_git(git_repository_head(&head_ref, repo), "read current branch");
	const char *head_name = git_reference_name(head_ref);
	require(head_name != NULL && strlen(head_name) < sizeof(main_ref),
		"read initial branch name");
	strcpy(main_ref, head_name);
	require_git(git_branch_create(&topic_ref, repo, "topic", first_commit, 0),
		"create topic branch");
	topic_ref_name = git_reference_name(topic_ref);
	require(topic_ref_name != NULL, "read topic branch name");
	require_git(git_checkout_options_init(&checkout_options, GIT_CHECKOUT_OPTIONS_VERSION),
		"initialize safe checkout options");
	checkout_options.checkout_strategy = GIT_CHECKOUT_SAFE;
	/* Checkout the target tree before moving HEAD, as required by libgit2. */
	checkout_options.baseline = second_tree;
	require_git(git_checkout_tree(repo, (git_object *)first_tree, &checkout_options),
		"checkout topic branch tree");
	require_git(git_repository_set_head(repo, topic_ref_name),
		"select checked-out topic branch");
	require(file_equals(worktree_file, first_contents),
		"topic checkout restored first commit contents");

	write_file(worktree_file, dirty_contents);
	checkout_options.baseline = first_tree;
	conflict_status = git_checkout_tree(repo, (git_object *)second_tree,
		&checkout_options);
	require(conflict_status == GIT_ECONFLICT,
		"safe checkout explicitly refused dirty overwrite");
	require(file_equals(worktree_file, dirty_contents),
		"conflicted checkout preserved dirty worktree file");
	checkout_options.checkout_strategy = GIT_CHECKOUT_FORCE;
	require_git(git_checkout_tree(repo, (git_object *)second_tree, &checkout_options),
		"force checkout restored main branch tree");
	require_git(git_repository_set_head(repo, main_ref),
		"select checked-out main branch");
	require(file_equals(worktree_file, second_contents),
		"force checkout restored committed worktree contents");

	/* The isolated pack store is rooted beside the repository, not in its ODB. */
	strcpy(pack_root, temporary_dir);
	make_pack_only_objects(pack_root, &second_commit_oid, repo, &second_blob_oid,
		second_contents);

	git_tree_free(second_tree);
	git_tree_free(first_tree);
	git_reference_free(topic_ref);
	git_reference_free(head_ref);
	git_commit_free(first_commit);
	git_signature_free(signature);
	git_index_free(index);
	git_repository_free(repo);
	git_libgit2_shutdown();

	printf("libgit2-runtime: repository, checkout conflict, and pack/index read passed\n");
	printf("::vm-test::pass\n");
	return 0;
}
