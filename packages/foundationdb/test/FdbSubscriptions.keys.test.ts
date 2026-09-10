import { describe, expect, it } from "vitest";
import type { QueryDependencies } from "@triplex-build/triplex/subscriptions";
import {
  fdbSubscriptionAttributeKey,
  fdbSubscriptionEntityKey,
  fdbSubscriptionEntityTypeKey,
  fdbSubscriptionGlobalKey,
  fdbSubscriptionKeysForDependencies,
  fdbSubscriptionKeysForEvent,
} from "../src/FdbSubscriptions.js";

const dec = (u: Uint8Array): string => Buffer.from(u).toString("utf8");

const deps = (overrides: Partial<QueryDependencies>): QueryDependencies => ({
  attributes: new Set(),
  hasDynamicAttributes: false,
  entityTypes: new Set(),
  boundEntityIds: new Set(),
  boundEntityTypes: new Set(),
  unboundEntityTypes: new Set(),
  ruleNames: new Set(),
  ...overrides,
});

describe("FdbSubscriptions watch key mapping", () => {
  it("creates stable topic keys", () => {
    expect(dec(fdbSubscriptionGlobalKey())).toBe("__oo_subscriptions__/global");
    expect(dec(fdbSubscriptionAttributeKey(":employee/name"))).toBe(
      "__oo_subscriptions__/attr/:employee/name",
    );
    expect(dec(fdbSubscriptionEntityKey("emp:alice"))).toBe(
      "__oo_subscriptions__/entity/emp:alice",
    );
    expect(dec(fdbSubscriptionEntityTypeKey("employee"))).toBe(
      "__oo_subscriptions__/type/employee",
    );
  });

  it("maps change events to global, attribute, entity, and type topics", () => {
    const keys = fdbSubscriptionKeysForEvent({
      txId: "tx1",
      timestamp: 1,
      changes: [{ operation: "assert", entityId: "emp:alice", attribute: ":employee/name" }],
    }).map(dec);

    expect(keys).toEqual([
      "__oo_subscriptions__/global",
      "__oo_subscriptions__/attr/:employee/name",
      "__oo_subscriptions__/entity/emp:alice",
      "__oo_subscriptions__/type/employee",
    ]);
  });

  it("maps query dependencies to concrete watch topics", () => {
    const keys = fdbSubscriptionKeysForDependencies(
      deps({
        attributes: new Set([":employee/name"]),
        entityTypes: new Set(["employee"]),
        boundEntityIds: new Set(["emp:alice"]),
      }),
    ).map(dec);

    expect(keys).toEqual([
      "__oo_subscriptions__/attr/:employee/name",
      "__oo_subscriptions__/type/employee",
      "__oo_subscriptions__/entity/emp:alice",
    ]);
  });

  it("uses the global topic for dynamic attributes", () => {
    const keys = fdbSubscriptionKeysForDependencies(
      deps({
        hasDynamicAttributes: true,
      }),
    ).map(dec);

    expect(keys).toEqual(["__oo_subscriptions__/global"]);
  });
});
