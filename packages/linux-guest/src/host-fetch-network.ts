// Fetch-backed outbound HTTP. Guests speak plaintext HTTP/1; the adapter
// intentionally translates it to HTTPS Fetch. The supplied callback owns all
// platform routing and policy.

import {
  ByteReader,
  chunked_body,
  declared_raw_body,
  fixed_body,
  parse_request_line,
  serialize_head,
  strip_hop_by_hop,
} from "./http.ts";
import type { NetworkOptions, TcpSession } from "./network.ts";
import {
  bufferRequestBody,
  RequestBodyTooLarge,
  supportsRequestStreams,
} from "./fetch-request-body.ts";

const streamingRequests = supportsRequestStreams();

const PLACEHOLDER_ADDRESS = "198.18.0.1";
const INVALID_HOST_RE = /[/\\?#@\s\u0000-\u001f\u007f]/;
const encoder = new TextEncoder();
const CONTINUE = encoder.encode("HTTP/1.1 100 Continue\r\n\r\n");
const BAD_REQUEST = response_bytes("HTTP/1.1 400 Bad Request", "Bad Request\n");
const EXPECTATION_FAILED = response_bytes(
  "HTTP/1.1 417 Expectation Failed",
  "Expectation Failed\n",
);
const NOT_IMPLEMENTED = response_bytes("HTTP/1.1 501 Not Implemented", "Not Implemented\n");
const BAD_GATEWAY = response_bytes("HTTP/1.1 502 Bad Gateway", "Bad Gateway\n");
const PAYLOAD_TOO_LARGE = response_bytes("HTTP/1.1 413 Content Too Large", "Content Too Large\n");

function response_bytes(status: string, text: string) {
  const body = encoder.encode(text);
  const head = serialize_head(
    status,
    new Headers({
      "content-type": "text/plain; charset=utf-8",
      "content-length": String(body.byteLength),
      connection: "close",
    }),
  );
  const bytes = new Uint8Array(head.byteLength + body.byteLength);
  bytes.set(head);
  bytes.set(body, head.byteLength);
  return bytes;
}

function request_url(host: string, target: string) {
  if (INVALID_HOST_RE.test(host)) throw new Error("invalid HTTP Host");
  const origin = new URL(`https://${host}/`);
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash)
    throw new Error("invalid HTTP Host");
  const url = new URL(target, origin);
  if (url.origin !== origin.origin) throw new Error("invalid HTTP request target");
  return url;
}

function fetch_until_abort(
  request: Request,
  do_fetch: (request: Request) => Response | PromiseLike<Response>,
): Promise<Response> {
  const { signal } = request;
  return new Promise((resolve, reject) => {
    const stop = () => {
      signal.removeEventListener("abort", stop);
      reject(signal.reason);
    };
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    void Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return do_fetch(request);
      })
      .then(
        (response) => {
          signal.removeEventListener("abort", stop);
          if (signal.aborted) {
            // The exchange has already ended, but a callback that ignored the
            // signal may still deliver a stream. Do not leave it running.
            void response.body?.cancel(signal.reason).catch(() => {});
            reject(signal.reason);
          } else {
            resolve(response);
          }
        },
        (error) => {
          signal.removeEventListener("abort", stop);
          reject(error);
        },
      );
  });
}

async function exchange(
  session: TcpSession,
  do_fetch: (request: Request) => Response | PromiseLike<Response>,
  maxBufferedRequestBytes: number,
) {
  // This is a gateway request boundary: reject lone-LF syntax rather than
  // allowing different HTTP parsers to disagree about message boundaries.
  const reader = new ByteReader(session.readable, { strictCrlf: true });
  const writer = session.writable.getWriter();
  const abort = new AbortController();
  let response_reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const stop = () => {
    abort.abort(session.signal.reason);
    // Also unblock request parsing when the sender disconnects mid-header.
    void reader.cancel(session.signal.reason).catch(() => {});
    // Custom Fetch callbacks may return streams unrelated to Request.signal.
    // Cancel the owned reader to unblock an outstanding read on disconnect.
    void response_reader?.cancel(session.signal.reason).catch(() => {});
  };
  session.signal.addEventListener("abort", stop, { once: true });
  if (session.signal.aborted) stop();
  let final_output_started = false;
  async function error_response(response: Uint8Array) {
    final_output_started = true;
    await writer.write(response);
    await writer.close();
  }
  try {
    try {
      abort.signal.throwIfAborted();
      const head = await reader.head();
      abort.signal.throwIfAborted();
      if (!head) return;
      const { method, target } = parse_request_line(head.line);
      if (method === "CONNECT" || head.headers.has("upgrade")) {
        await error_response(NOT_IMPLEMENTED);
        return;
      }
      const hosts = head.rawHeaders.filter(([name]) => name.toLowerCase() === "host");
      if (hosts.length !== 1) throw new Error("HTTP request requires one Host header");
      const framing = declared_raw_body(head);
      const expectation = (head.headers.get("expect") ?? "").toLowerCase();
      if (expectation !== "" && expectation !== "100-continue") {
        await error_response(EXPECTATION_FAILED);
        return;
      }
      const url = request_url(hosts[0]![1], target);
      if ((method === "GET" || method === "HEAD") && framing !== undefined && framing !== 0) {
        throw new Error(`${method} request cannot carry a Fetch body`);
      }
      // Reject a known oversized fallback body before asking the sender to
      // upload it. Chunked bodies still need the incremental byte limit.
      if (!streamingRequests && typeof framing === "number" && framing > maxBufferedRequestBytes) {
        await error_response(PAYLOAD_TOO_LARGE);
        return;
      }
      if (expectation === "100-continue") {
        await writer.write(CONTINUE);
      }
      const headers = new Headers(head.headers);
      strip_hop_by_hop(headers, ["expect", "host", "content-length"]);
      const body =
        framing === undefined || framing === 0
          ? undefined
          : framing === "chunked"
            ? chunked_body(reader)
            : fixed_body(reader, framing);
      const requestBody =
        body && !streamingRequests ? await bufferRequestBody(body, maxBufferedRequestBytes) : body;
      abort.signal.throwIfAborted();
      const request = new Request(url, {
        method,
        headers,
        body: requestBody,
        // Required by Fetch implementations that support streaming uploads.
        ...(body ? { duplex: "half" } : {}),
        credentials: "omit",
        redirect: "manual",
        referrerPolicy: "no-referrer",
        signal: abort.signal,
      } as RequestInit);
      let response: Response;
      try {
        abort.signal.throwIfAborted();
        response = await fetch_until_abort(request, do_fetch);
      } catch (error) {
        if (abort.signal.aborted) throw error;
        if (final_output_started) throw error;
        await error_response(BAD_GATEWAY);
        return;
      }
      // Own the stream even when HTTP semantics suppress its body (HEAD), or
      // downstream headers fail. Custom callbacks need not honor our signal.
      response_reader = response.body?.getReader();
      abort.signal.throwIfAborted();
      if (response.status < 200 || response.status > 599) {
        await error_response(BAD_GATEWAY);
        return;
      }
      const out = new Headers(response.headers);
      strip_hop_by_hop(out, ["content-encoding", "content-length"]);
      out.set("connection", "close");
      final_output_started = true;
      await writer.write(serialize_head(`HTTP/1.1 ${response.status} ${response.statusText}`, out));
      if (
        response_reader &&
        method !== "HEAD" &&
        response.status !== 204 &&
        response.status !== 205 &&
        response.status !== 304
      ) {
        for (;;) {
          const { value, done } = await response_reader.read();
          abort.signal.throwIfAborted();
          if (done) break;
          await writer.write(value);
        }
      }
      abort.signal.throwIfAborted();
      await writer.close();
    } catch (error) {
      if (abort.signal.aborted) throw abort.signal.reason;
      if (final_output_started) throw error;
      await error_response(error instanceof RequestBodyTooLarge ? PAYLOAD_TOO_LARGE : BAD_REQUEST);
    }
  } finally {
    session.signal.removeEventListener("abort", stop);
    abort.abort("HTTP exchange complete");
    await response_reader?.cancel("HTTP exchange complete").catch(() => {});
    response_reader?.releaseLock();
    await reader.cancel("HTTP exchange complete").catch(() => {});
    reader.detach();
    writer.releaseLock();
  }
}

/**
 * Creates networking that translates one plaintext guest HTTP/1 exchange per
 * TCP connection into an HTTPS `Request`. The required callback controls the
 * Fetch implementation and its platform policy; ambient `fetch` is never used.
 */
export function hostFetchNetwork(options: {
  fetch(request: Request): Response | PromiseLike<Response>;
  /** Maximum buffered upload when Request streams are unavailable; defaults to 16 MiB. */
  maxBufferedRequestBytes?: number;
}): NetworkOptions {
  const limit = options.maxBufferedRequestBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw new RangeError("maxBufferedRequestBytes must be a nonnegative safe integer");
  return {
    resolveDns: () => Promise.resolve([PLACEHOLDER_ADDRESS]),
    connectTcp: (session) => exchange(session, options.fetch, limit),
  };
}
