// SPDX-License-Identifier: MIT

// The seam between web APIs (browsers) and node builtins (node, deno).
// Selected at runtime by the presence of process.getBuiltinModule, so bundlers
// only ever see the web path and never try to resolve node builtins.

import { listen_endpoint, post_endpoint, type EmitterEndpoint, type Endpoint } from "./endpoint.ts";
import { assert } from "./util.ts";
import { compile_web_wasm } from "./web-wasm.ts";
import { fork_profile_test } from "./fork-profile.ts";
import { profiled_init_queue } from "./profiled-init.ts";

export interface WorkerHandle {
  post(message: unknown, transfer?: Transferable[]): void;
  terminate(): Promise<void>;
}

export interface WorkerHandlers {
  profileStartup?: boolean;
  on_message(message: unknown): void;
  on_error(error: Error): void;
}

interface Platform {
  load_wasm(url: URL): Promise<{
    bytes: Uint8Array<ArrayBuffer>;
    module: WebAssembly.Module;
  }>;
  spawn_worker(name: string, handlers: WorkerHandlers): WorkerHandle;
  worker_endpoint(): Endpoint;
  quit(): void;
}

function worker_handle(
  endpoint: Endpoint,
  terminate: () => void | Promise<unknown>,
  handlers: WorkerHandlers,
): WorkerHandle {
  const stop_listening = listen_endpoint(endpoint, {
    message: handlers.on_message,
    error: handlers.on_error,
  });
  return {
    post: (message, transfer) => post_endpoint(endpoint, message, transfer),
    terminate: async () => {
      stop_listening();
      await terminate();
    },
  };
}

const web: Platform = {
  async load_wasm(url) {
    return compile_web_wasm(await fetch(url));
  },
  spawn_worker(name, handlers) {
    const worker = new Worker(new URL("./worker.js", import.meta.url), {
      type: "module",
      name,
    });
    return worker_handle(worker, () => worker.terminate(), handlers);
  },
  worker_endpoint() {
    return self;
  },
  quit() {
    self.close();
  },
};

// Hand-written types for the slices of the node builtins we use, so that
// @types/node doesn't leak into a web-first package.
interface NodeWorker extends EmitterEndpoint {
  on: EmitterEndpoint["on"] & ((type: "online", listener: () => void) => void);
  off: EmitterEndpoint["off"] & ((type: "online", listener: () => void) => void);
  terminate(): Promise<number>;
}

interface GetBuiltinModule {
  (id: "node:fs/promises"): {
    readFile(path: URL): Promise<Uint8Array<ArrayBuffer>>;
  };
  (id: "node:worker_threads"): {
    Worker: new (filename: URL, options: { name: string }) => NodeWorker;
    parentPort: Endpoint | null;
  };
}

interface NodeProcess {
  getBuiltinModule?: GetBuiltinModule;
  exit(code: number): never;
}

function node(getBuiltinModule: GetBuiltinModule, process: NodeProcess): Platform {
  const { readFile } = getBuiltinModule("node:fs/promises");
  const { Worker, parentPort } = getBuiltinModule("node:worker_threads");
  return {
    async load_wasm(url) {
      const bytes = await readFile(url);
      return { bytes, module: await WebAssembly.compile(bytes) };
    },
    spawn_worker(name, handlers) {
      const profiling = fork_profile_test && handlers.profileStartup === true;
      const worker = new Worker(
        new URL(profiling ? "./fork-profile-worker.js" : "./worker.js", import.meta.url),
        {
          name,
        },
      );
      if (profiling) {
        const queue = profiled_init_queue(
          (message, transfer) => post_endpoint(worker, message, transfer),
          (queued_ns, post_ns) =>
            handlers.on_message({ type: "fork_profile_init_posted", queued_ns, post_ns }),
          handlers.on_error,
        );
        const online = () => {
          worker.off("online", online);
          handlers.on_message({ type: "fork_profile_online" });
        };
        worker.on("online", online);
        const probe = setTimeout(() => handlers.on_message({ type: "fork_profile_main_turn" }), 0);
        const handle = worker_handle(
          worker,
          () => {
            queue.stop();
            clearTimeout(probe);
            worker.off("online", online);
            return worker.terminate();
          },
          {
            on_error(error) {
              queue.stop();
              clearTimeout(probe);
              handlers.on_error(error);
            },
            on_message(raw) {
              const message = raw as { type?: string; module_ns?: number };
              if (message.type === "fork_profile_module_ready") {
                if (
                  typeof message.module_ns !== "number" ||
                  !Number.isSafeInteger(message.module_ns) ||
                  message.module_ns < 0
                ) {
                  handlers.on_error(Error("invalid profiled module duration"));
                  return;
                }
                handlers.on_message(raw);
                queue.ready();
              } else handlers.on_message(raw);
            },
          },
        );
        return { post: queue.post, terminate: handle.terminate };
      }
      return worker_handle(worker, () => worker.terminate(), handlers);
    },
    worker_endpoint() {
      assert(parentPort, "not in a worker");
      return parentPort;
    },
    quit() {
      process.exit(0);
    },
  };
}

const process = (globalThis as { process?: NodeProcess }).process;
const getBuiltinModule = process?.getBuiltinModule;

export const platform: Platform =
  getBuiltinModule && process ? node(getBuiltinModule, process) : web;
