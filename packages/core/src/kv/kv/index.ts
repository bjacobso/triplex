export {
  KvBackend,
  type KvBackendService,
  type KvEntry,
  type KvTransaction,
  type RangeOptions,
} from "./KvBackend.js";
export { InMemoryKvBackendLive, makeTestKvBackend } from "./InMemoryKvBackend.js";
// FdbKvBackend is intentionally NOT re-exported from this barrel.
// It uses Node.js Buffer at the top level and must be imported directly:
//   import { makeFdbKvBackend } from "@triplex-build/triplex-foundationdb"
export { compare, increment, concat, fromHex, toHex, startsWith } from "./encoding.js";
