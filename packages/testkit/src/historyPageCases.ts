import { Effect, Option } from "effect";
import {
  EntityId,
  PaginationCursorError,
  Triples,
  string,
  type Triple,
} from "@triplex-internal/core";

const check = (condition: boolean, message: string) =>
  condition ? Effect.void : Effect.fail(new Error(message));

const key = (fact: Triple) =>
  JSON.stringify([fact.id, fact.attribute, fact.value, Option.isSome(fact.retractedAt)]);

/** Reads every page of one history read and returns the facts in page order. */
const readAll = (
  entityId: EntityId,
  request: { readonly attribute?: string; readonly limit: number },
  between?: () => Effect.Effect<void, unknown, Triples>,
) =>
  Effect.gen(function* () {
    const t = yield* Triples;
    const facts: Triple[] = [];
    let cursor: string | undefined;
    let pages = 0;
    let snapshot: number | undefined;
    do {
      const page = yield* t.historyPage(entityId, {
        ...request,
        ...(cursor === undefined ? {} : { cursor }),
      });
      yield* check(page.facts.length <= request.limit, "a history page exceeds its limit");
      yield* check(
        snapshot === undefined || page.snapshotPosition === snapshot,
        "a continuation changed the snapshot position",
      );
      snapshot = page.snapshotPosition;
      facts.push(...page.facts);
      cursor = page.nextCursor;
      pages++;
      if (between !== undefined && cursor !== undefined) yield* between();
    } while (cursor !== undefined);
    return { facts, pages };
  });

/** Bounded history pages, checked against the unpaged `history` oracle. */
export const historyPageConformanceCases = [
  {
    name: "historyPage pages equal unpaged history, pinned against writes between pages",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const entityId = EntityId.make("conf:history-page");
      const other = EntityId.make("conf:history-page:other");
      const ids: Triple["id"][] = [];
      for (let step = 0; step < 23; step++) {
        const attribute = step % 3 === 0 ? ":hp/b" : ":hp/a";
        // Several facts per transaction share a position, so the ID breaks ties.
        const result = yield* t.transact([
          { op: "assert", entityId, attribute, value: string(`v${step}`), validFrom: 0 },
          { op: "assert", entityId, attribute: ":hp/a", value: string(`w${step}`), validFrom: 0 },
          { op: "assert", entityId: other, attribute, value: string(`o${step}`), validFrom: 0 },
        ]);
        ids.push(result.triples[0]!.id, result.triples[1]!.id);
        if (step % 4 === 1) yield* t.retract(ids[step]!);
      }
      const oracle = yield* t.history(entityId);
      for (const attribute of [undefined, ":hp/a", ":hp/b"]) {
        const expected = oracle
          .filter((fact) => attribute === undefined || fact.attribute === attribute)
          .map(key)
          .sort();
        for (const limit of [1, 2, 7, 1000]) {
          const { facts, pages } = yield* readAll(entityId, {
            limit,
            ...(attribute === undefined ? {} : { attribute }),
          });
          const label = `attribute ${attribute ?? "*"} limit ${limit}`;
          yield* check(
            JSON.stringify(facts.map(key).sort()) === JSON.stringify(expected),
            `${label}: pages differ from history`,
          );
          yield* check(
            new Set(facts.map((fact) => fact.id)).size === facts.length,
            `${label}: a fact repeated across pages`,
          );
          yield* check(
            facts.every((fact, i) => i === 0 || facts[i - 1]!.recordedAt <= fact.recordedAt),
            `${label}: pages are not in commit order`,
          );
          // limit + 1: an exactly full last page has no continuation.
          yield* check(
            pages === Math.max(1, Math.ceil(expected.length / limit)),
            `${label}: ${pages} pages for ${expected.length} facts`,
          );
        }
      }

      // Writes between pages: later assertions are not shown, and a later retraction
      // shows the fact as live, as it was at the first page's position.
      const before = yield* t.history(entityId);
      const live = before.filter((fact) => Option.isNone(fact.retractedAt));
      let retracted = 0;
      const { facts } = yield* readAll(entityId, { limit: 3 }, () =>
        Effect.gen(function* () {
          yield* t.assert({ entityId, attribute: ":hp/a", value: string("late"), validFrom: 0 });
          const target = live[retracted++];
          if (target !== undefined) yield* t.retract(target.id);
        }),
      );
      yield* check(
        JSON.stringify(facts.map(key).sort()) === JSON.stringify(before.map(key).sort()),
        "writes between pages changed the pinned history",
      );

      // An explicit recorded position reads history as recorded there.
      const first = yield* t.historyPage(entityId, { recordedPosition: 0 });
      yield* check(first.facts.length === 0 && first.nextCursor === undefined, "position zero");

      // Cursors are bound to their entity, attribute and position.
      const page = yield* t.historyPage(entityId, { limit: 1 });
      const reason = (request: Parameters<typeof t.historyPage>[1], id = entityId) =>
        t.historyPage(id, request).pipe(
          Effect.match({
            onFailure: (error) => (error instanceof PaginationCursorError ? error.reason : "other"),
            onSuccess: () => "accepted",
          }),
        );
      yield* check(
        (yield* reason({ cursor: page.nextCursor! }, other)) === "query_mismatch",
        "a cursor was accepted for another entity",
      );
      yield* check(
        (yield* reason({ cursor: page.nextCursor!, attribute: ":hp/a" })) === "query_mismatch",
        "a cursor was accepted for another attribute",
      );
      yield* check(
        (yield* reason({ cursor: page.nextCursor!, recordedPosition: 1 })) === "basis_mismatch",
        "a cursor was accepted at another position",
      );
      for (const cursor of ["not a cursor", "eyJ2ZXJzaW9uIjoxfQ"])
        yield* check(
          (yield* reason({ cursor })) === "malformed",
          `a malformed cursor was accepted: ${cursor}`,
        );
      for (const limit of [0, 1001, 1.5])
        yield* check((yield* reason({ limit })) === "malformed", `limit ${limit} was accepted`);
    }),
  },
] as const;
