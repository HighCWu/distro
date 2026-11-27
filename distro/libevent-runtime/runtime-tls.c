// SPDX-License-Identifier: MIT
#include <event2/buffer.h>
#include <event2/bufferevent.h>
#include <event2/bufferevent_ssl.h>
#include <event2/event.h>
#include <event2/listener.h>

#include <arpa/inet.h>
#include <netinet/in.h>
#include <openssl/err.h>
#include <openssl/ssl.h>
#include <openssl/x509_vfy.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>

#define FIXTURE_DIRECTORY "/share/libevent-runtime/tls-test"
#define VERIFY_TIME ((time_t)1794286348)
#define WATCHDOG_SECONDS 15

static const unsigned char payload[] = {
    0x00, 'l', 'i', 'b', 'e', 'v', 'e', 'n', 't', 0xff, 0x80, '\n',
};

enum phase {
  PHASE_FIRST_TRUSTED,
  PHASE_REJECT_UNTRUSTED,
  PHASE_RECOVERY_TRUSTED,
  PHASE_DONE,
};

struct test_state {
  struct event_base *base;
  struct evconnlistener *listener;
  struct event *transition_timer;
  struct event *watchdog_timer;
  SSL_CTX *server_context;
  SSL_CTX *trusted_client_context;
  SSL_CTX *untrusted_client_context;
  struct bufferevent *client;
  struct bufferevent *server;
  struct sockaddr_in address;
  enum phase phase;
  size_t client_received;
  size_t server_received;
  unsigned accepted_connections;
  int client_connected;
  int client_shutdown_started;
  int server_connected;
  int server_shutdown_sent;
  int bad_client_rejected;
  int bad_server_closed;
  int bad_connection_accepted;
  int failed;
};

static void client_read_cb(struct bufferevent *bev, void *opaque);
static void client_event_cb(struct bufferevent *bev, short events, void *opaque);
static void server_read_cb(struct bufferevent *bev, void *opaque);
static void server_event_cb(struct bufferevent *bev, short events, void *opaque);
static void listener_cb(struct evconnlistener *listener, evutil_socket_t fd,
                        struct sockaddr *address, int address_length,
                        void *opaque);

static void fail_test(struct test_state *state, const char *message) {
  if (state->failed) {
    return;
  }
  state->failed = 1;
  fprintf(stderr, "libevent TLS runtime failure: %s\n", message);
  ERR_print_errors_fp(stderr);
  if (state->base != NULL) {
    event_base_loopbreak(state->base);
  }
}

static int set_verify_time(SSL_CTX *context) {
  X509_VERIFY_PARAM *parameters = SSL_CTX_get0_param(context);
  if (parameters == NULL) {
    return 0;
  }
  X509_VERIFY_PARAM_set_time(parameters, VERIFY_TIME);
  return 1;
}

static SSL_CTX *new_client_context(int trust_test_certificate) {
  SSL_CTX *context = SSL_CTX_new(TLS_client_method());
  if (context == NULL ||
      SSL_CTX_set_min_proto_version(context, TLS1_2_VERSION) != 1 ||
      SSL_CTX_set_max_proto_version(context, TLS1_2_VERSION) != 1 ||
      !set_verify_time(context)) {
    SSL_CTX_free(context);
    return NULL;
  }

  SSL_CTX_set_verify(context, SSL_VERIFY_PEER, NULL);
  if (trust_test_certificate) {
    char certificate_path[512];
    const char *directory = getenv("LIBEVENT_TLS_FIXTURE_DIR");
    if (directory == NULL || directory[0] == '\0') {
      directory = FIXTURE_DIRECTORY;
    }
    int length = snprintf(certificate_path, sizeof(certificate_path), "%s/%s",
                          directory, "localhost-test-cert.pem");
    if (length < 0 || (size_t)length >= sizeof(certificate_path) ||
        SSL_CTX_load_verify_locations(context, certificate_path, NULL) != 1) {
      SSL_CTX_free(context);
      return NULL;
    }
  }
  return context;
}

static SSL_CTX *new_server_context(void) {
  char certificate_path[512];
  char key_path[512];
  const char *directory = getenv("LIBEVENT_TLS_FIXTURE_DIR");
  if (directory == NULL || directory[0] == '\0') {
    directory = FIXTURE_DIRECTORY;
  }

  int certificate_length =
      snprintf(certificate_path, sizeof(certificate_path), "%s/%s", directory,
               "localhost-test-cert.pem");
  int key_length = snprintf(key_path, sizeof(key_path), "%s/%s", directory,
                            "localhost-test-key.pem");
  if (certificate_length < 0 ||
      (size_t)certificate_length >= sizeof(certificate_path) || key_length < 0 ||
      (size_t)key_length >= sizeof(key_path)) {
    return NULL;
  }

  SSL_CTX *context = SSL_CTX_new(TLS_server_method());
  if (context == NULL ||
      SSL_CTX_set_min_proto_version(context, TLS1_2_VERSION) != 1 ||
      SSL_CTX_set_max_proto_version(context, TLS1_2_VERSION) != 1 ||
      SSL_CTX_use_certificate_chain_file(context, certificate_path) != 1 ||
      SSL_CTX_use_PrivateKey_file(context, key_path, SSL_FILETYPE_PEM) != 1 ||
      SSL_CTX_check_private_key(context) != 1) {
    SSL_CTX_free(context);
    return NULL;
  }
  return context;
}

static void close_client(struct test_state *state) {
  if (state->client != NULL) {
    bufferevent_free(state->client);
    state->client = NULL;
  }
}

static void close_server(struct test_state *state) {
  if (state->server != NULL) {
    bufferevent_free(state->server);
    state->server = NULL;
  }
}

static void start_client(struct test_state *state) {
  SSL_CTX *context = state->phase == PHASE_REJECT_UNTRUSTED
                         ? state->untrusted_client_context
                         : state->trusted_client_context;
  SSL *ssl = SSL_new(context);
  if (ssl == NULL || SSL_set1_host(ssl, "localhost") != 1 ||
      SSL_set_tlsext_host_name(ssl, "localhost") != 1) {
    SSL_free(ssl);
    fail_test(state, "configuring the TLS client hostname failed");
    return;
  }

  state->client = bufferevent_openssl_socket_new(
      state->base, -1, ssl, BUFFEREVENT_SSL_CONNECTING,
      BEV_OPT_CLOSE_ON_FREE | BEV_OPT_DEFER_CALLBACKS);
  if (state->client == NULL) {
    SSL_free(ssl);
    fail_test(state, "creating the OpenSSL client bufferevent failed");
    return;
  }

  state->client_connected = 0;
  state->client_shutdown_started = 0;
  state->client_received = 0;
  bufferevent_setcb(state->client, client_read_cb, NULL, client_event_cb, state);
  bufferevent_setwatermark(state->client, EV_READ, 1, 0);
  if (bufferevent_enable(state->client, EV_READ | EV_WRITE) != 0 ||
      bufferevent_socket_connect(state->client,
                                 (struct sockaddr *)&state->address,
                                 sizeof(state->address)) != 0) {
    fail_test(state, "connecting the TLS client to loopback failed");
  }
}

static void start_phase_cb(evutil_socket_t fd, short events, void *opaque) {
  (void)fd;
  (void)events;
  struct test_state *state = opaque;
  start_client(state);
}

static void schedule_phase(struct test_state *state, enum phase phase) {
  state->phase = phase;
  struct timeval delay = {.tv_sec = 0, .tv_usec = 20000};
  if (evtimer_add(state->transition_timer, &delay) != 0) {
    fail_test(state, "scheduling the next TLS phase failed");
  }
}

static void complete_trusted_phase(struct test_state *state) {
  if (state->client_received != sizeof(payload) ||
      state->server_received != sizeof(payload) ||
      !state->client_shutdown_started || !state->server_shutdown_sent) {
    fail_test(state, "trusted TLS phase ended before echo and close_notify completed");
    return;
  }

  close_client(state);
  close_server(state);
  if (state->phase == PHASE_FIRST_TRUSTED) {
    puts("libevent TLS: trusted localhost binary echo and close_notify ok");
    schedule_phase(state, PHASE_REJECT_UNTRUSTED);
  } else if (state->phase == PHASE_RECOVERY_TRUSTED) {
    puts("libevent TLS: trusted connection recovered after rejection");
    state->phase = PHASE_DONE;
    event_base_loopbreak(state->base);
  } else {
    fail_test(state, "trusted TLS phase completed in an unexpected state");
  }
}

static void maybe_advance_rejected_phase(struct test_state *state) {
  if (state->phase != PHASE_REJECT_UNTRUSTED ||
      !state->bad_connection_accepted || !state->bad_client_rejected ||
      !state->bad_server_closed || state->client != NULL ||
      state->server != NULL) {
    return;
  }

  puts("libevent TLS: untrusted self-signed certificate rejected");
  schedule_phase(state, PHASE_RECOVERY_TRUSTED);
}

static void client_read_cb(struct bufferevent *bev, void *opaque) {
  struct test_state *state = opaque;
  if (state->phase == PHASE_REJECT_UNTRUSTED) {
    if (evbuffer_get_length(bufferevent_get_input(bev)) != 0) {
      fail_test(state, "untrusted TLS connection delivered application data");
    }
    return;
  }

  struct evbuffer *input = bufferevent_get_input(bev);
  unsigned char bytes[128];
  while (evbuffer_get_length(input) != 0) {
    size_t available = evbuffer_get_length(input);
    if (available > sizeof(bytes)) {
      fail_test(state, "TLS echo exceeded the receive buffer");
      return;
    }
    int count = evbuffer_remove(input, bytes, available);
    if (count <= 0 || state->client_received + (size_t)count > sizeof(payload) ||
        memcmp(bytes, payload + state->client_received, (size_t)count) != 0) {
      fail_test(state, "TLS echo did not preserve the binary payload");
      return;
    }
    state->client_received += (size_t)count;
  }

  if (state->client_received == sizeof(payload) &&
      !state->client_shutdown_started) {
    SSL *ssl = bufferevent_openssl_get_ssl(bev);
    int result = SSL_shutdown(ssl);
    int shutdown_flags = SSL_get_shutdown(ssl);
    if ((shutdown_flags & SSL_SENT_SHUTDOWN) == 0 ||
        (result < 0 && SSL_get_error(ssl, result) != SSL_ERROR_WANT_READ &&
         SSL_get_error(ssl, result) != SSL_ERROR_WANT_WRITE)) {
      fail_test(state, "sending the client close_notify failed");
      return;
    }
    state->client_shutdown_started = 1;
  }
}

static void client_event_cb(struct bufferevent *bev, short events, void *opaque) {
  struct test_state *state = opaque;
  if ((events & BEV_EVENT_CONNECTED) != 0) {
    if (state->phase == PHASE_REJECT_UNTRUSTED) {
      fail_test(state, "untrusted TLS connection unexpectedly completed");
      return;
    }
    SSL *ssl = bufferevent_openssl_get_ssl(bev);
    if (SSL_get_verify_result(ssl) != X509_V_OK ||
        SSL_get0_peer_certificate(ssl) == NULL) {
      fail_test(state, "trusted TLS peer or localhost hostname verification failed");
      return;
    }
    state->client_connected = 1;
    if (bufferevent_write(bev, payload, sizeof(payload)) != 0) {
      fail_test(state, "writing the binary TLS payload failed");
    }
    return;
  }

  if (state->phase == PHASE_REJECT_UNTRUSTED &&
      (events & (BEV_EVENT_ERROR | BEV_EVENT_EOF)) != 0) {
    SSL *ssl = bufferevent_openssl_get_ssl(bev);
    if (SSL_get_verify_result(ssl) != X509_V_ERR_DEPTH_ZERO_SELF_SIGNED_CERT) {
      fail_test(state, "untrusted TLS peer failed for a reason other than its self-signed certificate");
      return;
    }
    ERR_clear_error();
    state->bad_client_rejected = 1;
    close_client(state);
    maybe_advance_rejected_phase(state);
    return;
  }

  if ((events & BEV_EVENT_EOF) != 0 && state->phase != PHASE_REJECT_UNTRUSTED) {
    SSL *ssl = bufferevent_openssl_get_ssl(bev);
    int flags = SSL_get_shutdown(ssl);
    int result = SSL_shutdown(ssl);
    if (!state->client_connected || !state->client_shutdown_started ||
        state->client_received != sizeof(payload) ||
        (flags & (SSL_SENT_SHUTDOWN | SSL_RECEIVED_SHUTDOWN)) !=
            (SSL_SENT_SHUTDOWN | SSL_RECEIVED_SHUTDOWN) ||
        result != 1 || !state->server_shutdown_sent) {
      fail_test(state, "the trusted TLS client did not observe both close_notify records");
      return;
    }
    complete_trusted_phase(state);
    return;
  }

  fail_test(state, "unexpected TLS client event");
}

static void server_read_cb(struct bufferevent *bev, void *opaque) {
  struct test_state *state = opaque;
  struct evbuffer *input = bufferevent_get_input(bev);
  if (state->phase == PHASE_REJECT_UNTRUSTED &&
      evbuffer_get_length(input) != 0) {
    fail_test(state, "untrusted TLS connection sent application data");
    return;
  }

  unsigned char bytes[128];
  while (evbuffer_get_length(input) != 0) {
    size_t available = evbuffer_get_length(input);
    if (available > sizeof(bytes)) {
      fail_test(state, "TLS request exceeded the receive buffer");
      return;
    }
    int count = evbuffer_remove(input, bytes, available);
    if (state->server_received + (size_t)count > sizeof(payload) || count <= 0 ||
        memcmp(bytes, payload + state->server_received, (size_t)count) != 0) {
      fail_test(state, "TLS request did not preserve the binary payload");
      return;
    }
    state->server_received += (size_t)count;
    if (bufferevent_write(bev, bytes, (size_t)count) != 0) {
      fail_test(state, "writing the TLS echo failed");
      return;
    }
  }
}

static void server_event_cb(struct bufferevent *bev, short events, void *opaque) {
  struct test_state *state = opaque;
  if ((events & BEV_EVENT_CONNECTED) != 0) {
    state->server_connected = 1;
    return;
  }

  if (state->phase == PHASE_REJECT_UNTRUSTED &&
      (events & (BEV_EVENT_ERROR | BEV_EVENT_EOF)) != 0) {
    if (evbuffer_get_length(bufferevent_get_input(bev)) != 0) {
      fail_test(state, "untrusted TLS connection left unexpected input");
      return;
    }
    ERR_clear_error();
    state->bad_server_closed = 1;
    close_server(state);
    maybe_advance_rejected_phase(state);
    return;
  }

  if ((events & BEV_EVENT_EOF) != 0 && state->phase != PHASE_REJECT_UNTRUSTED) {
    SSL *ssl = bufferevent_openssl_get_ssl(bev);
    int flags = SSL_get_shutdown(ssl);
    int result = SSL_shutdown(ssl);
    int shutdown_flags = SSL_get_shutdown(ssl);
    if (!state->server_connected ||
        state->server_received != sizeof(payload) ||
        (flags & SSL_RECEIVED_SHUTDOWN) == 0 ||
        (shutdown_flags & (SSL_SENT_SHUTDOWN | SSL_RECEIVED_SHUTDOWN)) !=
            (SSL_SENT_SHUTDOWN | SSL_RECEIVED_SHUTDOWN) ||
        (result < 0 && SSL_get_error(ssl, result) != SSL_ERROR_WANT_READ &&
         SSL_get_error(ssl, result) != SSL_ERROR_WANT_WRITE)) {
      fail_test(state, "the TLS server did not exchange close_notify cleanly");
      return;
    }
    state->server_shutdown_sent = 1;
    return;
  }

  fail_test(state, "unexpected TLS server event");
}

static void listener_cb(struct evconnlistener *listener, evutil_socket_t fd,
                        struct sockaddr *address, int address_length,
                        void *opaque) {
  (void)listener;
  (void)address;
  (void)address_length;
  struct test_state *state = opaque;
  if (state->server != NULL || state->phase == PHASE_DONE ||
      ++state->accepted_connections > 3) {
    evutil_closesocket(fd);
    fail_test(state, "loopback TLS listener accepted an unexpected connection");
    return;
  }
  if (state->phase == PHASE_REJECT_UNTRUSTED) {
    state->bad_connection_accepted = 1;
  }

  SSL *ssl = SSL_new(state->server_context);
  if (ssl == NULL) {
    evutil_closesocket(fd);
    fail_test(state, "creating the TLS server session failed");
    return;
  }
  state->server = bufferevent_openssl_socket_new(
      state->base, fd, ssl, BUFFEREVENT_SSL_ACCEPTING,
      BEV_OPT_CLOSE_ON_FREE | BEV_OPT_DEFER_CALLBACKS);
  if (state->server == NULL) {
    SSL_free(ssl);
    evutil_closesocket(fd);
    fail_test(state, "creating the OpenSSL server bufferevent failed");
    return;
  }

  state->server_connected = 0;
  state->server_shutdown_sent = 0;
  state->server_received = 0;
  bufferevent_setcb(state->server, server_read_cb, NULL, server_event_cb, state);
  bufferevent_setwatermark(state->server, EV_READ, 1, 0);
  if (bufferevent_enable(state->server, EV_READ | EV_WRITE) != 0) {
    fail_test(state, "enabling the TLS server bufferevent failed");
  }
}

static void watchdog_cb(evutil_socket_t fd, short events, void *opaque) {
  (void)fd;
  (void)events;
  fail_test(opaque, "the loopback TLS checks exceeded their internal watchdog");
}

int main(void) {
  struct test_state state;
  memset(&state, 0, sizeof(state));
  state.phase = PHASE_FIRST_TRUSTED;
  state.base = event_base_new();
  if (state.base == NULL) {
    fputs("libevent TLS runtime failure: creating event_base failed\n", stderr);
    return 1;
  }

  state.server_context = new_server_context();
  state.trusted_client_context = new_client_context(1);
  state.untrusted_client_context = new_client_context(0);
  if (state.server_context == NULL || state.trusted_client_context == NULL ||
      state.untrusted_client_context == NULL) {
    fail_test(&state, "loading the TLS test certificate or configuring verification failed");
  }

  memset(&state.address, 0, sizeof(state.address));
  state.address.sin_family = AF_INET;
  state.address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  state.address.sin_port = 0;
  if (!state.failed) {
    state.listener = evconnlistener_new_bind(
        state.base, listener_cb, &state,
        LEV_OPT_CLOSE_ON_FREE | LEV_OPT_REUSEABLE, -1,
        (struct sockaddr *)&state.address, sizeof(state.address));
    if (state.listener == NULL) {
      fail_test(&state, "binding the loopback TLS listener failed");
    }
  }
  if (!state.failed) {
    evutil_socket_t listener_fd = evconnlistener_get_fd(state.listener);
    socklen_t address_length = sizeof(state.address);
    if (getsockname(listener_fd, (struct sockaddr *)&state.address,
                    &address_length) != 0) {
      fail_test(&state, "reading the loopback TLS listener address failed");
    }
  }

  if (!state.failed) {
    state.transition_timer = evtimer_new(state.base, start_phase_cb, &state);
    state.watchdog_timer = evtimer_new(state.base, watchdog_cb, &state);
    if (state.transition_timer == NULL || state.watchdog_timer == NULL) {
      fail_test(&state, "creating TLS phase timers failed");
    }
  }
  if (!state.failed) {
    struct timeval timeout = {.tv_sec = WATCHDOG_SECONDS, .tv_usec = 0};
    if (evtimer_add(state.watchdog_timer, &timeout) != 0) {
      fail_test(&state, "starting the TLS watchdog failed");
    } else {
      start_client(&state);
    }
  }

  if (!state.failed) {
    event_base_dispatch(state.base);
  }
  if (!state.failed && state.phase != PHASE_DONE) {
    fail_test(&state, "the loopback TLS event loop stopped before all phases completed");
  }

  close_client(&state);
  close_server(&state);
  if (state.listener != NULL) {
    evconnlistener_free(state.listener);
  }
  if (state.transition_timer != NULL) {
    event_free(state.transition_timer);
  }
  if (state.watchdog_timer != NULL) {
    event_free(state.watchdog_timer);
  }
  SSL_CTX_free(state.server_context);
  SSL_CTX_free(state.trusted_client_context);
  SSL_CTX_free(state.untrusted_client_context);
  event_base_free(state.base);

  if (state.failed) {
    return 1;
  }
  puts("libevent TLS: event_base cleanup left no pending events");
  return 0;
}
