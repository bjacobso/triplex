import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Stream } from "effect";
import {
  KvTripleStore,
  createKvTripleStore,
  type Datom,
} from "../../../src/kv/hexastore/KvTripleStore.js";
import { makeTestKvBackend } from "../../../src/kv/kv/InMemoryKvBackend.js";
import type { KvBackendService } from "../../../src/kv/kv/KvBackend.js";
import type { TripleValue } from "@triplex-build/triplex";

// ─── Helpers ───────────────────────────────────────────────────────────────

const str = (value: string): TripleValue => ({ type: "string", value });
const num = (value: number): TripleValue => ({ type: "number", value });
const bool = (value: boolean): TripleValue => ({ type: "boolean", value });
const ref = (value: string): TripleValue => ({ type: "ref", value });

let counter = 0;
const makeDatom = (overrides: Partial<Datom> = {}): Datom => {
  const recordedAt = overrides.recordedAt ?? 1000;
  return {
    tripleId: `triple-${++counter}`,
    entity: "emp:alice",
    attribute: ":employee/name",
    value: str("Alice"),
    txId: "tx:1",
    recordedAt,
    recordedPosition: overrides.recordedPosition ?? 1,
    validFrom: overrides.validFrom ?? recordedAt,
    validTo: null,
    createdBy: null,
    retractedAt: null,
    retractedPosition: null,
    retractTxId: null,
    entityType: null,
    ...overrides,
  };
};

const run = <A>(effect: Effect.Effect<A>): Promise<A> => Effect.runPromise(effect);

const collect = <A>(stream: Stream.Stream<A>): Effect.Effect<A[]> =>
  Stream.runCollect(stream).pipe(Effect.map((chunk) => Array.from(chunk)));

// ─── Test setup ────────────────────────────────────────────────────────────

let kv: KvBackendService;
let store: KvTripleStore;

beforeEach(() => {
  counter = 0;
  kv = makeTestKvBackend();
  store = createKvTripleStore(kv);
});

// ─── Assert ────────────────────────────────────────────────────────────────

describe("assert", () => {
  it("stores a datom and retrieves it by id", async () => {
    const datom = makeDatom();
    await run(store.assert(datom));

    const result = await run(store.getById(datom.tripleId));
    expect(result).toEqual(datom);
  });

  it("stores multiple datoms independently", async () => {
    const d1 = makeDatom({ entity: "emp:alice", attribute: ":employee/name", value: str("Alice") });
    const d2 = makeDatom({ entity: "emp:bob", attribute: ":employee/name", value: str("Bob") });

    await run(store.assert(d1));
    await run(store.assert(d2));

    expect(await run(store.getById(d1.tripleId))).toEqual(d1);
    expect(await run(store.getById(d2.tripleId))).toEqual(d2);
  });

  it("getById returns null for non-existent tripleId", async () => {
    const result = await run(store.getById("non-existent"));
    expect(result).toBeNull();
  });

  it("round-trips strings larger than 64 KiB", async () => {
    const value = "x".repeat(70_000);
    const datom = makeDatom({ value: str(value) });
    await run(store.assert(datom));
    store.clearCache();

    expect(await run(store.getById(datom.tripleId))).toEqual(datom);
  });
});

// ─── AssertBatch ───────────────────────────────────────────────────────────

describe("assertBatch", () => {
  it("stores multiple datoms in one transaction", async () => {
    const d1 = makeDatom({ entity: "emp:alice", attribute: ":employee/name", value: str("Alice") });
    const d2 = makeDatom({ entity: "emp:bob", attribute: ":employee/name", value: str("Bob") });
    const d3 = makeDatom({ entity: "emp:alice", attribute: ":employee/age", value: num(30) });

    await run(store.assertBatch([d1, d2, d3]));

    expect(await run(store.getById(d1.tripleId))).toEqual(d1);
    expect(await run(store.getById(d2.tripleId))).toEqual(d2);
    expect(await run(store.getById(d3.tripleId))).toEqual(d3);
  });

  it("empty batch is a no-op", async () => {
    await run(store.assertBatch([]));
    // No error
  });

  it("keeps duplicate EAVT values with distinct triple identities", async () => {
    const d1 = makeDatom({ value: str("same"), txId: "tx:same" });
    const d2 = makeDatom({ value: str("same"), txId: "tx:same" });
    await run(store.assertBatch([d1, d2]));

    const results = await run(
      collect(store.scan({ entity: d1.entity, attribute: d1.attribute, value: str("same") })),
    );
    expect(results.map((datom) => datom.tripleId).sort()).toEqual(
      [d1.tripleId, d2.tripleId].sort(),
    );
  });
});

// ─── Retract ───────────────────────────────────────────────────────────────

describe("retract", () => {
  it("marks a datom as retracted", async () => {
    const datom = makeDatom();
    await run(store.assert(datom));

    const retracted = await run(store.retract(datom.tripleId, 2000, "tx:2", 2));
    expect(retracted).toBe(true);

    const result = await run(store.getById(datom.tripleId));
    expect(result!.retractedAt).toBe(2000);
    expect(result!.retractTxId).toBe("tx:2");
  });

  it("returns false for non-existent triple", async () => {
    const result = await run(store.retract("non-existent", 2000, "tx:2", 2));
    expect(result).toBe(false);
  });

  it("returns false for already-retracted triple", async () => {
    const datom = makeDatom();
    await run(store.assert(datom));
    await run(store.retract(datom.tripleId, 2000, "tx:2", 2));

    const result = await run(store.retract(datom.tripleId, 3000, "tx:3", 3));
    expect(result).toBe(false);
  });

  it("retracted datoms are excluded from default scans", async () => {
    const d1 = makeDatom({ entity: "emp:alice", attribute: ":employee/name", value: str("Alice") });
    const d2 = makeDatom({ entity: "emp:alice", attribute: ":employee/age", value: num(30) });

    await run(store.assertBatch([d1, d2]));
    await run(store.retract(d1.tripleId, 2000, "tx:2", 2));

    const results = await run(collect(store.scan({ entity: "emp:alice" })));
    expect(results.length).toBe(1);
    expect(results[0]!.tripleId).toBe(d2.tripleId);
  });

  it("retracted datoms included with includeRetracted option", async () => {
    const d1 = makeDatom({ entity: "emp:alice", attribute: ":employee/name", value: str("Alice") });
    const d2 = makeDatom({ entity: "emp:alice", attribute: ":employee/age", value: num(30) });

    await run(store.assertBatch([d1, d2]));
    await run(store.retract(d1.tripleId, 2000, "tx:2", 2));

    const results = await run(
      collect(store.scan({ entity: "emp:alice" }, { includeRetracted: true })),
    );
    expect(results.length).toBe(2);
  });
});

// ─── Scan ──────────────────────────────────────────────────────────────────

describe("scan", () => {
  const alice = makeDatom({
    entity: "emp:alice",
    attribute: ":employee/name",
    value: str("Alice"),
    txId: "tx:1",
  });
  const aliceAge = makeDatom({
    entity: "emp:alice",
    attribute: ":employee/age",
    value: num(30),
    txId: "tx:1",
  });
  const bob = makeDatom({
    entity: "emp:bob",
    attribute: ":employee/name",
    value: str("Bob"),
    txId: "tx:1",
  });
  const bobAge = makeDatom({
    entity: "emp:bob",
    attribute: ":employee/age",
    value: num(25),
    txId: "tx:1",
  });

  beforeEach(async () => {
    await run(store.assertBatch([alice, aliceAge, bob, bobAge]));
  });

  it("scans by entity", async () => {
    const results = await run(collect(store.scan({ entity: "emp:alice" })));
    expect(results.length).toBe(2);
    expect(results.map((d) => d.attribute).sort()).toEqual([":employee/age", ":employee/name"]);
  });

  it("scans by entity + attribute", async () => {
    const results = await run(
      collect(store.scan({ entity: "emp:alice", attribute: ":employee/name" })),
    );
    expect(results.length).toBe(1);
    expect(results[0]!.tripleId).toBe(alice.tripleId);
  });

  it("scans by attribute only", async () => {
    const results = await run(collect(store.scan({ attribute: ":employee/name" })));
    expect(results.length).toBe(2);
    expect(results.map((d) => d.entity).sort()).toEqual(["emp:alice", "emp:bob"]);
  });

  it("scans by attribute + value", async () => {
    const results = await run(
      collect(store.scan({ attribute: ":employee/name", value: str("Alice") })),
    );
    expect(results.length).toBe(1);
    expect(results[0]!.entity).toBe("emp:alice");
  });

  it("scans all datoms with empty pattern", async () => {
    const results = await run(collect(store.scan({})));
    expect(results.length).toBe(4);
  });

  it("returns empty for no-match pattern", async () => {
    const results = await run(collect(store.scan({ entity: "emp:charlie" })));
    expect(results.length).toBe(0);
  });
});

// ─── Ref values and VAET index ─────────────────────────────────────────────

describe("ref values", () => {
  it("stores ref datoms in VAET index for reverse lookups", async () => {
    const d1 = makeDatom({
      entity: "emp:alice",
      attribute: ":employee/department",
      value: ref("dept:engineering"),
    });
    const d2 = makeDatom({
      entity: "emp:bob",
      attribute: ":employee/department",
      value: ref("dept:engineering"),
    });
    const d3 = makeDatom({
      entity: "emp:charlie",
      attribute: ":employee/department",
      value: ref("dept:sales"),
    });

    await run(store.assertBatch([d1, d2, d3]));

    // Scan by value (ref) — uses VAET index
    const results = await run(collect(store.scan({ value: ref("dept:engineering") })));
    expect(results.length).toBe(2);
    expect(results.map((d) => d.entity).sort()).toEqual(["emp:alice", "emp:bob"]);
  });
});

// ─── Temporal scan ─────────────────────────────────────────────────────────

describe("scanTemporal", () => {
  it("shows datoms active at a given time", async () => {
    const d1 = makeDatom({
      entity: "emp:alice",
      attribute: ":employee/name",
      value: str("Alice"),
      recordedAt: 1000,
    });

    await run(store.assert(d1));
    await run(store.retract(d1.tripleId, 3000, "tx:2", 2));

    // Before creation → nothing
    const before = await run(
      collect(store.scanTemporal({ entity: "emp:alice" }, { recordedAt: 500, validAt: 500 })),
    );
    expect(before.length).toBe(0);

    // After creation, before retraction → visible
    const during = await run(
      collect(store.scanTemporal({ entity: "emp:alice" }, { recordedAt: 2000, validAt: 2000 })),
    );
    expect(during.length).toBe(1);
    expect(during[0]!.tripleId).toBe(d1.tripleId);

    // At retraction time → not visible (retractedAt is exclusive: retractedAt > asOf)
    const atRetraction = await run(
      collect(store.scanTemporal({ entity: "emp:alice" }, { recordedAt: 3000, validAt: 3000 })),
    );
    expect(atRetraction.length).toBe(0);

    // After retraction → not visible
    const after = await run(
      collect(store.scanTemporal({ entity: "emp:alice" }, { recordedAt: 5000, validAt: 5000 })),
    );
    expect(after.length).toBe(0);
  });

  it("shows multiple datom versions over time", async () => {
    const v1 = makeDatom({
      entity: "emp:alice",
      attribute: ":employee/name",
      value: str("Alice"),
      recordedAt: 1000,
      txId: "tx:1",
    });
    const v2 = makeDatom({
      entity: "emp:alice",
      attribute: ":employee/name",
      value: str("Alice Smith"),
      recordedAt: 2000,
      txId: "tx:2",
    });

    await run(store.assert(v1));
    await run(store.assert(v2));
    // Retract old value at time of new assertion
    await run(store.retract(v1.tripleId, 2000, "tx:2", 2));

    // At t=1500, only v1 is visible
    const at1500 = await run(
      collect(
        store.scanTemporal(
          { entity: "emp:alice", attribute: ":employee/name" },
          { recordedAt: 1500, validAt: 1500 },
        ),
      ),
    );
    expect(at1500.length).toBe(1);
    expect((at1500[0]!.value as { value: string }).value).toBe("Alice");

    // At t=2500, only v2 is visible
    const at2500 = await run(
      collect(
        store.scanTemporal(
          { entity: "emp:alice", attribute: ":employee/name" },
          { recordedAt: 2500, validAt: 2500 },
        ),
      ),
    );
    expect(at2500.length).toBe(1);
    expect((at2500[0]!.value as { value: string }).value).toBe("Alice Smith");
  });
});

// ─── getEntity / entityHistory ─────────────────────────────────────────────

describe("getEntity and entityHistory", () => {
  it("getEntity returns all active datoms for an entity", async () => {
    const d1 = makeDatom({ entity: "emp:alice", attribute: ":employee/name", value: str("Alice") });
    const d2 = makeDatom({ entity: "emp:alice", attribute: ":employee/age", value: num(30) });
    const d3 = makeDatom({ entity: "emp:bob", attribute: ":employee/name", value: str("Bob") });

    await run(store.assertBatch([d1, d2, d3]));

    const results = await run(collect(store.getEntity("emp:alice")));
    expect(results.length).toBe(2);
    expect(results.every((d) => d.entity === "emp:alice")).toBe(true);
  });

  it("entityHistory includes retracted datoms", async () => {
    const d1 = makeDatom({ entity: "emp:alice", attribute: ":employee/name", value: str("Alice") });
    const d2 = makeDatom({
      entity: "emp:alice",
      attribute: ":employee/name",
      value: str("Alice Smith"),
    });

    await run(store.assert(d1));
    await run(store.retract(d1.tripleId, 2000, "tx:2", 2));
    await run(store.assert(d2));

    const history = await run(collect(store.entityHistory("emp:alice")));
    expect(history.length).toBe(2);
    expect(history.some((d) => d.retractedAt !== null)).toBe(true);
    expect(history.some((d) => d.retractedAt === null)).toBe(true);
  });
});

// ─── Value types ───────────────────────────────────────────────────────────

describe("various value types", () => {
  it("handles boolean values", async () => {
    const datom = makeDatom({ attribute: ":employee/active", value: bool(true) });
    await run(store.assert(datom));

    const result = await run(store.getById(datom.tripleId));
    expect(result!.value).toEqual({ type: "boolean", value: true });
  });

  it("handles number values", async () => {
    const datom = makeDatom({ attribute: ":employee/salary", value: num(95000.5) });
    await run(store.assert(datom));

    const result = await run(store.getById(datom.tripleId));
    expect(result!.value).toEqual({ type: "number", value: 95000.5 });
  });

  it("handles datetime values", async () => {
    const ts = Date.now();
    const datom = makeDatom({
      attribute: ":employee/startDate",
      value: { type: "datetime", value: ts },
    });
    await run(store.assert(datom));

    const result = await run(store.getById(datom.tripleId));
    expect(result!.value).toEqual({ type: "datetime", value: ts });
  });

  it("handles json values", async () => {
    const jsonVal: TripleValue = { type: "json", value: { skills: ["ts", "rust"] } };
    const datom = makeDatom({ attribute: ":employee/metadata", value: jsonVal });
    await run(store.assert(datom));

    const result = await run(store.getById(datom.tripleId));
    expect(result!.value).toEqual(jsonVal);
  });

  it("handles blob values", async () => {
    const blobVal: TripleValue = {
      type: "blob",
      value: "sha256:abc123",
      mimeType: "image/png",
      size: 1024,
    };
    const datom = makeDatom({ attribute: ":employee/photo", value: blobVal });
    await run(store.assert(datom));

    const result = await run(store.getById(datom.tripleId));
    expect(result!.value).toEqual(blobVal);
  });
});
