/**
 * DatabaseManager layer implementation
 *
 * Manages database lifecycle with each database backed by a storage backend.
 * Delegates metadata operations to DatabaseRegistry.
 * Handles connection pooling and Triples service management.
 */

import { Effect, Layer, HashMap, Ref, pipe, Scope, Exit, Context, Fiber } from "effect";
import {
  DatabaseManager,
  type DatabaseManagerService,
  type Database,
  type ClearResult,
  Triples,
  type TriplesService,
  TriplesLive,
  DatabaseNotFound,
  InternalError,
  CurrentDialect,
  DatabaseRegistry,
  ChangeEmitter,
  type ChangeEmitterService,
  composeStore,
  type StoreCapability,
  makeChangeEmissionCapability,
  TripleStoreRuntime,
  SnapshotWriter,
  SnapshotService,
  SnapshotWriterLive,
  SnapshotServiceLive,
  makeEntitySnapshotsCapability,
  DatabaseAlreadyExists,
  getTripleStoreRuntime,
  DatabaseId,
} from "@triplex-build/triplex/internal";
import type { DatabaseId as DatabaseIdType } from "@triplex-build/triplex";
import { SqlQueryExecutorLive } from "./SqlQueryExecutor.js";
import { StorageBackend } from "./StorageBackend.js";

// =============================================================================
// Connection Pool Configuration
// =============================================================================

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // Check every minute

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Map any error to InternalError
 */
const describeError = (error: unknown): string => {
  if (typeof error !== "object" || error === null || !("cause" in error)) return String(error);
  return `${String(error)}: ${describeError(error.cause)}`;
};

const mapToInternalError = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, InternalError, R> =>
  pipe(
    effect,
    Effect.mapError((e) => new InternalError({ message: describeError(e) })),
  );

const validateDatabaseId = (name: string): Effect.Effect<DatabaseIdType, InternalError> =>
  Effect.try({
    try: () => DatabaseId.make(name),
    catch: () => new InternalError({ message: `Invalid Triplex database identifier: ${name}` }),
  });

// =============================================================================
// Cached Services
// =============================================================================

interface CachedServices {
  triples: TriplesService;
  snapshotService: import("@triplex-build/triplex").SnapshotServiceShape;
  scope: Scope.Closeable;
  lastAccessedAt: number;
}

// =============================================================================
// Layer Implementation
// =============================================================================

/**
 * DatabaseManagerLive layer
 *
 * Provides the DatabaseManager service.
 * Requires StorageBackend for database operations and DatabaseRegistry for metadata.
 * Optionally accepts ChangeEmitter -- if not provided, uses NoopChangeEmitter.
 *
 * Each database composes snapshot materialization and change emission over the
 * raw Triples service.
 */
export const DatabaseManagerLive = Layer.effect(
  DatabaseManager,
  Effect.gen(function* () {
    const backend = yield* StorageBackend;
    const registry = yield* DatabaseRegistry;

    // Resolve optional services
    const emitter = yield* Effect.serviceOption(ChangeEmitter).pipe(
      Effect.map((opt) =>
        opt._tag === "Some" ? opt.value : ({ emit: () => Effect.void } as ChangeEmitterService),
      ),
    );
    const runtime = yield* getTripleStoreRuntime;
    const runtimeNow = runtime.now;

    // Cache for database services
    const cacheRef = yield* Ref.make(HashMap.empty<string, CachedServices>());

    // Background fiber to close idle connections
    const cleanupFiber = yield* Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(CLEANUP_INTERVAL_MS);

        const cache = yield* Ref.get(cacheRef);
        const now = yield* runtimeNow;

        for (const [dbName, services] of HashMap.toEntries(cache)) {
          const idleTime = now - services.lastAccessedAt;
          if (idleTime > IDLE_TIMEOUT_MS) {
            yield* Scope.close(services.scope, Exit.void).pipe(Effect.catch(() => Effect.void));
            yield* Ref.update(cacheRef, HashMap.remove(dbName));
            yield* Effect.logInfo(
              `Closed idle database connection: ${dbName} (idle for ${Math.round(
                idleTime / 1000,
              )}s)`,
            );
          }
        }
      }
    }).pipe(Effect.forkChild);

    /**
     * Build the fully-composed layer for a database.
     *
     * Produces: Triples + SnapshotWriter + SnapshotService
     */
    const buildDatabaseLayer = (database: DatabaseIdType) => {
      const runtimeLayer = Layer.succeed(TripleStoreRuntime, {
        ...runtime,
        scope: `database:${database}`,
      });
      const adapterLayer = backend.createAdapterLayer(database);
      const sqlLayer = backend.createDatabaseClient(database);
      const dialectLayer = Layer.succeed(CurrentDialect, backend.dialect);

      const executorLayer = SqlQueryExecutorLive.pipe(
        Layer.provide(sqlLayer),
        Layer.provide(dialectLayer),
      );

      const triplesLayer = TriplesLive.pipe(
        Layer.provide(adapterLayer),
        Layer.provide(executorLayer),
        Layer.provide(dialectLayer),
        Layer.provide(runtimeLayer),
      );

      const writerLayer = SnapshotWriterLive.pipe(
        Layer.provide(triplesLayer),
        Layer.provide(adapterLayer),
      );

      const readerLayer = SnapshotServiceLive.pipe(Layer.provide(adapterLayer));

      return Layer.mergeAll(triplesLayer, writerLayer, readerLayer);
    };

    /**
     * Create services for a database by building and running the layer, then
     * compose its built-in capabilities.
     */
    const createDatabaseServices = (name: string): Effect.Effect<CachedServices, InternalError> =>
      Effect.gen(function* () {
        const databaseId = yield* validateDatabaseId(name);
        const layer = buildDatabaseLayer(databaseId);
        const fullyProvidedLayer = layer as Layer.Layer<Triples | SnapshotWriter | SnapshotService>;

        const databaseScope = yield* Scope.make();
        const context = yield* Layer.buildWithScope(fullyProvidedLayer, databaseScope).pipe(
          mapToInternalError,
        );

        const rawTriples = Context.get(context, Triples);
        const writer = Context.get(context, SnapshotWriter);
        const reader = Context.get(context, SnapshotService);

        // Built-in capabilities
        const capabilities: StoreCapability[] = [
          makeChangeEmissionCapability(emitter, runtimeNow),
          makeEntitySnapshotsCapability(writer),
        ];

        const triples = composeStore(rawTriples, ...capabilities);

        return {
          triples,
          snapshotService: reader,
          scope: databaseScope,
          lastAccessedAt: yield* runtimeNow,
        };
      });

    /**
     * Get or create cached services for a database
     */
    const getOrCreateServices = (
      name: string,
    ): Effect.Effect<CachedServices, DatabaseNotFound | InternalError> =>
      Effect.gen(function* () {
        const cache = yield* Ref.get(cacheRef);
        const cached = HashMap.get(cache, name);

        if (cached._tag === "Some") {
          // Update last accessed time
          const updatedServices = {
            ...cached.value,
            lastAccessedAt: yield* runtimeNow,
          };
          yield* Ref.update(cacheRef, HashMap.set(name, updatedServices));
          yield* Effect.logDebug(`Database connection reused from cache: ${name}`);
          return updatedServices;
        }

        // Check if database exists in registry
        yield* registry.get(name);

        // Create services for this database
        const services = yield* createDatabaseServices(name);
        yield* Effect.logInfo(`Database connection created: ${name}`);

        // Cache the services
        yield* Ref.update(cacheRef, HashMap.set(name, services));

        return services;
      });

    /**
     * Get triple count for a database using cached services
     */
    const getTripleCount = (name: string): Effect.Effect<number, InternalError> =>
      Effect.gen(function* () {
        // Try to get from cache first
        const cache = yield* Ref.get(cacheRef);
        const cached = HashMap.get(cache, name);

        if (cached._tag === "Some") {
          // Use the cached store to get count - query all triples with empty pattern
          const triples = yield* cached.value.triples
            .match({})
            .pipe(Effect.catch(() => Effect.succeed([] as readonly unknown[])));
          return triples.length;
        }

        // Database not in cache, try to create services temporarily
        const services = yield* createDatabaseServices(name).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );

        if (services === null) {
          return 0;
        }

        // Get count and close scope
        const triples = yield* services.triples
          .match({})
          .pipe(Effect.catch(() => Effect.succeed([] as readonly unknown[])));
        const count = triples.length;

        // Close the temporary scope
        yield* Scope.close(services.scope, Exit.void).pipe(Effect.catch(() => Effect.void));

        return count;
      });

    /**
     * Close all cached database connections
     */
    const closeAllConnections = (): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        const cache = yield* Ref.get(cacheRef);
        const count = HashMap.size(cache);
        for (const [, services] of HashMap.toEntries(cache)) {
          yield* Scope.close(services.scope, Exit.void).pipe(Effect.catch(() => Effect.void));
        }
        yield* Ref.set(cacheRef, HashMap.empty<string, CachedServices>());
        if (count > 0) {
          yield* Effect.logInfo(`All database connections closed (count: ${count})`);
        }
      });

    // =========================================================================
    // Service Implementation
    // =========================================================================

    const create = (
      name: string,
      description?: string,
    ): Effect.Effect<Database, DatabaseAlreadyExists | InternalError> =>
      Effect.gen(function* () {
        yield* validateDatabaseId(name);
        // Register in the registry (this checks for duplicates)
        const database = yield* registry.register(name, description);

        // Pre-initialize the database to create the database file
        const services = yield* createDatabaseServices(name);
        yield* Ref.update(cacheRef, HashMap.set(name, services));
        yield* Effect.logInfo(`Database created: ${name}`);

        return {
          ...database,
          tripleCount: 0,
        };
      });

    const update = (
      name: string,
      fields: { description?: string },
    ): Effect.Effect<Database, DatabaseNotFound | InternalError> =>
      Effect.gen(function* () {
        const database = yield* registry.update(name, fields);

        // Enrich with triple count and size
        const tripleCount = yield* getTripleCount(name);
        const databaseId = yield* validateDatabaseId(name);
        const sizeBytes = yield* backend
          .getDatabaseSize(databaseId)
          .pipe(Effect.catch(() => Effect.succeed(undefined)));

        return {
          ...database,
          tripleCount,
          ...(sizeBytes !== undefined && { sizeBytes }),
        };
      });

    const delete_ = (name: string): Effect.Effect<void, DatabaseNotFound | InternalError> =>
      Effect.gen(function* () {
        // Check if exists (will throw DatabaseNotFound if not)
        yield* registry.get(name);

        // Get and close cached services if exists
        const cache = yield* Ref.get(cacheRef);
        const cached = HashMap.get(cache, name);
        if (cached._tag === "Some") {
          yield* Scope.close(cached.value.scope, Exit.void).pipe(Effect.catch(() => Effect.void));
          yield* Effect.logInfo(`Database connection closed: ${name}`);
        }

        // Remove from cache
        yield* Ref.update(cacheRef, HashMap.remove(name));

        // Unregister from registry
        yield* registry.unregister(name);

        // Delete database storage using the backend
        const databaseId = yield* validateDatabaseId(name);
        yield* backend.deleteDatabaseStorage(databaseId).pipe(Effect.catch(() => Effect.void));

        yield* Effect.logInfo(`Database deleted: ${name}`);
      });

    const deleteAll = (): Effect.Effect<void, InternalError> =>
      Effect.gen(function* () {
        // Close all cached connections first
        yield* closeAllConnections();

        // Clear the registry
        yield* registry.clear();

        // Delete all storage (including registry)
        yield* backend.deleteAllStorage().pipe(mapToInternalError);
      });

    const list = (): Effect.Effect<readonly Database[], InternalError> =>
      Effect.gen(function* () {
        // Get base metadata from registry
        const databases = yield* registry.list();

        // Enrich with triple count and size
        const enrichedDatabases: Database[] = [];
        for (const db of databases) {
          const tripleCount = yield* getTripleCount(db.name);
          const databaseId = yield* validateDatabaseId(db.name);
          const sizeBytes = yield* backend
            .getDatabaseSize(databaseId)
            .pipe(Effect.catch(() => Effect.succeed(undefined)));
          enrichedDatabases.push({
            ...db,
            tripleCount,
            ...(sizeBytes !== undefined && { sizeBytes }),
          });
        }

        return enrichedDatabases;
      });

    const get = (name: string): Effect.Effect<Database, DatabaseNotFound | InternalError> =>
      Effect.gen(function* () {
        // Get base metadata from registry
        const database = yield* registry.get(name);

        // Enrich with triple count and size
        const tripleCount = yield* getTripleCount(name);
        const databaseId = yield* validateDatabaseId(name);
        const sizeBytes = yield* backend
          .getDatabaseSize(databaseId)
          .pipe(Effect.catch(() => Effect.succeed(undefined)));

        return {
          ...database,
          tripleCount,
          ...(sizeBytes !== undefined && { sizeBytes }),
        };
      });

    const getTriples = (
      name: string,
    ): Effect.Effect<TriplesService, DatabaseNotFound | InternalError> =>
      Effect.gen(function* () {
        const cached = yield* getOrCreateServices(name);
        return cached.triples;
      });

    const getSnapshotService = (
      name: string,
    ): Effect.Effect<
      import("@triplex-build/triplex").SnapshotServiceShape | null,
      DatabaseNotFound | InternalError
    > =>
      Effect.gen(function* () {
        const cached = yield* getOrCreateServices(name);
        return cached.snapshotService ?? null;
      });

    const clear = (name: string): Effect.Effect<ClearResult, DatabaseNotFound | InternalError> =>
      Effect.gen(function* () {
        // Get database info to preserve description
        const databaseInfo = yield* get(name);
        const description = databaseInfo.description ?? undefined;

        // Hard reset: delete database and recreate it
        yield* delete_(name).pipe(Effect.catchTag("DatabaseNotFound", () => Effect.void));
        yield* create(name, description).pipe(
          Effect.catchTag("DatabaseAlreadyExists", () => Effect.void),
        );

        return {
          success: true,
          database: name,
        };
      });

    // Clean up when the manager is closed
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        // Stop the cleanup fiber
        yield* Fiber.interrupt(cleanupFiber);
        yield* Effect.logInfo("Database manager finalized");
      }),
    );

    return {
      create,
      update,
      delete: delete_,
      deleteAll,
      list,
      get,
      getTriples,
      getSnapshotService,
      clear,
    } satisfies DatabaseManagerService;
  }),
);
