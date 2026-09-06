import { Data } from "effect";

export class UnsupportedConfigError extends Data.TaggedError("UnsupportedConfigError")<{
  readonly code: "unsupported_config";
  readonly path: string;
  readonly message: string;
}> {}

export class ConfigConflictError extends Data.TaggedError("ConfigConflictError")<{
  readonly code: "config_conflict";
  readonly path: string;
  readonly message: string;
}> {}

export class VersionNotFoundError extends Data.TaggedError("VersionNotFoundError")<{
  readonly code: "version_not_found";
  readonly version: string;
  readonly message: string;
}> {}

export class EntityNotFoundHttpError extends Data.TaggedError("EntityNotFoundHttpError")<{
  readonly code: "entity_not_found";
  readonly entityId: string;
  readonly message: string;
}> {}

export class RequestValidationError extends Data.TaggedError("RequestValidationError")<{
  readonly code: "invalid_request";
  readonly path: string;
  readonly message: string;
}> {}

export class DataShapeConflictError extends Data.TaggedError("DataShapeConflictError")<{
  readonly code: "data_shape_conflict";
  readonly path: string;
  readonly entityId: string;
  readonly message: string;
}> {}

export class ReadOnlyVersionError extends Data.TaggedError("ReadOnlyVersionError")<{
  readonly code: "read_only_version";
  readonly allow: string;
  readonly message: string;
}> {}

export class ScheduledFactsConflictError extends Data.TaggedError("ScheduledFactsConflictError")<{
  readonly code: "scheduled_facts";
  readonly entityId: string;
  readonly message: string;
}> {}

export class CursorConflictError extends Data.TaggedError("CursorConflictError")<{
  readonly code: "cursor_conflict";
  readonly message: string;
}> {}

export class UnauthorizedError extends Data.TaggedError("UnauthorizedError")<{
  readonly code: "unauthorized";
  readonly message: string;
}> {}

export class ForbiddenError extends Data.TaggedError("ForbiddenError")<{
  readonly code: "forbidden";
  readonly message: string;
}> {}

export type CompileError = UnsupportedConfigError | ConfigConflictError;
export type AuthorizationError = UnauthorizedError | ForbiddenError;
