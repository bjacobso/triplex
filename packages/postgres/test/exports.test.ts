import { describe, expect, expectTypeOf, it } from "vitest";

import { unsafe } from "@triplex-build/triplex";
import {
  databaseToSchema,
  type PostgresqlDialect,
  type makePostgresqlBackendFromUrl,
} from "../src/index.js";

describe("database-postgres", () => {
  it("exposes postgres backend wiring types through the database package", () => {
    expectTypeOf<PostgresqlDialect>().toBeObject();
    expectTypeOf<typeof makePostgresqlBackendFromUrl>().toBeFunction();
  });

  it("derives bounded collision-resistant schema names", () => {
    const prefix = "organization-with-a-very-long-shared-prefix-";
    const left = databaseToSchema(unsafe.databaseId(`${prefix}left`));
    const right = databaseToSchema(unsafe.databaseId(`${prefix}right`));

    expect(databaseToSchema(unsafe.databaseId(`${prefix}left`))).toBe(left);
    expect(left).not.toBe(right);
    expect(left.length).toBeLessThanOrEqual(63);
    expect(left).toMatch(/^triplex_[a-z0-9_]+_[a-f0-9]{16}$/);
  });
});
