import { Layer } from "effect";
import { SnapshotServiceLive, SnapshotWriterLive } from "@triplex-internal/core/internal";

/** SQL snapshot persistence over the same adapter and raw Triples service as the runtime. */
export const SqlSnapshotsLive = Layer.mergeAll(SnapshotServiceLive, SnapshotWriterLive);
