/**
 * Child process for `journal-atomicity.test.ts`: commits transactions to a
 * SQLite file and is killed with SIGKILL in the middle of one.
 *
 *   node --import tsx journal-crash-child.ts <file> before-journal|after-journal|loop
 *
 * - `before-journal`: commits three transactions, then kills itself inside the
 *   fourth after its facts are written and before its journal row is.
 * - `after-journal`: the same, but after the journal and entity rows are written
 *   and before COMMIT.
 * - `loop`: commits transactions until the parent kills it, printing each
 *   committed position.
 */
import { Effect, Layer } from "effect";
import { EntityId, Triples, number, string } from "@triplex-internal/core";
import {
  CurrentDialect,
  makeTripleStoreRuntimeLayer,
  StorageAdapter,
  TriplesLive,
} from "@triplex-internal/core/internal";
import { SqlQueryExecutorLive } from "@triplex-build/triplex-sql";
import { SqliteAdapterLive } from "../../src/SqliteAdapter.js";
import { SqliteDialect } from "../../src/dialect.js";
import { makeSqliteLayer } from "../../src/SqliteLayer.js";

const [filename, mode] = process.argv.slice(2) as [string, string];
let armed = false;
const die = Effect.sync(() => process.kill(process.pid, "SIGKILL")).pipe(
  Effect.andThen(Effect.never),
);

const adapter = Layer.effect(
  StorageAdapter,
  Effect.gen(function* () {
    const inner = yield* StorageAdapter;
    return {
      ...inner,
      appendTransaction: (entry: Parameters<typeof inner.appendTransaction>[0]) =>
        armed && mode === "before-journal"
          ? die
          : inner
              .appendTransaction(entry)
              .pipe(Effect.tap(() => (armed && mode === "after-journal" ? die : Effect.void))),
    };
  }),
).pipe(Layer.provide(SqliteAdapterLive));

const layer = TriplesLive.pipe(
  Layer.provide(SqlQueryExecutorLive),
  Layer.provide(adapter),
  Layer.provide(Layer.succeed(CurrentDialect, SqliteDialect)),
  Layer.provide(makeSqliteLayer(filename)),
  Layer.provide(makeTripleStoreRuntimeLayer(`sqlite:${filename}`)),
);

const commit = (index: number, entities: number) =>
  Effect.flatMap(Triples, (triples) =>
    triples.transact(
      Array.from({ length: entities }, (_, e) => [
        {
          op: "assert" as const,
          entityId: EntityId.make(`crash:${process.pid}:${index}:${e}`),
          attribute: ":crash/name",
          value: string(`name ${index} ${e}`),
        },
        {
          op: "assert" as const,
          entityId: EntityId.make(`crash:${process.pid}:${index}:${e}`),
          attribute: ":crash/rank",
          value: number(e),
        },
      ]).flat(),
      { actor: "crash-child", commandId: `crash-${process.pid}-${index}` },
    ),
  );

const program = Effect.gen(function* () {
  if (mode === "loop") {
    for (let index = 0; ; index++) {
      const result = yield* commit(index, 10);
      process.stdout.write(`${result.position}\n`);
    }
  }
  for (let index = 0; index < 3; index++) yield* commit(index, 5);
  process.stdout.write("committed 3\n");
  armed = true;
  yield* commit(3, 50);
  process.stdout.write("unreachable\n");
});

Effect.runPromise(program.pipe(Effect.provide(layer))).catch((error) => {
  console.error(error);
  process.exit(2);
});
