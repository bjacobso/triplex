import { diagnose, type Diagnostic } from "@triplex-internal/core";
import { Data } from "effect";

export class UnsupportedConfigError extends Data.TaggedError("UnsupportedConfigError")<{
  readonly code: "http.unsupported-config";
  readonly path: string;
  readonly message: string;
}> {}

export class ConfigConflictError extends Data.TaggedError("ConfigConflictError")<{
  readonly code: "http.config-conflict";
  readonly path: string;
  readonly message: string;
}> {}

export class VersionNotFoundError extends Data.TaggedError("VersionNotFoundError")<{
  readonly code: "http.version-not-found";
  readonly version: string;
  readonly message: string;
}> {}

export class EntityNotFoundHttpError extends Data.TaggedError("EntityNotFoundHttpError")<{
  readonly code: "http.entity-not-found";
  readonly entityId: string;
  readonly message: string;
}> {}

export class RequestValidationError extends Data.TaggedError("RequestValidationError")<{
  readonly code: "http.invalid-request";
  readonly path: string;
  readonly message: string;
}> {}

export class DataShapeConflictError extends Data.TaggedError("DataShapeConflictError")<{
  readonly code: "http.data-shape-conflict";
  readonly path: string;
  readonly entityId: string;
  readonly message: string;
}> {}

export class ReadOnlyVersionError extends Data.TaggedError("ReadOnlyVersionError")<{
  readonly code: "http.read-only-version";
  readonly allow: string;
  readonly message: string;
}> {}

export class ScheduledFactsConflictError extends Data.TaggedError("ScheduledFactsConflictError")<{
  readonly code: "http.scheduled-facts";
  readonly entityId: string;
  readonly message: string;
}> {}

export class CursorConflictError extends Data.TaggedError("CursorConflictError")<{
  readonly code: "http.cursor-conflict";
  readonly message: string;
}> {}

/**
 * The release marks an attribute sensitive, but the host's `Triples` is not
 * decorated with a `Sensitive.layer` that seals it. Writes fail closed so
 * plaintext is never stored by accident.
 */
export class SensitiveStorageRequiredError extends Data.TaggedError(
  "SensitiveStorageRequiredError",
)<{
  readonly code: "http.sensitive-storage-required";
  readonly attribute: string;
  readonly message: string;
}> {}

export class UnauthorizedError extends Data.TaggedError("UnauthorizedError")<{
  readonly code: "http.unauthorized";
  readonly message: string;
}> {}

export class ForbiddenError extends Data.TaggedError("ForbiddenError")<{
  readonly code: "http.forbidden";
  readonly message: string;
}> {}

export type CompileError = UnsupportedConfigError | ConfigConflictError;
export type AuthorizationError = UnauthorizedError | ForbiddenError;

const recovery = {
  "http.unsupported-config": "Use configuration supported by the HTTP API compiler.",
  "http.config-conflict": "Resolve conflicting definitions in the deployed configuration.",
  "http.version-not-found": "Use latest or an existing configuration snapshot or alias.",
  "http.entity-not-found": "Check the entity ID, collection and temporal basis.",
  "http.invalid-request": "Correct the named request field using the OpenAPI schema.",
  "http.data-shape-conflict": "Repair the entity facts to match the deployed configuration.",
  "http.read-only-version": "Write through latest or the active write snapshot.",
  "http.scheduled-facts": "Resolve scheduled facts before replacing or deleting this entity.",
  "http.cursor-conflict": "Restart pagination without a cursor under the current configuration.",
  "http.sensitive-storage-required":
    "Configure the host with Sensitive.layer before writing sensitive attributes.",
  "http.unauthorized": "Supply authentication accepted by the host.",
  "http.forbidden": "Request access to this operation from the host.",
  "http.collection-not-found": "Use a collection listed in the OpenAPI document.",
  "http.not-found": "Use a route listed in the OpenAPI document.",
  "http.method-not-allowed": "Use a method listed in the Allow header.",
} as const;

/** Diagnostics for HTTP-owned failures and route rejections. */
export const httpDiagnostic = (
  code: keyof typeof recovery,
  message: string,
  path?: string,
): Diagnostic => ({
  code,
  message,
  ...(path === undefined ? {} : { path }),
  fix: recovery[code],
  retryable: false,
});

/** Diagnose HTTP-owned failures and delegate core failures to diagnose. */
export const diagnoseHttp = (error: unknown): Diagnostic => {
  if (
    error instanceof UnsupportedConfigError ||
    error instanceof ConfigConflictError ||
    error instanceof VersionNotFoundError ||
    error instanceof EntityNotFoundHttpError ||
    error instanceof RequestValidationError ||
    error instanceof DataShapeConflictError ||
    error instanceof ReadOnlyVersionError ||
    error instanceof ScheduledFactsConflictError ||
    error instanceof CursorConflictError ||
    error instanceof SensitiveStorageRequiredError ||
    error instanceof UnauthorizedError ||
    error instanceof ForbiddenError
  ) {
    return httpDiagnostic(error.code, error.message, "path" in error ? error.path : undefined);
  }
  return diagnose(error);
};
