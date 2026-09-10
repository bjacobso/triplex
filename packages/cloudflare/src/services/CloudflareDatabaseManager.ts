/**
 * CloudflareDatabaseManager - DatabaseManager shim for Durable Object context
 *
 * In Cloudflare Workers, database isolation is handled by the Worker routing
 * requests to the correct Durable Object based on the URL path. Within a DO,
 * we don't need to manage multiple databases - we just return the DO's own
 * Triples service.
 *
 * This shim implements the DatabaseManagerService interface so that existing
 * Consumers can provide this manager to their own API handlers in the Durable Object context.
 */

import { Context, Effect, Layer } from "effect";
import {
  DatabaseManager,
  type DatabaseManagerService,
  type Database,
  type ClearResult,
  type TriplesService,
  InternalError,
} from "@triplex-build/triplex/internal";

// Re-export for convenience of internal callers
export { DatabaseManager };
export type { DatabaseManagerService, Database };

// =============================================================================
// DO Context
// =============================================================================

/**
 * Context provided by the Durable Object containing its services
 */
export interface DOContext {
  readonly triples: TriplesService;
  readonly databaseName: string;
  /**
   * Clear all storage and reinitialize services.
   * Used by the clear operation to wipe the database.
   */
  readonly clearAndReinit: () => Effect.Effect<void, InternalError>;
}

/**
 * DOContext service tag for dependency injection
 */
export class DOContextService extends Context.Service<DOContextService, DOContext>()(
  "DOContextService",
) {}

// =============================================================================
// Cloudflare DatabaseManager Implementation
// =============================================================================

/**
 * CloudflareDatabaseManagerLive - Layer that provides DatabaseManager for DO context
 *
 * This shim ignores the database name parameter because routing to the correct
 * Durable Object has already occurred at the Worker level. All operations
 * return this DO's services.
 */
export const CloudflareDatabaseManagerLive: Layer.Layer<DatabaseManager, never, DOContextService> =
  Layer.effect(
    DatabaseManager,
    Effect.gen(function* () {
      const ctx = yield* DOContextService;

      const service: DatabaseManagerService = {
        // Always return this DO's Triples service (database name is ignored)
        getTriples: (_name: string) => Effect.succeed(ctx.triples),
        getSnapshotService: (_name: string) => Effect.succeed(null),

        // Return metadata for this DO's database
        get: (_name: string) =>
          Effect.succeed({
            name: ctx.databaseName,
            description: null,
            createdAt: Date.now(),
          } as Database),

        // List returns only this DO's database
        list: () =>
          Effect.succeed([
            {
              name: ctx.databaseName,
              description: null,
              createdAt: Date.now(),
            },
          ] as readonly Database[]),

        // Update metadata - not supported in DO context
        update: (_name, _fields) =>
          Effect.fail(
            new InternalError({
              message: "Database update not supported in Durable Object context.",
            }),
          ),

        // Database lifecycle not supported within DO
        // These operations should be handled at Worker level
        create: (_name, _description) =>
          Effect.fail(
            new InternalError({
              message:
                "Database creation not supported in Durable Object context. Use Worker routing.",
            }),
          ),

        delete: (_name) =>
          Effect.fail(
            new InternalError({
              message: "Database deletion not supported in Durable Object context.",
            }),
          ),

        deleteAll: () =>
          Effect.fail(
            new InternalError({
              message: "Database deletion not supported in Durable Object context.",
            }),
          ),

        // Clear the database by wiping storage and reinitializing
        clear: (_name: string) =>
          Effect.gen(function* () {
            yield* ctx.clearAndReinit();
            return {
              success: true,
              database: ctx.databaseName,
            } as ClearResult;
          }),
      };

      return service;
    }),
  );
