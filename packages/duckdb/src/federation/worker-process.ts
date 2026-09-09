import { Effect } from "effect";
import { makeSource } from "./source.js";
import type { LocalDatabase, ScanRequest } from "./types.js";

export type WorkerRequest =
  | {
      readonly id: number;
      readonly command: "open";
      readonly database: LocalDatabase;
      readonly batchSize: number;
    }
  | { readonly id: number; readonly command: "scan"; readonly request: ScanRequest };
export type WorkerResponse =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: string };

// This file is an executable package artifact, launched only through fork().
const queue: WorkerRequest[] = [];
let wake: ((message: WorkerRequest | null) => void) | undefined;
let disconnected = false;
process.on("message", (message: WorkerRequest) => {
  if (wake) {
    const resolve = wake;
    wake = undefined;
    resolve(message);
  } else queue.push(message);
});
process.on("disconnect", () => {
  disconnected = true;
  wake?.(null);
  wake = undefined;
});
const next = () =>
  Effect.promise(() => {
    const message = queue.shift();
    return message
      ? Promise.resolve(message)
      : disconnected
        ? Promise.resolve(null)
        : new Promise<WorkerRequest | null>((resolve) => {
            wake = resolve;
          });
  });
const send = (response: WorkerResponse) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve, reject) => {
        if (!process.connected || !process.send) {
          resolve();
          return;
        }
        process.send(response, (error) => (error ? reject(error) : resolve()));
      }),
  );

const main = Effect.scoped(
  Effect.gen(function* () {
    const open = yield* next();
    if (!open || open.command !== "open") return;
    const source = yield* makeSource(open.database, open.batchSize).pipe(
      Effect.catch((error) =>
        send({ id: open.id, ok: false, error: String(error) }).pipe(
          Effect.andThen(Effect.fail(error)),
        ),
      ),
    );
    yield* send({ id: open.id, ok: true, value: { metadata: source.metadata, pid: source.pid } });
    while (true) {
      const message = yield* next();
      if (message === null) break;
      if (message.command !== "scan") {
        yield* send({ id: message.id, ok: false, error: "Worker is already open" });
        continue;
      }
      const response = yield* source.scan(message.request).pipe(
        Effect.map((value): WorkerResponse => ({ id: message.id, ok: true, value })),
        Effect.catch((error) =>
          Effect.succeed<WorkerResponse>({ id: message.id, ok: false, error: String(error) }),
        ),
      );
      yield* send(response);
    }
  }),
);
Effect.runPromise(main).then(
  () => {
    if (process.connected) process.disconnect?.();
  },
  () => {
    process.exitCode = 1;
    if (process.connected) process.disconnect?.();
  },
);
