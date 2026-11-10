/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE

#include <arpa/inet.h>
#include <event2/bufferevent.h>
#include <event2/buffer.h>
#include <event2/event.h>
#include <event2/listener.h>
#include <event2/thread.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static const unsigned char payload[] = { 0x00, 0x42, 0x7f, 0x80, 0xff, 0x0a, 0x00, 0x5a };

struct runtime_state {
  struct event_base *base;
  struct evconnlistener *listener;
  struct bufferevent *client;
  struct bufferevent *server;
  struct event *signal_event;
  struct event *timer_event;
  struct event *watchdog_event;
  size_t server_received;
  size_t client_received;
  int client_connected;
  int echo_sent;
  int echo_received;
  int connection_closed;
  int signal_received;
  int timer_fired;
  const char *error;
};

static void
fail(struct runtime_state *state, const char *message)
{
  if (state->error == NULL)
    state->error = message;
  if (state->base != NULL)
    event_base_loopbreak(state->base);
}

static void
finish_if_ready(struct runtime_state *state)
{
  if (state->client_connected && state->echo_received && state->connection_closed &&
      state->signal_received && state->timer_fired)
    event_base_loopexit(state->base, NULL);
}

static void server_read(struct bufferevent *bev, void *context);
static void server_event(struct bufferevent *bev, short events, void *context);

static void
accepted_connection(struct evconnlistener *listener, evutil_socket_t fd,
                    struct sockaddr *address, int address_length, void *context)
{
  struct runtime_state *state = context;

  (void)listener;
  (void)address;
  (void)address_length;
  if (state->server != NULL) {
    evutil_closesocket(fd);
    fail(state, "listener accepted more than one client");
    return;
  }

  state->server = bufferevent_socket_new(state->base, fd, BEV_OPT_CLOSE_ON_FREE);
  if (state->server == NULL) {
    evutil_closesocket(fd);
    fail(state, "creating accepted bufferevent");
    return;
  }
  bufferevent_setcb(state->server, server_read, NULL, server_event, state);
  if (bufferevent_enable(state->server, EV_READ | EV_WRITE) != 0) {
    bufferevent_free(state->server);
    state->server = NULL;
    fail(state, "enabling accepted bufferevent");
    return;
  }
  if (evconnlistener_disable(listener) != 0)
    fail(state, "disabling single-connection listener");
}

static void
client_read(struct bufferevent *bev, void *context)
{
  struct runtime_state *state = context;
  struct evbuffer *input = bufferevent_get_input(bev);
  size_t available = evbuffer_get_length(input);
  size_t remaining = sizeof(payload) - state->client_received;
  ssize_t count;

  if (available > remaining) {
    fail(state, "client received an oversized echo");
    return;
  }
  while (available > 0) {
    unsigned char received[sizeof(payload)];
    size_t take = available;

    if (take > sizeof(payload) - state->client_received)
      take = sizeof(payload) - state->client_received;
    count = evbuffer_remove(input, received, take);
    if (count <= 0) {
      fail(state, "reading client echo buffer");
      return;
    }
    if (memcmp(received, payload + state->client_received, (size_t)count) != 0) {
      fail(state, "binary TCP echo did not match");
      return;
    }
    state->client_received += (size_t)count;
    available -= (size_t)count;
  }

  if (state->client_received == sizeof(payload)) {
    state->echo_received = 1;
    bufferevent_free(state->client);
    state->client = NULL;
    finish_if_ready(state);
  }
}

static void
server_read(struct bufferevent *bev, void *context)
{
  struct runtime_state *state = context;
  struct evbuffer *input = bufferevent_get_input(bev);
  size_t available = evbuffer_get_length(input);

  if (available > sizeof(payload) - state->server_received) {
    fail(state, "server received an oversized request");
    return;
  }
  while (available > 0) {
    unsigned char received[sizeof(payload)];
    size_t take = available;
    ssize_t count;

    if (take > sizeof(payload) - state->server_received)
      take = sizeof(payload) - state->server_received;
    count = evbuffer_remove(input, received, take);
    if (count <= 0) {
      fail(state, "reading server request buffer");
      return;
    }
    if (memcmp(received, payload + state->server_received, (size_t)count) != 0) {
      fail(state, "binary TCP request did not match");
      return;
    }
    state->server_received += (size_t)count;
    available -= (size_t)count;
  }

  if (state->server_received == sizeof(payload) && !state->echo_sent) {
    if (bufferevent_write(bev, payload, sizeof(payload)) != 0) {
      fail(state, "writing server echo");
      return;
    }
    state->echo_sent = 1;
  }
}

static void
server_event(struct bufferevent *bev, short events, void *context)
{
  struct runtime_state *state = context;

  if ((events & BEV_EVENT_EOF) == 0 || !state->echo_sent) {
    fail(state, "server connection ended before the echo completed");
    return;
  }
  state->connection_closed = 1;
  bufferevent_free(bev);
  state->server = NULL;
  finish_if_ready(state);
}

static void
client_event(struct bufferevent *bev, short events, void *context)
{
  struct runtime_state *state = context;

  if ((events & BEV_EVENT_CONNECTED) != 0) {
    state->client_connected = 1;
    if (bufferevent_write(bev, payload, sizeof(payload)) != 0) {
      fail(state, "writing client request");
      return;
    }
    finish_if_ready(state);
    return;
  }
  fail(state, "client connection failed or closed unexpectedly");
}

static void
signal_callback(evutil_socket_t signal_number, short events, void *context)
{
  struct runtime_state *state = context;

  (void)events;
  if (signal_number != SIGUSR1) {
    fail(state, "unexpected signal event");
    return;
  }
  state->signal_received = 1;
  finish_if_ready(state);
}

static void
timer_callback(evutil_socket_t fd, short events, void *context)
{
  struct runtime_state *state = context;

  (void)fd;
  (void)events;
  state->timer_fired = 1;
  finish_if_ready(state);
}

static void
watchdog_callback(evutil_socket_t fd, short events, void *context)
{
  struct runtime_state *state = context;

  (void)fd;
  (void)events;
  fail(state, "internal event-loop watchdog expired");
}

static void
discard_event(struct runtime_state *state, struct event **event_pointer)
{
  const short flags = EV_READ | EV_WRITE | EV_SIGNAL | EV_TIMEOUT;
  struct event *event = *event_pointer;

  if (event == NULL)
    return;
  if (event_del(event) != 0 && state->error == NULL)
    state->error = "deleting a runtime event";
  if (event_pending(event, flags, NULL) != 0 && state->error == NULL)
    state->error = "runtime event remained pending after deletion";
  event_free(event);
  *event_pointer = NULL;
}

static void
cleanup(struct runtime_state *state)
{
  if (state->client != NULL)
    bufferevent_free(state->client);
  if (state->server != NULL)
    bufferevent_free(state->server);
  if (state->listener != NULL)
    evconnlistener_free(state->listener);
  discard_event(state, &state->signal_event);
  discard_event(state, &state->timer_event);
  discard_event(state, &state->watchdog_event);
  if (state->base != NULL)
    event_base_free(state->base);
}

int
main(void)
{
  struct runtime_state state = { 0 };
  struct sockaddr_in address = { 0 };
  struct timeval short_timeout = { .tv_sec = 0, .tv_usec = 20000 };
  struct timeval watchdog_timeout = { .tv_sec = 4, .tv_usec = 0 };
  socklen_t address_length = sizeof(address);
  const char *method;
  int dispatch_result;

  if (evthread_use_pthreads() != 0) {
    state.error = "initializing libevent pthread support";
    goto done;
  }
  state.base = event_base_new();
  if (state.base == NULL) {
    state.error = "creating event base";
    goto done;
  }
  method = event_base_get_method(state.base);
  if (method == NULL || strcmp(method, "epoll") != 0) {
    state.error = "libevent did not select the epoll backend";
    goto done;
  }

  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  state.listener = evconnlistener_new_bind(
      state.base, accepted_connection, &state,
      LEV_OPT_CLOSE_ON_FREE | LEV_OPT_REUSEABLE, -1,
      (struct sockaddr *)&address, sizeof(address));
  if (state.listener == NULL) {
    state.error = "creating loopback TCP listener";
    goto done;
  }
  if (getsockname(evconnlistener_get_fd(state.listener), (struct sockaddr *)&address,
                  &address_length) != 0) {
    state.error = "reading loopback listener address";
    goto done;
  }

  state.signal_event = evsignal_new(state.base, SIGUSR1, signal_callback, &state);
  state.timer_event = evtimer_new(state.base, timer_callback, &state);
  state.watchdog_event = evtimer_new(state.base, watchdog_callback, &state);
  if (state.signal_event == NULL || state.timer_event == NULL || state.watchdog_event == NULL) {
    state.error = "creating signal and timer events";
    goto done;
  }
  if (event_add(state.signal_event, NULL) != 0 ||
      evtimer_add(state.timer_event, &short_timeout) != 0 ||
      evtimer_add(state.watchdog_event, &watchdog_timeout) != 0) {
    state.error = "registering signal and timer events";
    goto done;
  }
  if (kill(getpid(), SIGUSR1) != 0) {
    state.error = "sending SIGUSR1 to self";
    goto done;
  }

  state.client = bufferevent_socket_new(state.base, -1, BEV_OPT_CLOSE_ON_FREE);
  if (state.client == NULL) {
    state.error = "creating client bufferevent";
    goto done;
  }
  bufferevent_setcb(state.client, client_read, NULL, client_event, &state);
  if (bufferevent_enable(state.client, EV_READ | EV_WRITE) != 0 ||
      bufferevent_socket_connect(state.client, (struct sockaddr *)&address,
                                 sizeof(address)) != 0) {
    state.error = "connecting loopback TCP client";
    goto done;
  }

  dispatch_result = event_base_dispatch(state.base);
  if (dispatch_result < 0 && state.error == NULL)
    state.error = "dispatching libevent loop";
  if (dispatch_result != 0 && state.error == NULL)
    state.error = "event loop stopped before all events completed";
  if (!state.client_connected || !state.echo_received || !state.connection_closed ||
      !state.signal_received || !state.timer_fired) {
    if (state.error == NULL)
      state.error = "one or more runtime events did not complete";
  }

done:
  cleanup(&state);
  if (state.error != NULL) {
    fprintf(stderr, "libevent runtime failure: %s\n", state.error);
    return 1;
  }

  puts("libevent: epoll backend selected");
  puts("libevent: loopback TCP bufferevent binary echo and close ok");
  puts("libevent: SIGUSR1 signal event ok");
  puts("libevent: short timer event ok");
  puts("libevent: event_base cleanup left no pending events");
  return 0;
}
