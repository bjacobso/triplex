import { describe, expect, it } from "vitest";
import { Encoding } from "effect";

import { finishPagination, preparePagination } from "../src/Pagination.js";
import { PaginationCursorError } from "../src/errors/index.js";
import type { WrappedQuery } from "../src/datalog/types.js";

const query: WrappedQuery = {
  inner: {
    find: ["?entity", "?name"],
    where: [["?entity", ":person/name", "?name"]],
  },
  orderBy: [{ variable: "?name", direction: "asc" }],
  limit: 2,
  includeCount: true,
};

const encoded = (value: unknown): string =>
  Encoding.encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));

describe("paged query cursor contract", () => {
  it("defaults to a bounded page and reuses omitted temporal fields from the cursor", () => {
    const request = { inner: query.inner };
    const first = preparePagination({
      query: request,
      now: 100,
      recordedPosition: 4,
      scope: "test",
    });
    expect(first.pageSize).toBe(100);
    expect(first.query.limit).toBe(101);
    const page = finishPagination(first, {
      results: Array.from({ length: 101 }, (_, i) => ({ "?entity": String(i), "?name": "A" })),
    });
    for (const basis of [{}, { recordedAt: 100 }, { validAt: 100 }]) {
      const next = preparePagination({
        query: { ...request, cursor: page.nextCursor! },
        basis,
        now: 200,
        recordedPosition: 9,
        scope: "test",
      });
      expect(next.basis).toEqual(first.basis);
    }
  });

  it.each([0, -1, 1.5, 1001, Infinity, Number.MAX_SAFE_INTEGER])(
    "rejects invalid public page size %s",
    (limit) => {
      expect(() =>
        preparePagination({
          query: { ...query, limit },
          now: 100,
          recordedPosition: 4,
          scope: "test",
        }),
      ).toThrow(PaginationCursorError);
    },
  );

  it("pins the basis and completes equal primary ordering with row tie-breakers", () => {
    const first = preparePagination({
      query,
      now: 100,
      recordedPosition: 4,
      scope: "database:one",
    });
    expect(first.basis).toEqual({ recordedAt: 100, recordedPosition: 4, validAt: 100 });
    expect(first.orderBy).toEqual([
      { variable: "?name", direction: "asc" },
      { variable: "?entity", direction: "asc" },
    ]);
    expect(first.query.limit).toBe(3);

    const page = finishPagination(first, {
      results: [
        { "?entity": "person:1", "?name": "Alex" },
        { "?entity": "person:2", "?name": "Alex" },
        { "?entity": "person:3", "?name": "Bea" },
      ],
      totalCount: 3,
    });
    expect(page.results.map((row) => row["?entity"])).toEqual(["person:1", "person:2"]);
    expect(page.nextCursor).toBeDefined();

    const next = preparePagination({
      query: { ...query, cursor: page.nextCursor },
      now: 1_000,
      recordedPosition: 9,
      scope: "database:one",
    });
    expect(next.basis).toEqual({ recordedAt: 100, recordedPosition: 4, validAt: 100 });
    expect(next.cursorValues).toEqual(["Alex", "person:2"]);
  });

  it("does not emit a cursor for an exact final page", () => {
    const prepared = preparePagination({
      query,
      now: 100,
      recordedPosition: 4,
      scope: "database:one",
    });
    const page = finishPagination(prepared, {
      results: [
        { "?entity": "person:1", "?name": "Alex" },
        { "?entity": "person:2", "?name": "Bea" },
      ],
    });
    expect(page.nextCursor).toBeUndefined();
  });

  it.each([
    ["invalid base64", "%%%"],
    ["invalid JSON", Encoding.encodeBase64Url(new TextEncoder().encode("{"))],
    ["invalid shape", encoded({ version: 1, queryFingerprint: "x", scopeFingerprint: "y" })],
  ])("rejects %s with a typed error", (_label, cursor) => {
    expect(() =>
      preparePagination({
        query: { ...query, cursor },
        now: 100,
        recordedPosition: 4,
        scope: "database:one",
      }),
    ).toThrow(PaginationCursorError);
  });

  it("rejects unsupported versions", () => {
    const cursor = encoded({
      version: 2,
      queryFingerprint: "x",
      scopeFingerprint: "y",
      basis: { recordedAt: 100, recordedPosition: 4, validAt: 100 },
      values: ["Alex", "person:1"],
    });
    try {
      preparePagination({
        query: { ...query, cursor },
        now: 100,
        recordedPosition: 4,
        scope: "database:one",
      });
      throw new Error("expected cursor rejection");
    } catch (error) {
      expect(error).toMatchObject({ _tag: "PaginationCursorError", reason: "unsupported_version" });
    }
  });

  it("rejects non-finite cursor values and invalid commit positions", () => {
    const cursor = encoded({
      version: 1,
      queryFingerprint: "x",
      scopeFingerprint: "y",
      basis: { recordedAt: 100, recordedPosition: -1, validAt: 100 },
      values: ["Alex", "person:1"],
    });
    expect(() =>
      preparePagination({
        query: { ...query, cursor },
        now: 100,
        recordedPosition: 4,
        scope: "database:one",
      }),
    ).toThrowError(expect.objectContaining({ reason: "malformed" }));
    expect(() =>
      preparePagination({
        query,
        now: 100,
        recordedPosition: -1,
        scope: "database:one",
      }),
    ).toThrowError(expect.objectContaining({ reason: "malformed" }));
  });

  it("rejects cross-query, cross-scope, and explicit basis reuse", () => {
    const first = preparePagination({
      query,
      now: 100,
      recordedPosition: 4,
      scope: "database:one",
    });
    const cursor = finishPagination(first, {
      results: [
        { "?entity": "person:1", "?name": "Alex" },
        { "?entity": "person:2", "?name": "Bea" },
        { "?entity": "person:3", "?name": "Cal" },
      ],
    }).nextCursor!;

    expect(() =>
      preparePagination({
        query: { ...query, filters: [{ column: "?name", op: "=", value: "Bea" }], cursor },
        now: 100,
        recordedPosition: 4,
        scope: "database:one",
      }),
    ).toThrowError(expect.objectContaining({ reason: "query_mismatch" }));
    expect(() =>
      preparePagination({
        query: { ...query, cursor },
        now: 100,
        recordedPosition: 4,
        scope: "database:two",
      }),
    ).toThrowError(expect.objectContaining({ reason: "scope_mismatch" }));
    expect(() =>
      preparePagination({
        query: { ...query, cursor },
        basis: { recordedAt: 99, validAt: 100 },
        now: 100,
        recordedPosition: 4,
        scope: "database:one",
      }),
    ).toThrowError(expect.objectContaining({ reason: "basis_mismatch" }));
  });
});
