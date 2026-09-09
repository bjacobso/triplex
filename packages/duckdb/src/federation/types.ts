import { Context, Effect, Layer } from "effect";
import { ReadError, type DatalogQuery, type TemporalBasis } from "@bjacobso/triplex";

export interface LocalDatabase {
  readonly id: string;
  readonly tenant: string;
  readonly filename: string;
  readonly basis?: TemporalBasis;
}

/** Trusted catalog. A future provider can restore a versioned remote snapshot here. */
export class SnapshotProvider extends Context.Service<
  SnapshotProvider,
  {
    readonly databases: Effect.Effect<readonly LocalDatabase[], ReadError>;
  }
>()("triplex/duckdb/SnapshotProvider") {
  static local(databases: readonly LocalDatabase[]) {
    const catalog = databases.map((database) =>
      Object.freeze({
        ...database,
        ...(database.basis === undefined ? {} : { basis: Object.freeze({ ...database.basis }) }),
      }),
    );
    return Layer.succeed(SnapshotProvider, { databases: Effect.succeed(Object.freeze(catalog)) });
  }
}

type Clause = DatalogQuery["where"][number];
type Term = string | number | boolean | { readonly type: "ref"; readonly value: string };
export type SourcePattern = readonly [
  source: `$${string}`,
  entity: string,
  attribute: string,
  value: Term,
  tx?: string,
];
export type FederatedClause =
  | Clause
  | SourcePattern
  | readonly ["not", ...(Clause | SourcePattern)[]];
export type FederatedQuery = Omit<DatalogQuery, "where"> & {
  /** Aliases reference catalog database IDs, never filenames. */
  readonly sources?: Readonly<Record<`$${string}`, string>>;
  readonly where: readonly FederatedClause[];
};

export const DATABASE_ATTRIBUTE = ":triplex/database";
export const TENANT_ATTRIBUTE = ":triplex/tenant";
export const TX_DATABASE_ATTRIBUTE = ":_tx/database";

/** Length-independent, reversible identities. Plain string values are never rewritten. */
export const sourceEntity = (database: string, entity: string): string =>
  `triplex:entity:${encodeURIComponent(database)}:${encodeURIComponent(entity)}`;
export const databaseEntity = (database: string): string =>
  `triplex:database:${encodeURIComponent(database)}`;
export const decodeSourceEntity = (
  identity: string,
): { readonly database: string; readonly entity: string } | undefined => {
  const match = /^triplex:entity:([^:]*):([^:]*)$/.exec(identity);
  if (!match) return undefined;
  try {
    return { database: decodeURIComponent(match[1]!), entity: decodeURIComponent(match[2]!) };
  } catch {
    return undefined;
  }
};

export const federationFailure = (cause: unknown): ReadError =>
  new ReadError({ message: `DuckDB federation: ${String(cause)}`, cause });

export type FactRow = Record<string, unknown>;
export interface ScanRequest {
  readonly attributes: readonly string[] | null;
  readonly after: string | null;
  readonly limit: number;
}
