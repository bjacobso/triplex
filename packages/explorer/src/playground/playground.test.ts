import { describe, expect, it } from "vitest";

import { decodeHash, encodeBundle, type Bundle } from "./bundle.js";
import { exampleBundle } from "./example.js";
import { instantOf, openPlayground } from "./runtime.js";

const queryNamed = (name: string) => exampleBundle.queries.find((query) => query.name === name)!;

describe("playground bundles", () => {
  it("round-trip through a link hash", async () => {
    const hash = await encodeBundle(exampleBundle);
    expect(hash.startsWith("#bundle=")).toBe(true);
    expect(hash.slice("#bundle=".length)).not.toMatch(/[+/=]/);
    expect(await decodeHash(hash)).toEqual(exampleBundle);
    expect(await decodeHash("#other")).toBeNull();
    await expect(decodeHash("#bundle=AAAA")).rejects.toThrow(/damaged/);
  });

  it("build the example database and answer its queries at the requested valid time", async () => {
    const db = await openPlayground(exampleBundle);
    try {
      expect(db.problems).toEqual([]);
      expect(db.commands).toBe(exampleBundle.seed.length);

      const uncertified = queryNamed("Placed without a forklift certificate").query;
      const names = async (validAt: number) =>
        (await db.query(uncertified, { validAt })).rows.map((row) => row["?name"]).sort();
      // Maria's forklift certificate expires in 14 days.
      expect(await names(Date.now())).toEqual(["Ines Okafor", "Tomas Reyes"]);
      expect(await names(instantOf("+30d"))).toEqual(["Ines Okafor", "Maria Chen", "Tomas Reyes"]);

      const headcount = await db.query(queryNamed("Headcount by site").query, {});
      expect(headcount.rows).toEqual([
        { "?site": "Harbor Yard", "?workers": 2 },
        { "?site": "Ridge Plant", "?workers": 1 },
      ]);

      const rates = async (validAt: number) =>
        (await db.query(queryNamed("Who set each hourly rate").query, { validAt })).rows.find(
          (row) => row["?name"] === "Maria Chen",
        );
      expect(await rates(Date.now())).toMatchObject({ "?rate": 33.5, "?actor": "sync:payroll" });
      // Replacing from a date re-asserts the earlier value for the past in the same transaction.
      expect(await rates(instantOf("-60d"))).toMatchObject({
        "?rate": 31,
        "?actor": "sync:payroll",
      });
      expect(await rates(instantOf("-200d"))).toMatchObject({ "?rate": 31 });
    } finally {
      await db.dispose();
    }
  });

  it("report a rejected seed command and an unknown query attribute instead of throwing", async () => {
    const bundle: Bundle = {
      ...exampleBundle,
      seed: [
        ...exampleBundle.seed,
        {
          actor: "user:typo",
          create: [{ type: "Placement", id: "placement:ghost", values: { worker: "worker:ines" } }],
        },
      ],
    };
    const db = await openPlayground(bundle);
    try {
      expect(db.problems).toHaveLength(1);
      expect(db.problems[0]).toMatch(/^Seed command 6 \(user:typo\)/);
      expect(db.commands).toBe(exampleBundle.seed.length);
      await expect(
        db.query({ find: ["?n"], where: [["?w", ":worker/nmae", "?n"]] }, {}),
      ).rejects.toThrow(/:worker\/name/);
    } finally {
      await db.dispose();
    }
  });
});
