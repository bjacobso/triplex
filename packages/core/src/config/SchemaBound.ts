/** Opt-in release-bound attribute checking for any Triples backend. */
import { Effect, Layer } from "effect";
import { checkAttributes } from "../datalog/attributes.js";
import type { DatalogQuery, WrappedQuery } from "../datalog/types.js";
import { validateDatalogQuery, validateWrappedQuery } from "../datalog/validation.js";
import { DatalogError, ReadError, UnknownAttributeError } from "../errors/index.js";
import { Triples, type TriplesService } from "../store/Triples.js";
import * as Attribute from "./Attribute.js";
import * as ConfigNode from "./ConfigNode.js";
import { ConfigStore, type ConfigSnapshot } from "./ConfigStore.js";

/** Attribute keys declared anywhere in an immutable release tree. */
export const attributeKeys = (snapshot: ConfigSnapshot): ReadonlySet<string> => {
  const keys = new Set<string>();
  for (const { node } of ConfigNode.walk(snapshot.root)) {
    if (node.kind === Attribute.KIND) keys.add(node.key);
  }
  return keys;
};

export interface LayerOptions {
  /** Movable release ref; resolved on each checked read. Defaults to live. */
  readonly ref?: string;
}

/**
 * Decorate Triples using a ConfigStore built over the underlying Triples layer.
 * Unknown attributes fail before backend execution. match retains its ReadError
 * contract and puts the UnknownAttributeError in cause.
 */
export const layer = (
  options: LayerOptions = {},
): Layer.Layer<Triples, never, Triples | ConfigStore> =>
  Layer.effect(
    Triples,
    Effect.gen(function* () {
      const inner = yield* Triples;
      const store = yield* ConfigStore;
      const ref = options.ref ?? "live";
      const check = (query: DatalogQuery | WrappedQuery) =>
        Effect.gen(function* () {
          const snapshot = yield* store.resolveRef(ref).pipe(
            Effect.mapError(
              (cause) =>
                new DatalogError({
                  message: `Could not resolve configuration ref "${ref}"`,
                  cause,
                }),
            ),
          );
          if (snapshot === undefined)
            return yield* new DatalogError({
              message: `Configuration ref "${ref}" does not exist`,
            });
          yield* checkAttributes(query, attributeKeys(snapshot));
        });
      const prepare = (query: DatalogQuery) =>
        validateDatalogQuery(query).pipe(Effect.flatMap(check));
      const prepareWrapped = (query: WrappedQuery) =>
        validateWrappedQuery(query).pipe(Effect.flatMap(check));
      return {
        ...inner,
        query: (query, options) =>
          prepare(query).pipe(Effect.andThen(() => inner.query(query, options))),
        queryAll: (query, options) =>
          prepare(query).pipe(Effect.andThen(() => inner.queryAll(query, options))),
        queryPage: (query, options) =>
          prepareWrapped(query).pipe(Effect.andThen(() => inner.queryPage(query, options))),
        explain: (query) => prepare(query).pipe(Effect.andThen(() => inner.explain(query))),
        explainPage: (query) =>
          prepareWrapped(query).pipe(Effect.andThen(() => inner.explainPage(query))),
        match: (pattern, basis) =>
          typeof pattern.attribute !== "string"
            ? inner.match(pattern, basis)
            : check({ find: ["?e"], where: [["?e", pattern.attribute, "?v"]] }).pipe(
                Effect.mapError(
                  (cause) =>
                    new ReadError({
                      message: cause.message.replace("where[0][1]", "match.attribute"),
                      cause:
                        cause._tag === "UnknownAttributeError"
                          ? new UnknownAttributeError({
                              ...cause,
                              path: "match.attribute",
                              message: cause.message.replace("where[0][1]", "match.attribute"),
                            })
                          : cause,
                    }),
                ),
                Effect.andThen(() => inner.match(pattern, basis)),
              ),
      } satisfies TriplesService;
    }),
  );
