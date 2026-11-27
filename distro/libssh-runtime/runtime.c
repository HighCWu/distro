/* SPDX-License-Identifier: MIT */

#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#endif
#ifndef WITH_SERVER
#define WITH_SERVER 1
#endif

#include <libssh/libssh.h>
#include <libssh/server.h>
#include <libssh/sftp.h>

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#define EXPECTED_USER "linux-wasm-test"
#define REJECTED_USER "unknown-user"
#define EXPECTED_COMMAND "libssh-runtime-self-check"
#define SFTP_MAX_READ_SIZE 4096

static const unsigned char expected_payload[] = {
  0x00, 0x53, 0x53, 0x48, 0xff, 0x80, 0x0a, 0x00, 0x7f,
};

struct server_state {
  pthread_mutex_t mutex;
  pthread_cond_t condition;
  unsigned int port;
  int ready;
  int sftp_complete;
  char sftp_root[96];
  char sftp_source_path[128];
  char sftp_renamed_path[128];
  char sftp_recovery_path[128];
  char error[256];
};

struct sftp_fixture_handle {
  int fd;
  char path[128];
};

struct sftp_fixture_progress {
  struct server_state *server;
  int source_written;
  int source_read;
  int source_closed;
  int source_statted;
  int renamed;
  int renamed_statted;
  int removed;
  int missing_statted;
  int recovery_written;
  int recovery_read;
  int recovery_closed;
};

static void
record_server_error(struct server_state *state, const char *message)
{
  pthread_mutex_lock(&state->mutex);
  if (state->error[0] == '\0')
    (void)snprintf(state->error, sizeof(state->error), "%s", message);
  pthread_cond_broadcast(&state->condition);
  pthread_mutex_unlock(&state->mutex);
}

static void
server_ready(struct server_state *state, unsigned int port)
{
  pthread_mutex_lock(&state->mutex);
  state->port = port;
  state->ready = 1;
  pthread_cond_broadcast(&state->condition);
  pthread_mutex_unlock(&state->mutex);
}

static int
accept_with_watchdog(ssh_bind server_bind)
{
  struct pollfd descriptor = {
    .fd = (int)ssh_bind_get_fd(server_bind),
    .events = POLLIN,
  };
  int rc;

  do {
    rc = poll(&descriptor, 1, 20000);
  } while (rc < 0 && errno == EINTR);
  if (rc <= 0 || (descriptor.revents & POLLIN) == 0)
    return SSH_ERROR;
  return SSH_OK;
}

static int
send_payload(ssh_channel channel)
{
  size_t offset = 0;

  while (offset < sizeof(expected_payload)) {
    int written = ssh_channel_write(channel, expected_payload + offset,
                                    (uint32_t)(sizeof(expected_payload) - offset));
    if (written <= 0)
      return SSH_ERROR;
    offset += (size_t)written;
  }

  if (ssh_channel_request_send_exit_status(channel, 7) != SSH_OK)
    return SSH_ERROR;
  if (ssh_channel_send_eof(channel) != SSH_OK)
    return SSH_ERROR;

  while (!ssh_channel_is_eof(channel)) {
    unsigned char unexpected_data;
    int count = ssh_channel_read(channel, &unexpected_data, 1, 0);

    if (count != 0)
      return SSH_ERROR;
  }
  return SSH_OK;
}

static int
generate_host_key(ssh_key *host_key)
{
#if LIBSSH_VERSION_INT >= SSH_VERSION_INT(0, 12, 0)
  return ssh_pki_generate_key(SSH_KEYTYPE_ECDSA_P256, NULL, host_key);
#else
  /* libssh 0.10.x lacks ssh_pki_generate_key(); 0 still selects the
   * algorithm's default parameters for the requested P-256 key type. */
  return ssh_pki_generate(SSH_KEYTYPE_ECDSA_P256, 0, host_key);
#endif
}

static int
check_exit_status(ssh_channel channel)
{
#if LIBSSH_VERSION_INT >= SSH_VERSION_INT(0, 12, 0)
  uint32_t exit_code = UINT32_MAX;

  return ssh_channel_get_exit_state(channel, &exit_code, NULL, NULL) == SSH_OK &&
                 exit_code == 7
             ? SSH_OK
             : SSH_ERROR;
#else
  return ssh_channel_get_exit_status(channel) == 7 ? SSH_OK : SSH_ERROR;
#endif
}

static bool
sftp_path_is_allowed(const struct server_state *server, const char *path)
{
  return path != NULL &&
         (strcmp(path, server->sftp_source_path) == 0 ||
          strcmp(path, server->sftp_renamed_path) == 0 ||
          strcmp(path, server->sftp_recovery_path) == 0);
}

static uint32_t
sftp_status_from_errno(int error_number)
{
  switch (error_number) {
  case ENOENT:
  case ENOTDIR:
    return SSH_FX_NO_SUCH_FILE;
  case EACCES:
  case EPERM:
    return SSH_FX_PERMISSION_DENIED;
  case EEXIST:
    return SSH_FX_FILE_ALREADY_EXISTS;
  default:
    return SSH_FX_FAILURE;
  }
}

static int
sftp_reply_file_attributes(sftp_client_message message, const struct stat *file_stat)
{
  struct sftp_attributes_struct attributes = { 0 };

  attributes.flags = SSH_FILEXFER_ATTR_SIZE | SSH_FILEXFER_ATTR_UIDGID |
                     SSH_FILEXFER_ATTR_PERMISSIONS | SSH_FILEXFER_ATTR_ACMODTIME;
  attributes.size = (uint64_t)file_stat->st_size;
  attributes.uid = (uint32_t)file_stat->st_uid;
  attributes.gid = (uint32_t)file_stat->st_gid;
  attributes.permissions = (uint32_t)file_stat->st_mode;
  attributes.atime = (uint32_t)file_stat->st_atime;
  attributes.mtime = (uint32_t)file_stat->st_mtime;
  return sftp_reply_attr(message, &attributes);
}

static int
sftp_open_file(sftp_session sftp, sftp_client_message message,
               const struct server_state *server,
               struct sftp_fixture_progress *progress,
               struct sftp_fixture_handle *handle)
{
  const char *path = sftp_client_message_get_filename(message);
  uint32_t flags = sftp_client_message_get_flags(message);
  uint32_t requested_mode = message->attr == NULL ? 0600 : message->attr->permissions;
  int open_flags;
  int fd;
  ssh_string wire_handle;

  if (!sftp_path_is_allowed(server, path) || handle->fd >= 0 ||
      (strcmp(path, server->sftp_source_path) != 0 && !progress->missing_statted)) {
    return sftp_reply_status(message, SSH_FX_PERMISSION_DENIED,
                             "SFTP test path or request order rejected");
  }
  if ((flags & SSH_FXF_WRITE) != 0) {
    open_flags = (flags & SSH_FXF_READ) != 0 ? O_RDWR : O_WRONLY;
  } else if ((flags & SSH_FXF_READ) != 0) {
    open_flags = O_RDONLY;
  } else {
    return sftp_reply_status(message, SSH_FX_FAILURE, "SFTP open mode missing");
  }
  if ((flags & SSH_FXF_CREAT) != 0)
    open_flags |= O_CREAT;
  if ((flags & SSH_FXF_TRUNC) != 0)
    open_flags |= O_TRUNC;
  if ((flags & SSH_FXF_EXCL) != 0)
    open_flags |= O_EXCL;

  fd = open(path, open_flags, (mode_t)(requested_mode == 0 ? 0600 : requested_mode));
  if (fd < 0)
    return sftp_reply_status(message, sftp_status_from_errno(errno), "SFTP open failed");

  handle->fd = fd;
  (void)snprintf(handle->path, sizeof(handle->path), "%s", path);
  wire_handle = sftp_handle_alloc(sftp, handle);
  if (wire_handle == NULL) {
    close(handle->fd);
    handle->fd = -1;
    handle->path[0] = '\0';
    return sftp_reply_status(message, SSH_FX_FAILURE, "SFTP handle allocation failed");
  }
  if (sftp_reply_handle(message, wire_handle) != SSH_OK) {
    sftp_handle_remove(sftp, handle);
    close(handle->fd);
    handle->fd = -1;
    handle->path[0] = '\0';
    ssh_string_free(wire_handle);
    return SSH_ERROR;
  }
  ssh_string_free(wire_handle);
  return SSH_OK;
}

static int
sftp_write_file(sftp_session sftp, sftp_client_message message,
                struct sftp_fixture_progress *progress)
{
  struct sftp_fixture_handle *handle = sftp_handle(sftp, message->handle);
  const char *data = message->data == NULL ? NULL : ssh_string_get_char(message->data);
  uint32_t data_length = message->data == NULL ? 0 : ssh_string_len(message->data);
  size_t written = 0;

  if (handle == NULL || handle->fd < 0 || data == NULL || message->offset != 0 ||
      data_length != sizeof(expected_payload) ||
      memcmp(data, expected_payload, sizeof(expected_payload)) != 0)
    return sftp_reply_status(message, SSH_FX_FAILURE, "SFTP binary write invalid");

  while (written < data_length) {
    ssize_t count = pwrite(handle->fd, data + written, data_length - written,
                           (off_t)(message->offset + written));
    if (count < 0 && errno == EINTR)
      continue;
    if (count <= 0)
      return sftp_reply_status(message, sftp_status_from_errno(errno),
                               "SFTP file write failed");
    written += (size_t)count;
  }

  if (strcmp(handle->path, progress->server->sftp_source_path) == 0)
    progress->source_written = 1;
  else if (strcmp(handle->path, progress->server->sftp_recovery_path) == 0)
    progress->recovery_written = 1;
  return sftp_reply_status(message, SSH_FX_OK, NULL);
}

static int
sftp_read_file(sftp_client_message message, struct sftp_fixture_progress *progress,
               sftp_session sftp)
{
  struct sftp_fixture_handle *handle = sftp_handle(sftp, message->handle);
  unsigned char data[SFTP_MAX_READ_SIZE];
  ssize_t count;

  if (handle == NULL || handle->fd < 0 || message->offset != 0 ||
      message->len > sizeof(data))
    return sftp_reply_status(message, SSH_FX_INVALID_HANDLE, "SFTP read invalid");

  count = pread(handle->fd, data, message->len, (off_t)message->offset);
  if (count < 0)
    return sftp_reply_status(message, sftp_status_from_errno(errno),
                             "SFTP file read failed");
  if (count == 0)
    return sftp_reply_status(message, SSH_FX_EOF, NULL);
  if (strcmp(handle->path, progress->server->sftp_source_path) == 0 &&
      (size_t)count == sizeof(expected_payload) &&
      memcmp(data, expected_payload, sizeof(expected_payload)) == 0)
    progress->source_read = 1;
  if (strcmp(handle->path, progress->server->sftp_recovery_path) == 0 &&
      (size_t)count == sizeof(expected_payload) &&
      memcmp(data, expected_payload, sizeof(expected_payload)) == 0)
    progress->recovery_read = 1;
  return sftp_reply_data(message, data, (int)count);
}

static int
sftp_close_file(sftp_session sftp, sftp_client_message message,
                struct sftp_fixture_progress *progress)
{
  struct sftp_fixture_handle *handle = sftp_handle(sftp, message->handle);
  int close_result;

  if (handle == NULL || handle->fd < 0)
    return sftp_reply_status(message, SSH_FX_INVALID_HANDLE, "SFTP close invalid");

  close_result = close(handle->fd);
  handle->fd = -1;
  if (close_result != 0) {
    sftp_handle_remove(sftp, handle);
    handle->path[0] = '\0';
    return sftp_reply_status(message, sftp_status_from_errno(errno),
                             "SFTP file close failed");
  }
  if (strcmp(handle->path, progress->server->sftp_source_path) == 0)
    progress->source_closed = 1;
  else if (strcmp(handle->path, progress->server->sftp_recovery_path) == 0)
    progress->recovery_closed = 1;
  sftp_handle_remove(sftp, handle);
  handle->path[0] = '\0';
  return sftp_reply_status(message, SSH_FX_OK, NULL);
}

static int
sftp_stat_file(sftp_client_message message, struct sftp_fixture_progress *progress)
{
  struct server_state *server = progress->server;
  const char *path = sftp_client_message_get_filename(message);
  struct stat file_stat;

  if (!sftp_path_is_allowed(server, path))
    return sftp_reply_status(message, SSH_FX_PERMISSION_DENIED,
                             "SFTP test path rejected");
  if (stat(path, &file_stat) != 0) {
    int saved_errno = errno;

    if (strcmp(path, server->sftp_renamed_path) == 0 && progress->removed &&
        saved_errno == ENOENT) {
      progress->missing_statted = 1;
      return sftp_reply_status(message, SSH_FX_NO_SUCH_FILE,
                               "renamed file was removed");
    }
    return sftp_reply_status(message, sftp_status_from_errno(saved_errno),
                             "SFTP stat failed");
  }

  if (sftp_reply_file_attributes(message, &file_stat) != SSH_OK)
    return SSH_ERROR;
  if (strcmp(path, server->sftp_source_path) == 0 && progress->source_closed &&
      progress->source_read)
    progress->source_statted = 1;
  else if (strcmp(path, server->sftp_renamed_path) == 0 && progress->renamed)
    progress->renamed_statted = 1;
  else if (strcmp(path, server->sftp_recovery_path) == 0 &&
           progress->recovery_written && progress->recovery_closed &&
           progress->recovery_read)
    server->sftp_complete = 1;
  return SSH_OK;
}

static int
sftp_rename_file(sftp_client_message message, struct sftp_fixture_progress *progress)
{
  struct server_state *server = progress->server;
  const char *source = sftp_client_message_get_filename(message);
  const char *destination = sftp_client_message_get_data(message);

  if (source == NULL || destination == NULL ||
      strcmp(source, server->sftp_source_path) != 0 ||
      strcmp(destination, server->sftp_renamed_path) != 0 ||
      !progress->source_statted || !progress->source_closed ||
      rename(source, destination) != 0)
    return sftp_reply_status(message, SSH_FX_FAILURE, "SFTP rename rejected");
  progress->renamed = 1;
  return sftp_reply_status(message, SSH_FX_OK, NULL);
}

static int
sftp_remove_file(sftp_client_message message, struct sftp_fixture_progress *progress)
{
  struct server_state *server = progress->server;
  const char *path = sftp_client_message_get_filename(message);

  if (path == NULL || strcmp(path, server->sftp_renamed_path) != 0 ||
      !progress->renamed_statted || unlink(path) != 0)
    return sftp_reply_status(message, SSH_FX_FAILURE, "SFTP unlink rejected");
  progress->removed = 1;
  return sftp_reply_status(message, SSH_FX_OK, NULL);
}

static int
process_sftp_request(sftp_session sftp, sftp_client_message message,
                     struct sftp_fixture_progress *progress,
                     struct sftp_fixture_handle *handle)
{
  uint8_t type = sftp_client_message_get_type(message);

  switch (type) {
  case SSH_FXP_OPEN:
    return sftp_open_file(sftp, message, progress->server, progress, handle);
  case SSH_FXP_WRITE:
    return sftp_write_file(sftp, message, progress);
  case SSH_FXP_READ:
    return sftp_read_file(message, progress, sftp);
  case SSH_FXP_CLOSE:
    return sftp_close_file(sftp, message, progress);
  case SSH_FXP_STAT:
    return sftp_stat_file(message, progress);
  case SSH_FXP_RENAME:
    return sftp_rename_file(message, progress);
  case SSH_FXP_EXTENDED:
    if (sftp_client_message_get_submessage(message) != NULL &&
        strcmp(sftp_client_message_get_submessage(message),
               "posix-rename@openssh.com") == 0)
      return sftp_rename_file(message, progress);
    return sftp_reply_status(message, SSH_FX_OP_UNSUPPORTED,
                             "SFTP extension is not supported");
  case SSH_FXP_REMOVE:
    return sftp_remove_file(message, progress);
  default:
    return sftp_reply_status(message, SSH_FX_OP_UNSUPPORTED,
                             "SFTP operation is not supported");
  }
}

static int
wait_for_channel_eof(ssh_channel channel)
{
  while (!ssh_channel_is_eof(channel)) {
    unsigned char unexpected_data;
    int count = ssh_channel_read(channel, &unexpected_data, 1, 0);

    if (count != 0)
      return SSH_ERROR;
  }
  return SSH_OK;
}

static int
serve_sftp(ssh_session session, ssh_channel channel, struct server_state *server)
{
  struct sftp_fixture_progress progress = { .server = server };
  struct sftp_fixture_handle handle = { .fd = -1 };
  sftp_session sftp = NULL;
  sftp_client_message message = NULL;
  int requests = 0;
  int result = SSH_ERROR;

  sftp = sftp_server_new(session, channel);
  if (sftp == NULL)
    goto cleanup;

#if defined(__GNUC__) || defined(__clang__)
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wdeprecated-declarations"
#endif
  if (sftp_server_init(sftp) != SSH_OK)
    goto cleanup;
#if defined(__GNUC__) || defined(__clang__)
#pragma GCC diagnostic pop
#endif

  while (!server->sftp_complete && requests < 32) {
    message = sftp_get_client_message(sftp);
    if (message == NULL || process_sftp_request(sftp, message, &progress, &handle) != SSH_OK)
      goto cleanup;
    sftp_client_message_free(message);
    message = NULL;
    requests++;
  }
  if (!server->sftp_complete || wait_for_channel_eof(channel) != SSH_OK)
    goto cleanup;
  result = SSH_OK;

cleanup:
  if (message != NULL)
    sftp_client_message_free(message);
  if (handle.fd >= 0) {
    close(handle.fd);
    handle.fd = -1;
    if (sftp != NULL)
      sftp_handle_remove(sftp, &handle);
  }
  if (sftp != NULL)
    sftp_server_free(sftp);
  return result;
}

static int
serve_session(ssh_bind server_bind, int connection_index,
              struct server_state *server, const char **failed_stage,
              char *session_err, size_t session_err_size)
{
  ssh_session session = NULL;
  ssh_message message = NULL;
  ssh_channel channel = NULL;
  int authenticated = 0;
  int rejected = 0;
  int result = SSH_ERROR;
  const char *stage = "accept_watchdog";

  if (accept_with_watchdog(server_bind) != SSH_OK)
    goto cleanup;

  stage = "bind_accept";
  session = ssh_new();
  if (session == NULL || ssh_bind_accept(server_bind, session) != SSH_OK)
    goto cleanup;

  stage = "key_exchange";
  if (ssh_handle_key_exchange(session) != SSH_OK)
    goto cleanup;

  stage = "auth";

  while (!authenticated && !rejected) {
    const char *username;
    int type;

    message = ssh_message_get(session);
    if (message == NULL)
      goto cleanup;

    type = ssh_message_type(message);
    if (type == SSH_REQUEST_SERVICE) {
      if (ssh_message_service_reply_success(message) != SSH_OK)
        goto cleanup;
    } else if (type == SSH_REQUEST_AUTH &&
               ssh_message_subtype(message) == SSH_AUTH_METHOD_NONE) {
      username = ssh_message_auth_user(message);
      if (connection_index == 0 && username != NULL &&
          strcmp(username, REJECTED_USER) == 0) {
        if (ssh_message_auth_set_methods(message, SSH_AUTH_METHOD_PASSWORD) != SSH_OK ||
            ssh_message_reply_default(message) != SSH_OK)
          goto cleanup;
        rejected = 1;
      } else if (connection_index > 0 && username != NULL &&
                 strcmp(username, EXPECTED_USER) == 0) {
        if (ssh_message_auth_reply_success(message, 0) != SSH_OK)
          goto cleanup;
        authenticated = 1;
      } else {
        goto cleanup;
      }
    } else {
      if (ssh_message_reply_default(message) != SSH_OK)
        goto cleanup;
    }

    ssh_message_free(message);
    message = NULL;
  }

  if (rejected) {
    result = SSH_OK;
    goto cleanup;
  }
  if (!authenticated)
    goto cleanup;

  stage = "channel_open";
  for (;;) {
    message = ssh_message_get(session);
    if (message == NULL)
      goto cleanup;

    if (ssh_message_type(message) == SSH_REQUEST_CHANNEL_OPEN &&
        ssh_message_subtype(message) == SSH_CHANNEL_SESSION) {
      channel = ssh_message_channel_request_open_reply_accept(message);
      ssh_message_free(message);
      message = NULL;
      if (channel == NULL)
        goto cleanup;
      break;
    }

    if (ssh_message_reply_default(message) != SSH_OK)
      goto cleanup;
    ssh_message_free(message);
    message = NULL;
  }

  stage = "channel_request";
  for (;;) {
    message = ssh_message_get(session);
    if (message == NULL)
      goto cleanup;

    if (ssh_message_type(message) == SSH_REQUEST_CHANNEL &&
        connection_index == 1 &&
        ssh_message_subtype(message) == SSH_CHANNEL_REQUEST_EXEC) {
      const char *command = ssh_message_channel_request_command(message);

      if (command == NULL || strcmp(command, EXPECTED_COMMAND) != 0 ||
          ssh_message_channel_request_reply_success(message) != SSH_OK)
        goto cleanup;
      ssh_message_free(message);
      message = NULL;
      if (send_payload(channel) != SSH_OK)
        goto cleanup;
      result = SSH_OK;
      goto cleanup;
    }

    if (ssh_message_type(message) == SSH_REQUEST_CHANNEL &&
        connection_index == 2 &&
        ssh_message_subtype(message) == SSH_CHANNEL_REQUEST_SUBSYSTEM) {
      const char *subsystem = ssh_message_channel_request_subsystem(message);

      if (subsystem == NULL || strcmp(subsystem, "sftp") != 0 ||
          ssh_message_channel_request_reply_success(message) != SSH_OK)
        goto cleanup;
      ssh_message_free(message);
      message = NULL;
      result = serve_sftp(session, channel, server);
      goto cleanup;
    }

    if (ssh_message_reply_default(message) != SSH_OK)
      goto cleanup;
    ssh_message_free(message);
    message = NULL;
  }

cleanup:
  if (result != SSH_OK) {
    if (failed_stage != NULL)
      *failed_stage = stage;
    if (session_err != NULL && session_err_size > 0) {
      const char *err = session != NULL ? ssh_get_error(session) : "ssh_new failed";
      (void)snprintf(session_err, session_err_size, "%s", err != NULL ? err : "");
    }
  }
  if (message != NULL)
    ssh_message_free(message);
  if (channel != NULL) {
    (void)ssh_channel_close(channel);
    ssh_channel_free(channel);
  }
  if (session != NULL) {
    ssh_disconnect(session);
    ssh_free(session);
  }
  return result;
}

static void *
server_thread(void *opaque)
{
  struct server_state *state = opaque;
  struct sockaddr_in address = { 0 };
  socklen_t address_length = (socklen_t)sizeof(address);
  ssh_bind server_bind = NULL;
  ssh_key host_key = NULL;
  int listener = -1;
  int reuse = 1;
  bool config_enabled = false;
  unsigned int port;

  listener = socket(AF_INET, SOCK_STREAM, 0);
  if (listener < 0 ||
      setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse)) != 0) {
    record_server_error(state, "creating the loopback listener");
    goto cleanup;
  }

  address.sin_family = AF_INET;
  address.sin_port = htons(0);
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (bind(listener, (struct sockaddr *)&address, sizeof(address)) != 0 ||
      listen(listener, 3) != 0 ||
      getsockname(listener, (struct sockaddr *)&address, &address_length) != 0) {
    record_server_error(state, "binding the loopback listener");
    goto cleanup;
  }
  port = (unsigned int)ntohs(address.sin_port);

  if (generate_host_key(&host_key) != SSH_OK) {
    record_server_error(state, "generating the ECDSA P-256 host key");
    goto cleanup;
  }
  if (ssh_key_type(host_key) != SSH_KEYTYPE_ECDSA_P256) {
    record_server_error(state, "libssh generated an unexpected host-key type");
    goto cleanup;
  }
  server_bind = ssh_bind_new();
  if (server_bind == NULL ||
      ssh_bind_options_set(server_bind, SSH_BIND_OPTIONS_PROCESS_CONFIG, &config_enabled) != SSH_OK ||
      ssh_bind_options_set(server_bind, SSH_BIND_OPTIONS_IMPORT_KEY, host_key) != SSH_OK) {
    record_server_error(state, "configuring the libssh server");
    goto cleanup;
  }
  host_key = NULL; /* ssh_bind owns an imported key. */
  ssh_bind_set_fd(server_bind, (socket_t)listener);
  listener = -1; /* ssh_bind_free closes the adopted socket. */

  const char *failed_stage = NULL;
  char session_err[128] = "";
  char detail[256];

  server_ready(state, port);
  if (serve_session(server_bind, 0, state, &failed_stage, session_err,
                    sizeof(session_err)) != SSH_OK) {
    (void)snprintf(detail, sizeof(detail),
                   "rejecting the unknown-user SSH session (stage=%s: %s)",
                   failed_stage ? failed_stage : "?", session_err);
    record_server_error(state, detail);
    goto cleanup;
  }
  if (serve_session(server_bind, 1, state, &failed_stage, session_err,
                    sizeof(session_err)) != SSH_OK) {
    (void)snprintf(detail, sizeof(detail),
                   "serving the authenticated SSH exec request (stage=%s: %s)",
                   failed_stage ? failed_stage : "?", session_err);
    record_server_error(state, detail);
    goto cleanup;
  }
  if (serve_session(server_bind, 2, state, &failed_stage, session_err,
                    sizeof(session_err)) != SSH_OK) {
    (void)snprintf(detail, sizeof(detail),
                   "serving the authenticated SFTP subsystem (stage=%s: %s)",
                   failed_stage ? failed_stage : "?", session_err);
    record_server_error(state, detail);
    goto cleanup;
  }

cleanup:
  if (listener >= 0)
    close(listener);
  if (host_key != NULL)
    ssh_key_free(host_key);
  if (server_bind != NULL)
    ssh_bind_free(server_bind);
  return NULL;
}

static int
wait_for_server(struct server_state *state, unsigned int *port, char *error,
                size_t error_size)
{
  struct timespec deadline;
  int ready;
  int rc = 0;

  if (clock_gettime(CLOCK_REALTIME, &deadline) != 0)
    return -1;
  deadline.tv_sec += 20;

  pthread_mutex_lock(&state->mutex);
  while (!state->ready && state->error[0] == '\0' && rc != ETIMEDOUT)
    rc = pthread_cond_timedwait(&state->condition, &state->mutex, &deadline);
  ready = state->ready;
  if (ready)
    *port = state->port;
  else if (error_size > 0)
    (void)snprintf(error, error_size, "%s",
                   state->error[0] == '\0' ? "readiness watchdog expired" : state->error);
  pthread_mutex_unlock(&state->mutex);
  return ready ? 0 : -1;
}

static ssh_session
connect_client(unsigned int port, const char *username)
{
  ssh_session session = ssh_new();
  bool process_config = false;
  int strict_host_key_check = 0;
  long timeout_seconds = 15;

  if (session == NULL)
    return NULL;
  if (ssh_options_set(session, SSH_OPTIONS_HOST, "127.0.0.1") != SSH_OK ||
      ssh_options_set(session, SSH_OPTIONS_PORT, &port) != SSH_OK ||
      ssh_options_set(session, SSH_OPTIONS_USER, username) != SSH_OK ||
      ssh_options_set(session, SSH_OPTIONS_PROCESS_CONFIG, &process_config) != SSH_OK ||
      ssh_options_set(session, SSH_OPTIONS_STRICTHOSTKEYCHECK,
                      &strict_host_key_check) != SSH_OK ||
      ssh_options_set(session, SSH_OPTIONS_TIMEOUT, &timeout_seconds) != SSH_OK ||
      ssh_connect(session) != SSH_OK) {
    fprintf(stderr, "libssh runtime: connect_client(%s) failed: %s\n",
            username, ssh_get_error(session));
    ssh_disconnect(session);
    ssh_free(session);
    return NULL;
  }
  return session;
}

static int
check_payload(ssh_channel channel)
{
  unsigned char received[sizeof(expected_payload)];
  size_t received_length = 0;
  unsigned char extra_byte;
  int eof = 0;

  while (!eof) {
    void *destination;
    uint32_t capacity;
    int count;

    if (received_length < sizeof(received)) {
      destination = received + received_length;
      capacity = (uint32_t)(sizeof(received) - received_length);
    } else {
      destination = &extra_byte;
      capacity = 1;
    }

    count = ssh_channel_read(channel, destination, capacity, 0);
    if (count < 0)
      return -1;
    if (count == 0) {
      eof = 1;
      continue;
    }
    if (received_length == sizeof(received) ||
        (size_t)count > sizeof(received) - received_length)
      return -1;
    received_length += (size_t)count;
  }

  if (!ssh_channel_is_eof(channel) || received_length != sizeof(expected_payload) ||
      memcmp(received, expected_payload, sizeof(expected_payload)) != 0 ||
      check_exit_status(channel) != SSH_OK)
    return -1;
  return SSH_OK;
}

static int
sftp_write_payload(sftp_file file)
{
  size_t offset = 0;

  while (offset < sizeof(expected_payload)) {
    ssize_t written = sftp_write(file, expected_payload + offset,
                                 sizeof(expected_payload) - offset);

    if (written <= 0)
      return SSH_ERROR;
    offset += (size_t)written;
  }
  return SSH_OK;
}

static int
sftp_read_payload(sftp_file file)
{
  unsigned char received[sizeof(expected_payload)];
  size_t offset = 0;

  if (sftp_seek64(file, 0) != SSH_OK)
    return SSH_ERROR;
  while (offset < sizeof(received)) {
    ssize_t count = sftp_read(file, received + offset, sizeof(received) - offset);

    if (count <= 0)
      return SSH_ERROR;
    offset += (size_t)count;
  }
  return memcmp(received, expected_payload, sizeof(received)) == 0 ? SSH_OK
                                                                  : SSH_ERROR;
}

static int
check_sftp_file_size(sftp_session sftp, const char *path)
{
  sftp_attributes attributes = sftp_stat(sftp, path);
  int valid = attributes != NULL &&
              (attributes->flags & SSH_FILEXFER_ATTR_SIZE) != 0 &&
              attributes->size == sizeof(expected_payload);

  if (attributes != NULL)
    sftp_attributes_free(attributes);
  return valid ? SSH_OK : SSH_ERROR;
}

static int
run_sftp_client(ssh_session client, const struct server_state *server)
{
  sftp_session sftp = NULL;
  sftp_file file = NULL;
  int result = SSH_ERROR;

  sftp = sftp_new(client);
  if (sftp == NULL || sftp_init(sftp) != SSH_OK)
    goto cleanup;

  file = sftp_open(sftp, server->sftp_source_path,
                   O_RDWR | O_CREAT | O_TRUNC, 0600);
  if (file == NULL || sftp_write_payload(file) != SSH_OK ||
      sftp_read_payload(file) != SSH_OK || sftp_close(file) != SSH_OK)
    goto cleanup;
  file = NULL;
  if (check_sftp_file_size(sftp, server->sftp_source_path) != SSH_OK ||
      sftp_rename(sftp, server->sftp_source_path,
                  server->sftp_renamed_path) != SSH_OK ||
      check_sftp_file_size(sftp, server->sftp_renamed_path) != SSH_OK ||
      sftp_unlink(sftp, server->sftp_renamed_path) != SSH_OK)
    goto cleanup;
  if (sftp_stat(sftp, server->sftp_renamed_path) != NULL ||
      sftp_get_error(sftp) != SSH_FX_NO_SUCH_FILE)
    goto cleanup;

  file = sftp_open(sftp, server->sftp_recovery_path,
                   O_RDWR | O_CREAT | O_TRUNC, 0600);
  if (file == NULL || sftp_write_payload(file) != SSH_OK ||
      sftp_read_payload(file) != SSH_OK || sftp_close(file) != SSH_OK)
    goto cleanup;
  file = NULL;
  if (check_sftp_file_size(sftp, server->sftp_recovery_path) != SSH_OK)
    goto cleanup;
  result = SSH_OK;

cleanup:
  if (file != NULL)
    (void)sftp_close(file);
  if (sftp != NULL)
    sftp_free(sftp);
  return result;
}

int
main(void)
{
  struct server_state server = {
    .mutex = PTHREAD_MUTEX_INITIALIZER,
    .condition = PTHREAD_COND_INITIALIZER,
  };
  pthread_t server_id;
  ssh_session rejected_client = NULL;
  ssh_session client = NULL;
  ssh_session sftp_client = NULL;
  ssh_channel channel = NULL;
  unsigned int port = 0;
  char readiness_error[256] = { 0 };
  int server_started = 0;
  int ssh_initialized = 0;
  int sftp_root_created = 0;
  int result = 1;
  int path_length;

  if (ssh_init() != SSH_OK) {
    fprintf(stderr, "libssh runtime: initializing libssh failed\n");
    goto cleanup;
  }
  ssh_initialized = 1;
  path_length = snprintf(server.sftp_root, sizeof(server.sftp_root),
                         "/tmp/libssh-sftp-runtime-%ld", (long)getpid());
  if (path_length < 0 || (size_t)path_length >= sizeof(server.sftp_root)) {
    fprintf(stderr, "libssh runtime: SFTP fixture path is too long\n");
    goto cleanup;
  }
  if (mkdir(server.sftp_root, 0700) != 0) {
    fprintf(stderr, "libssh runtime: creating SFTP fixture directory failed: %s\n",
            strerror(errno));
    goto cleanup;
  }
  sftp_root_created = 1;
  path_length = snprintf(server.sftp_source_path, sizeof(server.sftp_source_path),
                         "%s/source.bin", server.sftp_root);
  if (path_length < 0 || (size_t)path_length >= sizeof(server.sftp_source_path))
    goto cleanup;
  path_length = snprintf(server.sftp_renamed_path,
                         sizeof(server.sftp_renamed_path), "%s/renamed.bin",
                         server.sftp_root);
  if (path_length < 0 || (size_t)path_length >= sizeof(server.sftp_renamed_path))
    goto cleanup;
  path_length = snprintf(server.sftp_recovery_path,
                         sizeof(server.sftp_recovery_path), "%s/recovery.bin",
                         server.sftp_root);
  if (path_length < 0 || (size_t)path_length >= sizeof(server.sftp_recovery_path))
    goto cleanup;

  if (pthread_create(&server_id, NULL, server_thread, &server) != 0) {
    fprintf(stderr, "libssh runtime: starting the server thread failed\n");
    goto cleanup;
  }
  server_started = 1;
  if (wait_for_server(&server, &port, readiness_error, sizeof(readiness_error)) != 0) {
    fprintf(stderr, "libssh runtime: server did not become ready: %s\n", readiness_error);
    goto cleanup;
  }
  puts("libssh: ECDSA P-256 host key generated and loopback listener ready");

  rejected_client = connect_client(port, REJECTED_USER);
  if (rejected_client == NULL ||
      ssh_userauth_none(rejected_client, NULL) != SSH_AUTH_DENIED) {
    fprintf(stderr, "libssh runtime: unknown user was not rejected\n");
    goto cleanup;
  }
  ssh_disconnect(rejected_client);
  ssh_free(rejected_client);
  rejected_client = NULL;
  puts("libssh: unknown username rejected");

  client = connect_client(port, EXPECTED_USER);
  if (client == NULL || ssh_userauth_none(client, NULL) != SSH_AUTH_SUCCESS) {
    fprintf(stderr, "libssh runtime: valid user authentication failed%s%s\n",
            client ? ": " : "", client ? ssh_get_error(client) : "");
    goto cleanup;
  }
  puts("libssh: valid username authenticated after rejection");

  channel = ssh_channel_new(client);
  if (channel == NULL || ssh_channel_open_session(channel) != SSH_OK ||
      ssh_channel_request_exec(channel, EXPECTED_COMMAND) != SSH_OK) {
    fprintf(stderr, "libssh runtime: opening the SSH exec channel failed\n");
    goto cleanup;
  }
  if (check_payload(channel) != SSH_OK) {
    fprintf(stderr, "libssh runtime: payload, EOF, or remote exit status mismatch\n");
    goto cleanup;
  }
  puts("libssh: session exec returned exact binary payload, EOF, and exit status 7");

  if (ssh_channel_close(channel) != SSH_OK) {
    fprintf(stderr, "libssh runtime: closing the SSH channel failed\n");
    goto cleanup;
  }
  ssh_channel_free(channel);
  channel = NULL;
  ssh_disconnect(client);
  ssh_free(client);
  client = NULL;

  sftp_client = connect_client(port, EXPECTED_USER);
  if (sftp_client == NULL ||
      ssh_userauth_none(sftp_client, NULL) != SSH_AUTH_SUCCESS) {
    fprintf(stderr, "libssh runtime: SFTP user authentication failed\n");
    goto cleanup;
  }
  if (run_sftp_client(sftp_client, &server) != SSH_OK) {
    fprintf(stderr, "libssh runtime: SFTP file operations or recovery failed\n");
    goto cleanup;
  }
  puts("libssh: SFTP create/write/seek/read/stat/rename/unlink verified");
  puts("libssh: SFTP ENOENT reported and recovery succeeded");
  ssh_disconnect(sftp_client);
  ssh_free(sftp_client);
  sftp_client = NULL;

  if (pthread_join(server_id, NULL) != 0) {
    server_started = 0;
    fprintf(stderr, "libssh runtime: joining the server thread failed\n");
    goto cleanup;
  }
  server_started = 0;
  if (server.error[0] != '\0') {
    fprintf(stderr, "libssh runtime: server failed: %s\n", server.error);
    goto cleanup;
  }
  if (!server.sftp_complete) {
    fprintf(stderr, "libssh runtime: SFTP server did not complete the recovery sequence\n");
    goto cleanup;
  }
  result = 0;

cleanup:
  if (channel != NULL) {
    (void)ssh_channel_close(channel);
    ssh_channel_free(channel);
  }
  if (rejected_client != NULL) {
    ssh_disconnect(rejected_client);
    ssh_free(rejected_client);
  }
  if (client != NULL) {
    ssh_disconnect(client);
    ssh_free(client);
  }
  if (sftp_client != NULL) {
    ssh_disconnect(sftp_client);
    ssh_free(sftp_client);
  }
  if (server_started) {
    (void)pthread_join(server_id, NULL);
    if (server.error[0] != '\0')
      fprintf(stderr, "libssh runtime: server failed: %s\n", server.error);
  }
  if (ssh_initialized && ssh_finalize() != SSH_OK) {
    fprintf(stderr, "libssh runtime: finalizing libssh failed\n");
    result = 1;
  }
  (void)pthread_cond_destroy(&server.condition);
  (void)pthread_mutex_destroy(&server.mutex);

  if (sftp_root_created) {
    int cleanup_failed = 0;

    if (unlink(server.sftp_source_path) != 0 && errno != ENOENT)
      cleanup_failed = 1;
    if (unlink(server.sftp_renamed_path) != 0 && errno != ENOENT)
      cleanup_failed = 1;
    if (unlink(server.sftp_recovery_path) != 0 && errno != ENOENT)
      cleanup_failed = 1;
    if (rmdir(server.sftp_root) != 0 && errno != ENOENT)
      cleanup_failed = 1;
    if (cleanup_failed) {
      fprintf(stderr, "libssh runtime: cleaning the SFTP fixture failed\n");
      result = 1;
    }
  }

  if (result == 0)
    puts("libssh: client and server sessions, keys, sockets, and thread cleaned up");
  return result;
}
