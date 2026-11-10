// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include <uv.h>

#define WATCHDOG_MS 45000
#define SPAWN_OUTPUT "libuv-helper: argv verified\n"
#define SPAWN_OUTPUT_SIZE (sizeof(SPAWN_OUTPUT) - 1)
#define PAYLOAD_SIZE 7

typedef struct runtime_state runtime_state;

struct runtime_state {
  uv_loop_t loop;
  uv_timer_t watchdog;

  uv_pipe_t child_stdout;
  uv_process_t child;
  bool child_stdout_eof;
  bool child_stdout_closed;
  bool child_closed;
  int64_t child_exit_status;
  int child_term_signal;
  char child_output[128];
  size_t child_output_size;

  uv_fs_t fs_request;
  int fs_step;
  uv_file data_fd;
  char data_path[96];
  unsigned char readback[PAYLOAD_SIZE];

  uv_pipe_t server;
  uv_pipe_t client;
  uv_pipe_t peer;
  uv_connect_t connect_request;
  uv_timer_t phase_timer;
  bool client_connected;
  bool client_write_done;
  bool server_write_done;
  bool timer_fired;
  bool phase3_closed;
  bool have_server_payload;
  bool have_client_payload;
  size_t server_payload_size;
  size_t client_payload_size;
  unsigned char server_payload[PAYLOAD_SIZE];
  unsigned char client_payload[PAYLOAD_SIZE];
  char socket_path[96];
  int stage;
};

static runtime_state state;
static const unsigned char payload[PAYLOAD_SIZE] = {
    0x00, 0x7f, 0x80, 0x41, 0x00, 0xff, 0x5a,
};

static void fail(const char *where, int error) {
  if (error < 0)
    fprintf(stderr, "libuv-runtime: %s: %s (%d)\n", where,
            uv_strerror(error), error);
  else
    fprintf(stderr, "libuv-runtime: %s\n", where);
  fflush(stderr);
  _Exit(EXIT_FAILURE);
}

static void on_watchdog(uv_timer_t *timer) {
  (void)timer;
  fail("45-second runtime watchdog expired", 0);
}

static void start_filesystem_stage(void);
static void start_pipe_stage(void);

static void print_stage(const char *message) {
  if (printf("%s\n", message) < 0 || fflush(stdout) != 0)
    fail("writing phase marker", 0);
}

static void maybe_finish_spawn(void) {
  if (!state.child_stdout_eof || !state.child_stdout_closed ||
      !state.child_closed)
    return;

  if (state.child_exit_status != 7 || state.child_term_signal != 0)
    fail("spawned helper had the wrong exit status or signal", 0);
  if (state.child_output_size != SPAWN_OUTPUT_SIZE ||
      memcmp(state.child_output, SPAWN_OUTPUT, SPAWN_OUTPUT_SIZE) != 0)
    fail("spawned helper stdout did not match", 0);

  print_stage("libuv: spawn argv/stdout/exit/reap ok");
  state.stage = 2;
  start_filesystem_stage();
}

static void on_child_stdout_closed(uv_handle_t *handle) {
  (void)handle;
  state.child_stdout_closed = true;
  maybe_finish_spawn();
}

static void on_child_closed(uv_handle_t *handle) {
  (void)handle;
  state.child_closed = true;
  maybe_finish_spawn();
}

static void on_child_read(uv_stream_t *stream, ssize_t nread,
                          const uv_buf_t *buffer) {
  (void)stream;
  if (nread > 0) {
    size_t amount = (size_t)nread;
    if (amount > sizeof(state.child_output) - state.child_output_size) {
      free(buffer->base);
      fail("spawned helper wrote too much stdout", 0);
    }
    memcpy(state.child_output + state.child_output_size, buffer->base, amount);
    state.child_output_size += amount;
  } else if (nread < 0) {
    if (nread != UV_EOF) {
      free(buffer->base);
      fail("reading spawned helper stdout", (int)nread);
    }
    state.child_stdout_eof = true;
    uv_read_stop(stream);
    if (!uv_is_closing((uv_handle_t *)&state.child_stdout))
      uv_close((uv_handle_t *)&state.child_stdout, on_child_stdout_closed);
    free(buffer->base);
    maybe_finish_spawn();
    return;
  }
  free(buffer->base);
}

static void on_child_alloc(uv_handle_t *handle, size_t suggested_size,
                           uv_buf_t *buffer) {
  (void)handle;
  size_t size = suggested_size;
  if (size < 64)
    size = 64;
  buffer->base = malloc(size);
  buffer->len = buffer->base == NULL ? 0 : size;
  if (buffer->base == NULL)
    fail("allocating child stdout buffer", 0);
}

static void on_child_exit(uv_process_t *process, int64_t exit_status,
                          int term_signal) {
  state.child_exit_status = exit_status;
  state.child_term_signal = term_signal;
  uv_close((uv_handle_t *)process, on_child_closed);
  maybe_finish_spawn();
}

static void start_spawn_stage(void) {
  int rc = uv_pipe_init(&state.loop, &state.child_stdout, 0);
  if (rc < 0)
    fail("uv_pipe_init for child stdout", rc);

  const char *helper_path = getenv("LIBUV_HELPER_PATH");
  if (helper_path == NULL || helper_path[0] == '\0')
    helper_path = "/bin/libuv-helper";
  char *arguments[] = {
      (char *)helper_path, "spawn-check", "argv-ok", NULL,
  };
  uv_stdio_container_t stdio[3];
  memset(stdio, 0, sizeof(stdio));
  stdio[0].flags = UV_IGNORE;
  stdio[1].flags = (uv_stdio_flags)(UV_CREATE_PIPE | UV_WRITABLE_PIPE);
  stdio[1].data.stream = (uv_stream_t *)&state.child_stdout;
  stdio[2].flags = UV_IGNORE;

  uv_process_options_t options;
  memset(&options, 0, sizeof(options));
  options.exit_cb = on_child_exit;
  options.file = helper_path;
  options.args = arguments;
  options.stdio_count = 3;
  options.stdio = stdio;

  state.child.data = &state;
  rc = uv_spawn(&state.loop, &state.child, &options);
  if (rc < 0) {
    uv_close((uv_handle_t *)&state.child_stdout, NULL);
    fail("uv_spawn helper", rc);
  }
  rc = uv_read_start((uv_stream_t *)&state.child_stdout, on_child_alloc,
                     on_child_read);
  if (rc < 0)
    fail("starting helper stdout read", rc);
}

enum {
  FS_OPEN = 1,
  FS_WRITE,
  FS_FSYNC,
  FS_READ,
  FS_STAT,
  FS_CLOSE,
  FS_UNLINK,
};

static void fs_callback(uv_fs_t *request);

static void queue_fs(int rc, const char *operation) {
  if (rc < 0)
    fail(operation, rc);
}

static void queue_fs_open(void) {
  state.fs_step = FS_OPEN;
  state.fs_request.data = &state;
  queue_fs(uv_fs_open(&state.loop, &state.fs_request, state.data_path,
                      O_CREAT | O_TRUNC | O_RDWR, 0600, fs_callback),
           "queueing uv_fs_open");
}

static void queue_fs_write(void) {
  uv_buf_t buffer = uv_buf_init((char *)payload, PAYLOAD_SIZE);
  state.fs_step = FS_WRITE;
  state.fs_request.data = &state;
  queue_fs(uv_fs_write(&state.loop, &state.fs_request, state.data_fd, &buffer,
                       1, 0, fs_callback),
           "queueing uv_fs_write");
}

static void queue_fs_fsync(void) {
  state.fs_step = FS_FSYNC;
  state.fs_request.data = &state;
  queue_fs(uv_fs_fsync(&state.loop, &state.fs_request, state.data_fd,
                       fs_callback),
           "queueing uv_fs_fsync");
}

static void queue_fs_read(void) {
  uv_buf_t buffer = uv_buf_init((char *)state.readback, PAYLOAD_SIZE);
  state.fs_step = FS_READ;
  state.fs_request.data = &state;
  queue_fs(uv_fs_read(&state.loop, &state.fs_request, state.data_fd, &buffer, 1,
                      0, fs_callback),
           "queueing uv_fs_read");
}

static void queue_fs_stat(void) {
  state.fs_step = FS_STAT;
  state.fs_request.data = &state;
  queue_fs(uv_fs_stat(&state.loop, &state.fs_request, state.data_path,
                      fs_callback),
           "queueing uv_fs_stat");
}

static void queue_fs_close(void) {
  state.fs_step = FS_CLOSE;
  state.fs_request.data = &state;
  queue_fs(uv_fs_close(&state.loop, &state.fs_request, state.data_fd,
                       fs_callback),
           "queueing uv_fs_close");
}

static void queue_fs_unlink(void) {
  state.fs_step = FS_UNLINK;
  state.fs_request.data = &state;
  queue_fs(uv_fs_unlink(&state.loop, &state.fs_request, state.data_path,
                        fs_callback),
           "queueing uv_fs_unlink");
}

static void fs_callback(uv_fs_t *request) {
  ssize_t result = request->result;
  int step = state.fs_step;
  if (result < 0) {
    uv_fs_req_cleanup(request);
    fail("asynchronous filesystem operation", (int)result);
  }

  if (step == FS_OPEN) {
    state.data_fd = (uv_file)result;
  } else if (step == FS_WRITE) {
    if (result != PAYLOAD_SIZE) {
      uv_fs_req_cleanup(request);
      fail("uv_fs_write returned a short write", 0);
    }
  } else if (step == FS_FSYNC) {
    if (result != 0) {
      uv_fs_req_cleanup(request);
      fail("uv_fs_fsync returned an unexpected result", 0);
    }
  } else if (step == FS_READ) {
    if (result != PAYLOAD_SIZE ||
        memcmp(state.readback, payload, PAYLOAD_SIZE) != 0) {
      uv_fs_req_cleanup(request);
      fail("uv_fs_read did not return the written bytes", 0);
    }
  } else if (step == FS_STAT) {
    if (request->statbuf.st_size != PAYLOAD_SIZE) {
      uv_fs_req_cleanup(request);
      fail("uv_fs_stat returned the wrong file size", 0);
    }
  } else if (step == FS_CLOSE || step == FS_UNLINK) {
    if (result != 0) {
      uv_fs_req_cleanup(request);
      fail(step == FS_CLOSE ? "uv_fs_close returned an unexpected result"
                            : "uv_fs_unlink returned an unexpected result",
           0);
    }
  } else {
    uv_fs_req_cleanup(request);
    fail("unknown filesystem operation callback", 0);
  }

  uv_fs_req_cleanup(request);
  switch (step) {
  case FS_OPEN:
    queue_fs_write();
    break;
  case FS_WRITE:
    queue_fs_fsync();
    break;
  case FS_FSYNC:
    queue_fs_read();
    break;
  case FS_READ:
    queue_fs_stat();
    break;
  case FS_STAT:
    queue_fs_close();
    break;
  case FS_CLOSE:
    state.data_fd = -1;
    queue_fs_unlink();
    break;
  case FS_UNLINK:
    print_stage("libuv: async fs write/fsync/read/stat/close/unlink ok");
    state.stage = 3;
    start_pipe_stage();
    break;
  }
}

static void start_filesystem_stage(void) {
  state.data_fd = -1;
  int length = snprintf(state.data_path, sizeof(state.data_path),
                        "/tmp/libuv-runtime-%ld.dat", (long)getpid());
  if (length < 0 || (size_t)length >= sizeof(state.data_path))
    fail("formatting temporary data path", 0);
  queue_fs_open();
}

static void close_phase3_handle(uv_handle_t *handle) {
  if (!uv_is_closing(handle))
    uv_close(handle, NULL);
}

static void maybe_finish_pipe_stage(void) {
  if (state.phase3_closed || !state.client_connected ||
      !state.client_write_done || !state.have_server_payload ||
      !state.server_write_done || !state.have_client_payload ||
      !state.timer_fired)
    return;

  if (state.server_payload_size != PAYLOAD_SIZE ||
      state.client_payload_size != PAYLOAD_SIZE ||
      memcmp(state.server_payload, payload, PAYLOAD_SIZE) != 0 ||
      memcmp(state.client_payload, payload, PAYLOAD_SIZE) != 0)
    fail("Unix pipe echo changed the binary payload", 0);

  state.phase3_closed = true;
  print_stage("libuv: unix pipe binary echo and timer ok");
  close_phase3_handle((uv_handle_t *)&state.server);
  close_phase3_handle((uv_handle_t *)&state.client);
  close_phase3_handle((uv_handle_t *)&state.peer);
  close_phase3_handle((uv_handle_t *)&state.phase_timer);
  close_phase3_handle((uv_handle_t *)&state.watchdog);
}

static void pipe_alloc(uv_handle_t *handle, size_t suggested_size,
                       uv_buf_t *buffer) {
  (void)handle;
  size_t size = suggested_size < 64 ? 64 : suggested_size;
  buffer->base = malloc(size);
  buffer->len = buffer->base == NULL ? 0 : size;
  if (buffer->base == NULL)
    fail("allocating pipe read buffer", 0);
}

static void on_client_read(uv_stream_t *stream, ssize_t nread,
                           const uv_buf_t *buffer);

static void on_server_write(uv_write_t *request, int status) {
  free(request);
  if (status < 0)
    fail("writing binary echo to client", status);
  state.server_write_done = true;
  maybe_finish_pipe_stage();
}

static void on_peer_read(uv_stream_t *stream, ssize_t nread,
                         const uv_buf_t *buffer) {
  (void)stream;
  if (nread > 0) {
    size_t amount = (size_t)nread;
    if (amount > PAYLOAD_SIZE - state.server_payload_size) {
      free(buffer->base);
      fail("server received too much pipe data", 0);
    }
    memcpy(state.server_payload + state.server_payload_size, buffer->base,
           amount);
    state.server_payload_size += amount;
    if (state.server_payload_size == PAYLOAD_SIZE) {
      if (memcmp(state.server_payload, payload, PAYLOAD_SIZE) != 0) {
        free(buffer->base);
        fail("server received the wrong binary payload", 0);
      }
      state.have_server_payload = true;
      uv_read_stop(stream);
      uv_write_t *write_request = calloc(1, sizeof(*write_request));
      if (write_request == NULL) {
        free(buffer->base);
        fail("allocating echo write request", 0);
      }
      uv_buf_t echo = uv_buf_init((char *)state.server_payload, PAYLOAD_SIZE);
      int rc = uv_write(write_request, stream, &echo, 1, on_server_write);
      if (rc < 0) {
        free(write_request);
        free(buffer->base);
        fail("queueing binary echo", rc);
      }
    }
  } else if (nread < 0 && nread != UV_EOF) {
    free(buffer->base);
    fail("reading Unix pipe server", (int)nread);
  }
  free(buffer->base);
}

static void on_connection(uv_stream_t *server, int status) {
  (void)server;
  if (status < 0)
    fail("accepting Unix pipe connection", status);
  int rc = uv_pipe_init(&state.loop, &state.peer, 0);
  if (rc < 0)
    fail("initializing Unix pipe peer", rc);
  rc = uv_accept((uv_stream_t *)&state.server, (uv_stream_t *)&state.peer);
  if (rc < 0)
    fail("accepting Unix pipe peer", rc);
  rc = uv_read_start((uv_stream_t *)&state.peer, pipe_alloc, on_peer_read);
  if (rc < 0)
    fail("starting Unix pipe server read", rc);
}

static void on_client_write(uv_write_t *request, int status) {
  free(request);
  if (status < 0)
    fail("writing binary payload to Unix pipe", status);
  state.client_write_done = true;
  maybe_finish_pipe_stage();
}

static void on_client_connect(uv_connect_t *request, int status) {
  (void)request;
  if (status < 0)
    fail("connecting Unix pipe client", status);
  state.client_connected = true;

  uv_write_t *write_request = calloc(1, sizeof(*write_request));
  if (write_request == NULL)
    fail("allocating client write request", 0);
  uv_buf_t message = uv_buf_init((char *)payload, PAYLOAD_SIZE);
  int rc = uv_write(write_request, (uv_stream_t *)&state.client, &message, 1,
                    on_client_write);
  if (rc < 0) {
    free(write_request);
    fail("queueing binary payload to Unix pipe", rc);
  }
  rc = uv_read_start((uv_stream_t *)&state.client, pipe_alloc, on_client_read);
  if (rc < 0)
    fail("starting Unix pipe client read", rc);
}

static void on_client_read(uv_stream_t *stream, ssize_t nread,
                           const uv_buf_t *buffer) {
  if (nread > 0) {
    size_t amount = (size_t)nread;
    if (amount > PAYLOAD_SIZE - state.client_payload_size) {
      free(buffer->base);
      fail("client received too much echo data", 0);
    }
    memcpy(state.client_payload + state.client_payload_size, buffer->base,
           amount);
    state.client_payload_size += amount;
    if (state.client_payload_size == PAYLOAD_SIZE) {
      if (memcmp(state.client_payload, payload, PAYLOAD_SIZE) != 0) {
        free(buffer->base);
        fail("client received the wrong binary echo", 0);
      }
      state.have_client_payload = true;
      uv_read_stop(stream);
      maybe_finish_pipe_stage();
    }
  } else if (nread < 0 && nread != UV_EOF) {
    free(buffer->base);
    fail("reading Unix pipe client", (int)nread);
  }
  free(buffer->base);
}

static void on_phase_timer(uv_timer_t *timer) {
  (void)timer;
  state.timer_fired = true;
  maybe_finish_pipe_stage();
}

static void start_pipe_stage(void) {
  int length = snprintf(state.socket_path, sizeof(state.socket_path),
                        "/tmp/libuv-runtime-%ld.sock", (long)getpid());
  if (length < 0 || (size_t)length >= sizeof(state.socket_path))
    fail("formatting Unix socket path", 0);

  int rc = uv_pipe_init(&state.loop, &state.server, 0);
  if (rc < 0)
    fail("initializing Unix pipe server", rc);
  rc = uv_pipe_bind(&state.server, state.socket_path);
  if (rc < 0)
    fail("binding Unix pipe server", rc);
  rc = uv_listen((uv_stream_t *)&state.server, 1, on_connection);
  if (rc < 0)
    fail("listening on Unix pipe server", rc);

  rc = uv_pipe_init(&state.loop, &state.client, 0);
  if (rc < 0)
    fail("initializing Unix pipe client", rc);

  rc = uv_timer_init(&state.loop, &state.phase_timer);
  if (rc < 0)
    fail("initializing phase timer", rc);
  rc = uv_timer_start(&state.phase_timer, on_phase_timer, 20, 0);
  if (rc < 0)
    fail("starting phase timer", rc);

  state.connect_request.data = &state;
  uv_pipe_connect(&state.connect_request, &state.client, state.socket_path,
                  on_client_connect);
}

int main(void) {
  memset(&state, 0, sizeof(state));
  state.data_fd = -1;
  int rc = uv_loop_init(&state.loop);
  if (rc < 0)
    fail("uv_loop_init", rc);

  rc = uv_timer_init(&state.loop, &state.watchdog);
  if (rc < 0)
    fail("initializing runtime watchdog", rc);
  rc = uv_timer_start(&state.watchdog, on_watchdog, WATCHDOG_MS, 0);
  if (rc < 0)
    fail("starting runtime watchdog", rc);

  state.stage = 1;
  start_spawn_stage();
  uv_run(&state.loop, UV_RUN_DEFAULT);

  if (state.stage != 3)
    fail("event loop stopped before completing all stages", 0);
  if (state.data_fd != -1)
    fail("temporary data file descriptor remained open", 0);
  if (unlink(state.socket_path) != 0 && errno != ENOENT)
    fail("removing Unix pipe socket path", 0);
  rc = uv_loop_close(&state.loop);
  if (rc < 0)
    fail("uv_loop_close found an open handle or request", rc);
  return EXIT_SUCCESS;
}
