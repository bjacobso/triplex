import { describe, it, expect } from "vitest";
import { TopicTree } from "../../src/subscriptions/TopicTree.js";
import type { QueryDependencies, TripleChange } from "../../src/subscriptions/types.js";

const change = (
  entityId: string,
  attribute: string,
  operation: "assert" | "retract" = "assert",
): TripleChange => ({ entityId, attribute, operation });

function deps(overrides: Partial<QueryDependencies> = {}): QueryDependencies {
  return {
    attributes: new Set<string>(),
    hasDynamicAttributes: false,
    entityTypes: new Set<string>(),
    boundEntityIds: new Set<string>(),
    boundEntityTypes: new Set<string>(),
    unboundEntityTypes: new Set<string>(),
    ruleNames: new Set<string>(),
    ...overrides,
  };
}

describe("TopicTree", () => {
  it("finds affected connections for concrete attribute subscriptions", () => {
    const tree = new TopicTree();

    tree.register(
      "ws-1",
      "employees",
      deps({
        attributes: new Set([":employee/name"]),
        entityTypes: new Set(["employee"]),
      }),
    );
    tree.register(
      "ws-2",
      "departments",
      deps({
        attributes: new Set([":department/name"]),
        entityTypes: new Set(["department"]),
      }),
    );

    const affected = tree.findAffected([
      change("emp:alice", ":employee/name"),
      change("dept:eng", ":department/name"),
    ]);

    expect(affected.get("ws-1")).toEqual([change("emp:alice", ":employee/name")]);
    expect(affected.get("ws-2")).toEqual([change("dept:eng", ":department/name")]);
  });

  it("applies entity-id filtering after topic lookup", () => {
    const tree = new TopicTree();

    tree.register(
      "ws-1",
      "alice",
      deps({
        attributes: new Set([":employee/name"]),
        entityTypes: new Set(["employee"]),
        subjectsByAttribute: new Map([[":employee/name", new Set(["emp:alice"])]]),
        boundEntityIds: new Set(["emp:alice"]),
        boundEntityTypes: new Set(["employee"]),
      }),
    );

    const affected = tree.findAffected([
      change("emp:bob", ":employee/name"),
      change("emp:alice", ":employee/name"),
    ]);

    expect(affected.get("ws-1")).toEqual([change("emp:alice", ":employee/name")]);
  });

  it("matches wildcard attribute subscriptions across every namespace", () => {
    const tree = new TopicTree();

    tree.register(
      "ws-1",
      "employee-any-attr",
      deps({
        hasDynamicAttributes: true,
        entityTypes: new Set(["employee"]),
      }),
    );

    const affected = tree.findAffected([
      change("emp:alice", ":employee/name"),
      change("dept:eng", ":department/name"),
    ]);

    expect(affected.get("ws-1")).toEqual([
      change("emp:alice", ":employee/name"),
      change("dept:eng", ":department/name"),
    ]);
  });

  it("removes subscriptions on unregister and disconnect cleanup", () => {
    const tree = new TopicTree();

    tree.register(
      "ws-1",
      "employees",
      deps({
        attributes: new Set([":employee/name"]),
        entityTypes: new Set(["employee"]),
      }),
    );
    tree.register(
      "ws-1",
      "departments",
      deps({
        attributes: new Set([":department/name"]),
        entityTypes: new Set(["department"]),
      }),
    );

    tree.unregister("ws-1", "employees");
    expect(tree.hasSubscriptions("ws-1")).toBe(true);

    tree.removeConnection("ws-1");
    expect(tree.hasSubscriptions("ws-1")).toBe(false);
    expect(tree.findAffected([change("dept:eng", ":department/name")]).size).toBe(0);
  });

  it("deduplicates changes when multiple queries on a connection match", () => {
    const tree = new TopicTree();

    tree.register(
      "ws-1",
      "employee-name",
      deps({
        attributes: new Set([":employee/name"]),
        entityTypes: new Set(["employee"]),
      }),
    );
    tree.register(
      "ws-1",
      "employee-any",
      deps({
        hasDynamicAttributes: true,
        entityTypes: new Set(["employee"]),
      }),
    );

    const affected = tree.findAffected([change("emp:alice", ":employee/name")]);

    expect(affected.get("ws-1")).toEqual([change("emp:alice", ":employee/name")]);
  });
});
