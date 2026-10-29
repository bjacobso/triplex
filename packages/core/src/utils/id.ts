/**
 * Minimal ID generation utilities for the database package.
 *
 * Only includes what the database layer needs directly.
 * Runtime-owned metadata and higher-level ID helpers live in the runtime layer.
 */

import { monotonicFactory } from "ulidx";
import { TransactionId, TripleId } from "../Branded.js";

/**
 * Generate a new ULID (TripleId).
 */
export const generateId = (): TripleId => TripleId.make(monotonicUlid());

/**
 * Generate a transaction ID.
 */
export const generateTransactionId = (): TransactionId =>
  TransactionId.make(`_tx/${monotonicUlid()}`);

/**
 * Transaction metadata attributes.
 */
export const TxAttributes = {
  /** Backend-issued, monotonically increasing commit position. */
  POSITION: ":_tx/position",
  /** Timestamp when the transaction occurred (epoch millis) */
  INSTANT: ":_tx/instant",
  /** Actor (human, agent, or service) that issued the command. */
  ACTOR: ":_tx/actor",
  /** Idempotency key for the command represented by this transaction. */
  COMMAND_ID: ":_tx/command-id",
  /** Correlates transactions that belong to one operation or workflow. */
  CORRELATION_ID: ":_tx/correlation-id",
  /** Transaction or event that caused this transaction. */
  CAUSATION_ID: ":_tx/causation-id",
  /** Immutable configuration snapshot that governed the command. */
  CONFIG_SNAPSHOT: ":_tx/config-snapshot",
  /** Persisted description of an asserted or retracted fact. */
  CHANGE: ":_tx/change",
  /** Indexed reference from a transaction envelope to every changed entity. */
  CHANGED_ENTITY: ":_tx/changed-entity",
  /** Compact description of every change, for transactions journaled as a summary. */
  SUMMARY: ":_tx/summary",
} as const;

/**
 * System entity prefixes used by the database layer.
 */
export const SystemPrefixes = {
  TRANSACTION: "_tx",
} as const;
const monotonicUlid = monotonicFactory();
