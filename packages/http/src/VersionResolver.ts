import { ConfigStore } from "@bjacobso/triplex/config";
import { Context, Effect, Layer } from "effect";

import { VersionNotFoundError } from "./Errors.js";

export interface VersionOptions {
  readonly latestRef?: string;
  readonly aliases?: Readonly<Record<string, string>>;
  /** Makes a pinned deployment or immutable alias writable. `latest` remains writable. */
  readonly activeWriteSnapshot?: string;
}

export interface ResolvedVersion {
  readonly requested: string;
  readonly snapshot: ConfigStore.ConfigSnapshot;
  readonly writable: boolean;
}

export interface VersionResolverService {
  readonly resolve: (version: string) => Effect.Effect<ResolvedVersion, unknown>;
}

export class VersionResolver extends Context.Service<VersionResolver, VersionResolverService>()(
  "triplex-http/VersionResolver",
) {}

const safeVersion = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export const layer = (
  options: VersionOptions = {},
): Layer.Layer<VersionResolver, never, ConfigStore.ConfigStore> =>
  Layer.effect(
    VersionResolver,
    Effect.gen(function* () {
      const store = yield* ConfigStore.ConfigStore;
      return {
        resolve: (version) =>
          Effect.gen(function* () {
            if (!safeVersion.test(version)) {
              return yield* new VersionNotFoundError({
                code: "version_not_found",
                version,
                message: `Unknown configuration version ${version}`,
              });
            }
            const aliased = options.aliases?.[version];
            const snapshot =
              version === "latest"
                ? yield* store.resolveRef(options.latestRef ?? "live")
                : yield* store.snapshotById(
                    (aliased ?? version) as ConfigStore.ConfigSnapshot["id"],
                  );
            if (snapshot === undefined) {
              return yield* new VersionNotFoundError({
                code: "version_not_found",
                version,
                message: `Unknown configuration version ${version}`,
              });
            }
            return {
              requested: version,
              snapshot,
              writable: version === "latest" || options.activeWriteSnapshot === snapshot.id,
            };
          }),
      } satisfies VersionResolverService;
    }),
  );
