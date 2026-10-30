/**
 * Build immutable import segments and attach them to a store.
 *
 * `build` sorts and indexes a batch of facts in one pass (pure, so it can run
 * in a worker); `encode` and `decode` move one as a single buffer; `attach`
 * adds its facts to the store in one small transaction. See the
 * [segments design notes](https://triplex.build/segments).
 */

import type { TransactionMeta, TriplesService } from "../store/Triples.js";
import { transactSegment } from "../store/systemNamespace.js";
import type { Segment } from "../segment/Segment.js";

export {
  build,
  contentId,
  decode,
  encode,
  verify,
  SegmentDecodeError,
  type Segment,
} from "../segment/Segment.js";

/**
 * Attach a segment in one transaction. Its facts become visible at that
 * transaction's position, recorded at its instant, and the journal records one
 * summary naming the segment rather than one change per fact. Only the
 * in-memory KV backend supports this today; others fail with `WriteError`.
 */
export const attach = (
  triples: TriplesService,
  segment: Segment,
  meta?: Omit<TransactionMeta, "preconditions" | "enforce" | "journal">,
): ReturnType<TriplesService["transact"]> => transactSegment(triples, segment, meta);
