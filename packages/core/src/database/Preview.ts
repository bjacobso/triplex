/** Read-only projection of the same compiled command used by Database.command. */
import { Effect, Option } from "effect";
import type { EntityId } from "../Branded.js";
import type * as Change from "../Change.js";
import * as Constraint from "../Constraint.js";
import type * as ConfigStore from "../config/ConfigStore.js";
import * as Derivation from "../derivation/Derivation.js";
import { evaluateOverlay } from "../derivation/Overlay.js";
import { ReadError } from "../errors/index.js";
import { Sensitivity, type SensitivityService } from "../sensitive/Sensitive.js";
import type {
  TransactionChange,
  TransactionRecord,
  TriplesService,
  TransactionMeta,
} from "../store/Triples.js";
import type { TransactOp, Triple } from "../Triple.js";

export interface PreviewOptions {
  readonly derivations?: readonly Derivation.Definition[];
}
/** Assertion IDs and commit metadata do not exist until commit. Intervals with omitted
 * validFrom are projected at preview time and are assigned again by the commit clock. */
export type PreviewChange = Omit<TransactionChange, "tripleId"> & {
  readonly tripleId?: TransactionChange["tripleId"];
};
export interface PreviewDerivation extends Derivation.Reconciliation {
  readonly definition: string;
}
export interface Preview {
  readonly release: string | null;
  readonly operations: Change.Change;
  readonly changes: readonly PreviewChange[];
  readonly violations: readonly Constraint.ViolationAt[];
  readonly derivations: readonly PreviewDerivation[];
  readonly commandAlreadyCommitted?: TransactionRecord;
}

const changeOf = (op: "assert" | "retract", fact: Triple): PreviewChange => ({
  op,
  ...(op === "retract" ? { tripleId: fact.id } : {}),
  entityId: fact.entityId,
  attribute: fact.attribute,
  value: fact.value,
  ...(Option.isSome(fact.entityType) ? { entityType: fact.entityType.value } : {}),
  validFrom: fact.validFrom,
  ...(Option.isSome(fact.validTo) ? { validTo: fact.validTo.value } : {}),
});

export const previewCommand = (
  triples: TriplesService,
  compiled: {
    readonly combined: Change.Change;
    readonly release: ConfigStore.ConfigSnapshot;
    readonly pinned: Pick<TransactionMeta, "enforce">;
    readonly started: number;
  },
  options: PreviewOptions,
  sensitivity: Option.Option<SensitivityService>,
) =>
  Effect.gen(function* () {
    const { release, started } = compiled;
    const position = yield* triples.currentPosition();
    const basis = { recordedPosition: position, validAt: started };
    const ops = yield* Effect.forEach(
      compiled.combined.ops,
      (op): Effect.Effect<TransactOp, import("../errors/index.js").SensitiveValueError> => {
        if (op.op !== "assert" || Option.isNone(sensitivity) || op.value.type === "sealed")
          return Effect.succeed(op);
        return sensitivity.value
          .sealValue(op.entityId, op.attribute, op.value)
          .pipe(Effect.map((value) => ({ ...op, value })));
      },
    );
    const rules = compiled.pinned.enforce?.constraints ?? [];
    const liveHistory = (id: string) =>
      triples
        .history(id as EntityId)
        .pipe(Effect.map((facts) => facts.filter((f) => Option.isNone(f.retractedAt))));
    // Triples has no all-valid-time entity-type read. Discover subjects from the
    // durable journal, then load their live-recorded histories (including future facts).
    const subjects = new Map<string, Set<string>>();
    if (rules.length > 0) {
      let after = 0;
      while (after < position) {
        const page = yield* triples.transactions({ after, limit: 1000 });
        if (page.transactions.length === 0) break;
        for (const receipt of page.transactions) {
          if (receipt.position > position) break;
          for (const change of receipt.changes) {
            if (change.entityType === undefined) continue;
            const ids = subjects.get(change.entityType) ?? new Set<string>();
            ids.add(change.entityId);
            subjects.set(change.entityType, ids);
          }
        }
        after = page.transactions[page.transactions.length - 1]!.position;
      }
    }
    const current = yield* Constraint.loadRelevantFacts(rules, ops, {
      byEntityType: (entityType) =>
        Effect.forEach([...(subjects.get(entityType) ?? [])], liveHistory).pipe(
          Effect.map((rows) =>
            rows
              .flat()
              .filter((f) => Option.isSome(f.entityType) && f.entityType.value === entityType),
          ),
        ),
      byEntities: (ids) => Effect.forEach(ids, liveHistory).pipe(Effect.map((rows) => rows.flat())),
    });
    const violations = yield* Constraint.newlyViolated(current, ops, rules, started).pipe(
      Effect.mapError(
        (cause) => new ReadError({ message: "Could not project command constraints", cause }),
      ),
    );
    const changes: PreviewChange[] = [];
    for (const op of ops) {
      if (op.op === "assert") {
        const facts = yield* Constraint.project([], [op], started).pipe(
          Effect.mapError(
            (cause) => new ReadError({ message: "Could not project assertion", cause }),
          ),
        );
        changes.push(changeOf("assert", facts[0]!));
      } else if (op.op === "retract") {
        const fact = yield* triples.get(op.id);
        if (fact && Option.isNone(fact.retractedAt)) changes.push(changeOf("retract", fact));
      }
    }
    const derivations = yield* Effect.forEach(options.derivations ?? [], (definition) =>
      Effect.gen(function* () {
        const attributes = new Set(definition.dependencies.attributes);
        const visible = (yield* Effect.forEach([...attributes], (attribute) =>
          triples.match({ attribute }, basis),
        )).flat();
        const relevant = changes.filter((c) => attributes.has(c.attribute));
        // Only this internal overlay receives prepared values; keep the normal public
        // overlay's prohibition on caller-supplied ciphertext intact.
        const evaluate = (overlay: import("../derivation/Overlay.js").Overlay) => {
          const evaluation = evaluateOverlay(triples, definition, { basis, overlay });
          if (Option.isNone(sensitivity)) return evaluation;
          const service = sensitivity.value;
          return evaluation.pipe(
            Effect.provideService(Sensitivity, {
              ...service,
              sealValue: (entity, attribute, value) =>
                value.type === "sealed"
                  ? Effect.succeed(value)
                  : service.sealValue(entity, attribute, value),
            }),
          );
        };
        const before = yield* evaluate({});
        const after = yield* evaluate({
          assertions: ops.flatMap((op) =>
            op.op === "assert" && attributes.has(op.attribute)
              ? [{ ...op, validFrom: op.validFrom ?? started }]
              : [],
          ),
          retractions: relevant.flatMap((c) =>
            c.op === "retract" && c.tripleId && visible.some((f) => f.id === c.tripleId)
              ? [c.tripleId]
              : [],
          ),
        });
        return {
          definition: definition.id,
          ...Derivation.reconcile(before.candidates, after.candidates),
        };
      }).pipe(
        Effect.mapError(
          (cause) => new ReadError({ message: "Could not preview derivation", cause }),
        ),
      ),
    );
    return {
      release: release.id,
      operations: { ...compiled.combined, ops },
      changes,
      violations,
      derivations,
    } satisfies Preview;
  });
