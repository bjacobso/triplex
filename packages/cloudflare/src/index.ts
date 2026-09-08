/**
 * Cloudflare-specific database package.
 *
 * Provides Durable Object storage adapter and database manager wiring for
 * Cloudflare Workers deployments.
 */

// Storage adapter
export {
  makeCloudflareAdapter,
  makeCloudflareAdapterLayer,
  type DOState,
  type SqlStorage,
  type SqlStorageCursor,
  type SqlStorageValue,
} from "./storage/index.js";

export {
  CloudflareTriples,
  type CloudflareTriplesLayer,
  type CloudflareTriplesOptions,
} from "./CloudflareTriples.js";

export {
  StorageAdapter,
  type StorageAdapterService,
  packValue,
  WriteError,
  ReadError,
  MigrationError,
  TRIPLES_TABLE_DDL,
  MIGRATIONS_TABLE_DDL,
  INDEX_DDLS,
  INDEX_NAMES,
  migrations,
  type Migration,
} from "./adapter-support.js";

// Database manager
export {
  DOContextService,
  CloudflareDatabaseManagerLive,
  type DOContext,
} from "./services/index.js";
