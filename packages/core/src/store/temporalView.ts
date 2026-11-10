import { Option } from "effect";
import type { Triple } from "../Triple.js";

/** Visible facts at an explicit position had not yet been retracted at that cut. */
export const tripleAtRecordedPosition = (triple: Triple, position?: number): Triple =>
  position === undefined
    ? triple
    : {
        ...triple,
        retractedAt: Option.none(),
        retractTxId: Option.none(),
      };
