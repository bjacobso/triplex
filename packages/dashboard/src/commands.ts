import { Effect, Schema } from "effect";
import { Command } from "foldkit";

import { DashboardApi } from "./api.js";
import { Message } from "./messages.js";

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = error.message;
    if (typeof message === "string") return message;
  }
  return String(error);
};

const basis = (recordedAt: number | null, validAt: number | null) => ({
  ...(recordedAt === null ? {} : { recordedAt }),
  ...(validAt === null ? {} : { validAt }),
});

const recover = Effect.catch((error: unknown) =>
  Effect.succeed(Message.FailedDashboardCommand({ message: errorMessage(error) })),
);

export const LoadDashboard = Command.define("LoadDashboard", {
  args: {
    recordedAt: Schema.NullOr(Schema.Number),
    validAt: Schema.NullOr(Schema.Number),
  },
  messages: [Message.SucceededLoadDashboard, Message.FailedDashboardCommand],
  execute: ({ recordedAt, validAt }) =>
    DashboardApi.pipe(
      Effect.flatMap((api) => api.loadDashboard(basis(recordedAt, validAt))),
      Effect.map((data) => Message.SucceededLoadDashboard({ data })),
      recover,
    ),
});

export const RunQuery = Command.define("RunQuery", {
  args: {
    source: Schema.String,
    recordedAt: Schema.NullOr(Schema.Number),
    validAt: Schema.NullOr(Schema.Number),
  },
  messages: [Message.SucceededRunQuery, Message.FailedDashboardCommand],
  execute: ({ source, recordedAt, validAt }) =>
    DashboardApi.pipe(
      Effect.flatMap((api) => api.runQuery(source, basis(recordedAt, validAt))),
      Effect.map((result) => Message.SucceededRunQuery({ result })),
      recover,
    ),
});

export const LoadEntityTypePage = Command.define("LoadEntityTypePage", {
  args: {
    entityType: Schema.String,
    cursor: Schema.NullOr(Schema.String),
    recordedAt: Schema.NullOr(Schema.Number),
    validAt: Schema.NullOr(Schema.Number),
  },
  messages: [Message.SucceededLoadEntityTypePage, Message.FailedDashboardCommand],
  execute: ({ entityType, cursor, recordedAt, validAt }) =>
    DashboardApi.pipe(
      Effect.flatMap((api) =>
        api.loadEntityTypePage(entityType, cursor, basis(recordedAt, validAt)),
      ),
      Effect.map((page) => Message.SucceededLoadEntityTypePage({ page })),
      recover,
    ),
});

export const LoadEntityHistory = Command.define("LoadEntityHistory", {
  args: { entityId: Schema.String },
  messages: [Message.SucceededLoadEntityHistory, Message.FailedDashboardCommand],
  execute: ({ entityId }) =>
    DashboardApi.pipe(
      Effect.flatMap((api) => api.loadEntityHistory(entityId)),
      Effect.map((transactions) =>
        Message.SucceededLoadEntityHistory({ transactions: [...transactions] }),
      ),
      recover,
    ),
});

export const SaveEntity = Command.define("SaveEntity", {
  args: {
    mode: Schema.Literals(["create", "edit"]),
    entityId: Schema.String,
    entityType: Schema.String,
    facts: Schema.String,
  },
  messages: [Message.SucceededMutation, Message.FailedDashboardCommand],
  execute: (input) =>
    DashboardApi.pipe(
      Effect.flatMap((api) => api.saveEntity(input)),
      Effect.map((notice) => Message.SucceededMutation({ notice })),
      recover,
    ),
});

export const SaveConfig = Command.define("SaveConfig", {
  args: {
    operation: Schema.Literals(["create", "edit", "remove"]),
    identity: Schema.optional(Schema.String),
    kind: Schema.String,
    key: Schema.String,
    attrs: Schema.String,
    refs: Schema.String,
    label: Schema.String,
    targetRef: Schema.String,
  },
  messages: [Message.SucceededMutation, Message.FailedDashboardCommand],
  execute: ({ identity, ...input }) =>
    DashboardApi.pipe(
      Effect.flatMap((api) =>
        api.publishConfig({ ...input, ...(identity === undefined ? {} : { identity }) }),
      ),
      Effect.map((notice) => Message.SucceededMutation({ notice })),
      recover,
    ),
});

export const MoveConfigRef = Command.define("MoveConfigRef", {
  args: { name: Schema.String, snapshotId: Schema.String },
  messages: [Message.SucceededMutation, Message.FailedDashboardCommand],
  execute: ({ name, snapshotId }) =>
    DashboardApi.pipe(
      Effect.flatMap((api) => api.moveConfigRef(name, snapshotId)),
      Effect.map((notice) => Message.SucceededMutation({ notice })),
      recover,
    ),
});
