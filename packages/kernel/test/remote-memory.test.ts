// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import {
  RemoteMemoryRegistry,
  request_remote_memory,
  type RemoteMemoryMessage,
  type RemoteMemoryOperation,
} from "../src/remote-memory.ts";

for (const mode of ["normal", "yield-error", "post-error"])
  test(`claimed RPC retains storage past its deadline: ${mode}`, { timeout: 15000 }, async (t) => {
    const kernel = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const publishers: Worker[] = [];
    const client = new Worker(
      `
      const {parentPort,workerData}=require('node:worker_threads');
      (async()=>{
        const {request_remote_memory}=await import(workerData.module);
        const reason=new Error('original observer failure');
        const send=message=>{
          Atomics.compareExchange(new Int32Array(message.reply),0,0,1);
          parentPort.postMessage(message);
          if(workerData.mode==='post-error')throw reason;
        };
        let result=null,error=null;
        try{result=request_remote_memory(send,{kind:'read',id:1,user:128,kernel:32,length:1},
          {deadlineMs:0,now:()=>0,...(workerData.mode==='yield-error'?{yieldKernel(){throw reason;}}:{})});}
        catch(e){error=e===reason?'original observer failure':'wrong error';}
        parentPort.postMessage({type:'finished',result,error,observed:new Uint8Array(workerData.kernel.buffer)[32]});
        parentPort.close();
      })().catch(error=>{throw error;});
    `,
      {
        eval: true,
        workerData: {
          kernel,
          mode,
          module: new URL("../src/remote-memory.ts", import.meta.url).href,
        },
      },
    );
    t.after(async () => {
      await client.terminate();
      await Promise.all(publishers.map((w) => w.terminate()));
    });
    const finished = await new Promise<unknown>((resolve, reject) => {
      client.on("error", reject);
      client.on("message", (message) => {
        if (message.type !== "remote_memory") {
          resolve(message);
          return;
        }
        const publisher = new Worker(
          `
          const {workerData}=require('node:worker_threads');
          setTimeout(()=>{
            new Uint8Array(workerData.kernel.buffer)[32]=73;
            const reply=new Int32Array(workerData.reply);
            Atomics.store(reply,1,1);Atomics.store(reply,0,2);Atomics.notify(reply,0);
          },20);
        `,
          { eval: true, workerData: { kernel, reply: message.reply } },
        );
        publishers.push(publisher);
        publisher.on("error", reject);
      });
    });
    assert.deepEqual(finished, {
      type: "finished",
      result: mode === "normal" ? 1 : null,
      error: mode === "normal" ? null : "original observer failure",
      observed: 73,
    });
  });

function fixture() {
  const kernel = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
  const user = new WebAssembly.Memory({ initial: 1, maximum: 4, shared: true });
  const registry = new RemoteMemoryRegistry(kernel);
  const call = (operation: RemoteMemoryOperation) => {
    const reply = new SharedArrayBuffer(8);
    registry.handle({ type: "remote_memory", operation, reply });
    assert.equal(Atomics.load(new Int32Array(reply), 0), 2);
    return Atomics.load(new Int32Array(reply), 1);
  };
  return { kernel, user, registry, call };
}

test("remote registry retains an image, copies valid prefixes and drains release", () => {
  const { kernel, user, registry, call } = fixture();
  assert.equal(call({ kind: "register", id: 1, memory: user }), 1);
  new Uint8Array(user.buffer).set([17, 23], 65534);
  assert.equal(call({ kind: "read", id: 1, user: 65534, kernel: 128, length: 4 }), 2);
  assert.deepEqual([...new Uint8Array(kernel.buffer, 128, 4)], [17, 23, 0, 0]);
  new Uint8Array(kernel.buffer).set([29, 31, 37, 41], 256);
  assert.equal(call({ kind: "write", id: 1, user: 65534, kernel: 256, length: 4 }), 2);
  assert.deepEqual([...new Uint8Array(user.buffer, 65534, 2)], [29, 31]);
  assert.equal(call({ kind: "read", id: 1, user: 0, kernel: 128, length: 4 }), 0);
  assert.equal(call({ kind: "read", id: 1, user: 128, kernel: 65535, length: 4 }), 0);
  assert.equal(call({ kind: "read", id: 1, user: 128, kernel: 128, length: 65537 }), -22);
  const other = new WebAssembly.Memory({ initial: 1, maximum: 4, shared: true });
  assert.equal(call({ kind: "register", id: 1, memory: other }), 1);
  assert.equal(call({ kind: "read", id: 1, user: 65534, kernel: 128, length: 2 }), 2);
  assert.deepEqual(
    [...new Uint8Array(kernel.buffer, 128, 2)],
    [29, 31],
    "duplicates never rebind an mm",
  );
  assert.equal(call({ kind: "release", id: 1 }), 0);
  assert.equal(call({ kind: "read", id: 1, user: 65534, kernel: 128, length: 2 }), -3);
  registry.close();
  assert.equal(call({ kind: "register", id: 2, memory: user }), -3);
});

test("queued cancellation prevents late access and does not register an image", () => {
  const { user, registry, call } = fixture();
  let queued: RemoteMemoryMessage | undefined;
  assert.equal(
    request_remote_memory(
      (message) => {
        queued = message;
      },
      { kind: "register", id: 1, memory: user },
      { deadlineMs: 0, now: () => 0 },
    ),
    -11,
  );
  assert(queued);
  registry.handle(queued);
  assert.equal(call({ kind: "read", id: 1, user: 128, kernel: 128, length: 1 }), -3);
  assert.equal(
    request_remote_memory(
      () => {
        throw new Error("closed transport");
      },
      { kind: "release", id: 1 },
    ),
    -5,
  );
});

test("invalid registration and reply fail before retaining a memory", () => {
  const { registry, call } = fixture();
  assert.equal(
    call({ kind: "register", id: 0, memory: new WebAssembly.Memory({ initial: 1 }) }),
    -22,
  );
  assert.equal(
    call({ kind: "register", id: 1, memory: new WebAssembly.Memory({ initial: 1 }) }),
    -95,
  );
  assert.throws(
    () =>
      registry.handle({
        type: "remote_memory",
        operation: { kind: "release", id: 1 },
        reply: new SharedArrayBuffer(4),
      }),
    /reply/,
  );
});

test(
  "real Worker RPC reads and writes a grown memory while its owner runs Wasm",
  { timeout: 15000 },
  async (t) => {
    const { kernel, user, registry, call } = fixture();
    assert.equal(call({ kind: "register", id: 1, memory: user }), 1);
    // One atomic load loop in a real shared-memory Wasm instance. Its owner
    // cannot process JS messages or execute an owner-side kernel checkpoint.
    const owner = new Worker(
      `
    const {parentPort,workerData}=require('node:worker_threads');
    const memory=workerData;
    memory.grow(1);
    new Uint8Array(memory.buffer)[65543]=27;
    const name=s=>[s.length,...Buffer.from(s)];
    const imports=[1,...name('env'),...name('memory'),2,3,1,4];
    const body=[0,3,64,65,0,254,16,2,0,69,13,0,11,11];
    const bytes=[0,97,115,109,1,0,0,0,1,4,1,96,0,0,2,imports.length,...imports,
      3,2,1,0,7,7,1,3,114,117,110,0,0,10,body.length+2,1,body.length,...body];
    const instance=new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(bytes)),{env:{memory}});
    parentPort.postMessage('running');
    instance.exports.run();
    parentPort.postMessage(new Uint8Array(memory.buffer)[65543]);
    parentPort.close();
  `,
      { eval: true, workerData: user },
    );
    t.after(async () => {
      await owner.terminate();
      registry.close();
    });
    assert.deepEqual(await once(owner, "message"), ["running"]);
    const client = new Worker(
      `
    const {parentPort,workerData}=require('node:worker_threads');
    (async()=>{
      const {request_remote_memory}=await import(workerData.module);
      const send=message=>parentPort.postMessage(message);
      const read=request_remote_memory(send,{kind:'read',id:1,user:65543,kernel:128,length:1});
      const value=new Uint8Array(workerData.kernel.buffer)[128];
      new Uint8Array(workerData.kernel.buffer)[129]=43;
      const write=request_remote_memory(send,{kind:'write',id:1,user:65543,kernel:129,length:1});
      parentPort.postMessage({type:'done',read,write,value});
      parentPort.close();
    })().catch(error=>{throw error;});
  `,
      {
        eval: true,
        workerData: { kernel, module: new URL("../src/remote-memory.ts", import.meta.url).href },
      },
    );
    t.after(async () => {
      await client.terminate();
    });
    const finished = new Promise<unknown>((resolve, reject) => {
      client.on("error", reject);
      client.on("message", (message) => {
        if (message.type === "remote_memory") registry.handle(message);
        else resolve(message);
      });
    });
    assert.deepEqual(await finished, { type: "done", read: 1, write: 1, value: 27 });
    const stopped = once(owner, "message");
    Atomics.store(new Int32Array(user.buffer), 0, 1);
    assert.deepEqual(await stopped, [43]);
  },
);
