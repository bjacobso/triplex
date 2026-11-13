/**
 * The reference key store: data keys and blind keys kept wrapped in the
 * database's own SQL storage (SQLite or PostgreSQL), under a root key the host
 * supplies.
 *
 * It provides `KeyProvider` and `KeyCustody` and is never a default; a host
 * opts in by providing it. The root key is never written to the database, so
 * the stored keys are useless to anyone who has the database or a backup but
 * not the root key. Stored beside the database, the root key protects nothing.
 */

import { Clock, Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { KeyProvider, RootKey } from "@triplex-internal/core/sensitive";

type KeyError = KeyProvider.KeyError;
type KeyContext = KeyProvider.KeyContext;

export interface SqlKeyStoreOptions {
  /**
   * The logical database identity, the same `database` given to
   * `Sensitive.layer`. Keys of another database are never returned.
   */
  readonly database: string;
}

interface DataKeyRow {
  readonly key_id: string;
  readonly subject: string;
  readonly key_class: string;
  readonly version: number;
  readonly root_key_id: string | null;
  readonly wrapped_key: string | null;
}

interface BlindKeyRow {
  readonly key_id: string;
  readonly version: number;
  readonly root_key_id: string;
  readonly wrapped_key: string;
}

/** Erasing every key class of a subject. Not a valid key class name. */
const ALL_CLASSES = "*";

const unavailable = (message: string, cause?: unknown) =>
  new KeyProvider.KeyError({
    reason: "unavailable",
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const destroyed = () =>
  new KeyProvider.KeyError({
    reason: "destroyed",
    message: "The data key was destroyed (erased subject)",
  });

const sqlFailure = (cause: unknown) =>
  unavailable("The key store could not be read or written", cause);

const randomId = (prefix: string): string => {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `${prefix}${hex}`;
};

const bufferSource = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
  const copy = new Uint8Array(new ArrayBuffer(bytes.length));
  copy.set(bytes);
  return copy;
};

const importKey = (raw: Uint8Array, usage: "aes" | "hmac"): Effect.Effect<CryptoKey, KeyError> =>
  Effect.tryPromise({
    try: () =>
      usage === "aes"
        ? globalThis.crypto.subtle.importKey("raw", bufferSource(raw), "AES-GCM", false, [
            "encrypt",
            "decrypt",
          ])
        : globalThis.crypto.subtle.importKey(
            "raw",
            bufferSource(raw),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"],
          ),
    catch: (cause) => unavailable("A stored key could not be imported", cause),
  });

/** The authenticated label of a wrapped key: it cannot be moved to another row. */
const labelOf = (database: string, keyId: string) => `${database}\u0000${keyId}`;

const make = (options: SqlKeyStoreOptions) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const root = yield* RootKey.RootKey;
    const database = options.database;
    // Unwrapped keys by key ID. The key bytes never change for a key ID, so a
    // hit is reused; destruction is still checked against the row every time.
    const unwrapped = new Map<string, CryptoKey>();

    const run = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.mapError((cause) =>
          cause instanceof KeyProvider.KeyError ? cause : sqlFailure(cause),
        ),
      );

    const unwrap = (
      keyId: string,
      rootKeyId: string,
      wrapped: string,
      usage: "aes" | "hmac",
    ): Effect.Effect<CryptoKey, KeyError> =>
      Effect.suspend(() => {
        const hit = unwrapped.get(keyId);
        if (hit !== undefined) return Effect.succeed(hit);
        return root.unwrap({ rootKeyId, wrapped }, labelOf(database, keyId)).pipe(
          Effect.flatMap((raw) => importKey(raw, usage)),
          Effect.tap((key) => Effect.sync(() => unwrapped.set(keyId, key))),
        );
      });

    const checkDatabase = (requested: string): Effect.Effect<void, KeyError> =>
      requested === database
        ? Effect.void
        : Effect.fail(unavailable(`This key store holds keys for ${database} only`));

    const isErased = (context: KeyContext) =>
      sql<{ readonly found: number }>`
        SELECT 1 AS found FROM triplex_key_erasures
        WHERE database_id = ${database} AND subject = ${context.subject}
          AND key_class IN (${context.keyClass}, ${ALL_CLASSES})
      `.pipe(Effect.map((rows) => rows.length > 0));

    const latest = (context: KeyContext) =>
      sql<DataKeyRow>`
        SELECT key_id, subject, key_class, version, root_key_id, wrapped_key
        FROM triplex_data_keys
        WHERE database_id = ${database} AND subject = ${context.subject}
          AND key_class = ${context.keyClass}
        ORDER BY version DESC
        LIMIT 1
      `.pipe(Effect.map((rows) => rows[0]));

    /** Insert a new key version; a concurrent insert of the same version wins. */
    const insertDataKey = (context: KeyContext, version: number) =>
      Effect.gen(function* () {
        const keyId = randomId("k1.");
        const raw = globalThis.crypto.getRandomValues(new Uint8Array(32));
        const wrapped = yield* root.wrap(raw, labelOf(database, keyId));
        const now = yield* Clock.currentTimeMillis;
        yield* sql`
          INSERT INTO triplex_data_keys
            (key_id, database_id, subject, key_class, version, root_key_id, wrapped_key, created_at)
          VALUES (${keyId}, ${database}, ${context.subject}, ${context.keyClass}, ${version},
                  ${wrapped.rootKeyId}, ${wrapped.wrapped}, ${now})
          ON CONFLICT DO NOTHING
        `;
      });

    const sealingKey = (context: KeyContext): Effect.Effect<KeyProvider.DataKey, KeyError> =>
      run(
        Effect.gen(function* () {
          yield* checkDatabase(context.database);
          if (yield* isErased(context)) return yield* destroyed();
          let row = yield* latest(context);
          if (row === undefined) {
            yield* insertDataKey(context, 1);
            row = yield* latest(context);
          }
          if (row === undefined) return yield* unavailable("No data key could be created");
          if (row.wrapped_key === null || row.root_key_id === null) return yield* destroyed();
          const key = yield* unwrap(row.key_id, row.root_key_id, row.wrapped_key, "aes");
          return { keyId: row.key_id, key };
        }),
      );

    const openingKey = (context: KeyContext, keyId: string): Effect.Effect<CryptoKey, KeyError> =>
      run(
        Effect.gen(function* () {
          yield* checkDatabase(context.database);
          // The key ID alone decides the key, whatever subject the host maps
          // the value to today.
          const [row] = yield* sql<DataKeyRow>`
            SELECT key_id, subject, key_class, version, root_key_id, wrapped_key
            FROM triplex_data_keys
            WHERE key_id = ${keyId} AND database_id = ${database}
          `;
          if (row === undefined) return yield* unavailable("Unknown data key ID");
          if (row.wrapped_key === null || row.root_key_id === null) {
            unwrapped.delete(keyId);
            return yield* destroyed();
          }
          return yield* unwrap(row.key_id, row.root_key_id, row.wrapped_key, "aes");
        }),
      );

    const currentBlind = sql<BlindKeyRow>`
      SELECT key_id, version, root_key_id, wrapped_key
      FROM triplex_blind_keys
      WHERE database_id = ${database} AND retired_at IS NULL
      ORDER BY version DESC
      LIMIT 1
    `.pipe(Effect.map((rows) => rows[0]));

    const insertBlindKey = (version: number) =>
      Effect.gen(function* () {
        const keyId = randomId("b1.");
        const raw = globalThis.crypto.getRandomValues(new Uint8Array(32));
        const wrapped = yield* root.wrap(raw, labelOf(database, keyId));
        const now = yield* Clock.currentTimeMillis;
        yield* sql`
          INSERT INTO triplex_blind_keys
            (key_id, database_id, version, root_key_id, wrapped_key, created_at)
          VALUES (${keyId}, ${database}, ${version}, ${wrapped.rootKeyId}, ${wrapped.wrapped}, ${now})
          ON CONFLICT DO NOTHING
        `;
      });

    const blindKey = (requested: string): Effect.Effect<KeyProvider.DataKey, KeyError> =>
      run(
        Effect.gen(function* () {
          yield* checkDatabase(requested);
          let row = yield* currentBlind;
          if (row === undefined) {
            yield* insertBlindKey(1);
            row = yield* currentBlind;
          }
          if (row === undefined) return yield* unavailable("No blind key could be created");
          const key = yield* unwrap(row.key_id, row.root_key_id, row.wrapped_key, "hmac");
          return { keyId: row.key_id, key };
        }),
      );

    const destroy = (scope: KeyProvider.KeyScope): Effect.Effect<ReadonlyArray<string>, KeyError> =>
      run(
        Effect.gen(function* () {
          yield* checkDatabase(scope.database);
          const keyClass = scope.keyClass ?? ALL_CLASSES;
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              yield* sql`
                INSERT INTO triplex_key_erasures (database_id, subject, key_class, erased_at)
                VALUES (${database}, ${scope.subject}, ${keyClass}, ${now})
                ON CONFLICT DO NOTHING
              `;
              const rows =
                scope.keyClass === undefined
                  ? yield* sql<{ readonly key_id: string }>`
                      SELECT key_id FROM triplex_data_keys
                      WHERE database_id = ${database} AND subject = ${scope.subject}
                      ORDER BY key_class, version
                    `
                  : yield* sql<{ readonly key_id: string }>`
                      SELECT key_id FROM triplex_data_keys
                      WHERE database_id = ${database} AND subject = ${scope.subject}
                        AND key_class = ${scope.keyClass}
                      ORDER BY version
                    `;
              const keyIds = rows.map((row) => row.key_id);
              if (keyIds.length > 0) {
                yield* sql`
                  UPDATE triplex_data_keys
                  SET wrapped_key = NULL, root_key_id = NULL, destroyed_at = ${now}
                  WHERE database_id = ${database} AND destroyed_at IS NULL
                    AND ${sql.in("key_id", keyIds)}
                `;
              }
              for (const keyId of keyIds) unwrapped.delete(keyId);
              return keyIds;
            }),
          );
        }),
      );

    const rotate = (scope: KeyProvider.RotationScope): Effect.Effect<void, KeyError> =>
      run(
        Effect.gen(function* () {
          yield* checkDatabase(scope.database);
          const rows = yield* sql<{
            readonly subject: string;
            readonly key_class: string;
            readonly version: number;
          }>`
            SELECT subject, key_class, MAX(version) AS version
            FROM triplex_data_keys
            WHERE database_id = ${database}
              ${scope.subject === undefined ? sql`` : sql`AND subject = ${scope.subject}`}
              ${scope.keyClass === undefined ? sql`` : sql`AND key_class = ${scope.keyClass}`}
            GROUP BY subject, key_class
          `;
          for (const row of rows) {
            const context = { database, subject: row.subject, keyClass: row.key_class };
            if (yield* isErased(context)) continue;
            yield* insertDataKey(context, Number(row.version) + 1);
          }
        }),
      );

    return {
      provider: { sealingKey, openingKey, blindKey } satisfies KeyProvider.KeyProviderService,
      custody: { destroy, rotate } satisfies KeyProvider.KeyCustodyService,
    };
  });

/**
 * The SQL key store as `KeyProvider` and `KeyCustody`. Requires the database's
 * `SqlClient` (migrated to the current Triplex schema) and a host-supplied
 * `RootKey`.
 *
 * ```ts
 * const keys = SqlKeyStore.layer({ database: "acme/main" }).pipe(
 *   Layer.provide(RootKey.fromBytes({ current: { id: "root-1", key: rootKeyBytes } })),
 * )
 * ```
 */
export const SqlKeyStore = {
  layer: (
    options: SqlKeyStoreOptions,
  ): Layer.Layer<
    KeyProvider.KeyProvider | KeyProvider.KeyCustody,
    never,
    SqlClient.SqlClient | RootKey.RootKey
  > =>
    Layer.effectContext(
      make(options).pipe(
        Effect.map(({ provider, custody }) =>
          Context.make(KeyProvider.KeyProvider, provider).pipe(
            Context.add(KeyProvider.KeyCustody, custody),
          ),
        ),
      ),
    ),
} as const;
