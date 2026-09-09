import { fork } from "node:child_process";
import { Effect } from "effect";
import { federationFailure, type FactRow, type LocalDatabase, type ScanRequest } from "./types.js";
import type { SourceWorker } from "./source.js";
import type { WorkerRequest, WorkerResponse } from "./worker-process.js";

export const makeProcessSource = (database: LocalDatabase, batchSize: number, timeoutMs: number) =>
  Effect.gen(function* () {
    const client = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          const child = fork(new URL("./worker-process.js", import.meta.url), [], {
            execArgv: [],
            serialization: "advanced",
            stdio: ["ignore", "ignore", "pipe", "ipc"],
          });
          let stderr = "";
          child.stderr?.on("data", (data) => {
            stderr = (stderr + String(data)).slice(-8192);
          });
          let sequence = 0;
          let failure: Error | undefined;
          const pending = new Map<
            number,
            { resolve: (value: unknown) => void; reject: (error: Error) => void }
          >();
          const fail = (error: Error) => {
            failure ??= error;
            for (const request of pending.values()) request.reject(failure);
            pending.clear();
          };
          child.on("error", fail);
          child.on("exit", (code, signal) =>
            fail(new Error(`Worker ${database.id} exited (${code ?? signal}): ${stderr}`)),
          );
          child.on("message", (message: WorkerResponse) => {
            const request = pending.get(message.id);
            if (!request) return;
            pending.delete(message.id);
            if (message.ok) request.resolve(message.value);
            else request.reject(new Error(message.error));
          });
          type Command = WorkerRequest extends infer R
            ? R extends WorkerRequest
              ? Omit<R, "id">
              : never
            : never;
          const request = <A>(command: Command) =>
            Effect.tryPromise({
              try: (signal) =>
                new Promise<A>((resolve, reject) => {
                  if (failure) {
                    reject(failure);
                    return;
                  }
                  const id = ++sequence;
                  const abort = () => {
                    fail(new Error(`Worker ${database.id} request aborted`));
                    child.kill();
                  };
                  const timer = setTimeout(() => {
                    fail(new Error(`Worker ${database.id} timed out after ${timeoutMs}ms`));
                    child.kill();
                  }, timeoutMs);
                  const cleanup = () => {
                    clearTimeout(timer);
                    signal.removeEventListener("abort", abort);
                    pending.delete(id);
                  };
                  pending.set(id, {
                    resolve: (value) => {
                      cleanup();
                      resolve(value as A);
                    },
                    reject: (error) => {
                      cleanup();
                      reject(error);
                    },
                  });
                  signal.addEventListener("abort", abort, { once: true });
                  child.send({ ...command, id }, (error) => {
                    if (error) fail(error);
                  });
                }),
              catch: federationFailure,
            });
          return { child, request };
        },
        catch: federationFailure,
      }),
      ({ child }) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
                resolve();
                return;
              }
              const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
              child.once("exit", () => {
                clearTimeout(timer);
                resolve();
              });
              if (child.connected) child.disconnect();
              else child.kill();
            }),
        ),
    );
    const opened = yield* client.request<Pick<SourceWorker, "metadata" | "pid">>({
      command: "open",
      database,
      batchSize,
    });
    return {
      ...opened,
      scan: (request: ScanRequest) =>
        client.request<readonly FactRow[]>({ command: "scan", request }),
    } satisfies SourceWorker;
  });
