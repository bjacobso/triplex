import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { renderLlmsFiles } from "../../../../.vitepress/llms.ts";
import { makeStore } from "./facts.ts";
import { correction, firstFact, noEarlierTraining, questions } from "./story.ts";

const mariaTrained = {
  entity: "worker:maria",
  attribute: ":worker/trained",
  value: true,
};

describe("Part 1: A fact is a triple", () => {
  it("returns the opening fact and can run the same program again", () => {
    expect(Effect.runSync(firstFact)).toEqual([mariaTrained]);
    expect(Effect.runSync(firstFact)).toEqual([mariaTrained]);
  });

  it("answers every question quoted in the post", () => {
    const result = Effect.runSync(questions);
    expect(result.trained).toEqual([mariaTrained]);
    expect(result.untrained).toEqual([
      { entity: "worker:lee", attribute: ":worker/trained", value: false },
    ]);
    expect(result.absent).toEqual([]);
    expect(result.all).toEqual([
      { entity: "worker:maria", attribute: ":worker/name", value: "Maria" },
      mariaTrained,
      { entity: "worker:lee", attribute: ":worker/trained", value: false },
    ]);
  });

  it("loses evidence on overwrite, not the copy already read", () => {
    const result = Effect.runSync(correction);
    expect(result.before).toEqual([mariaTrained]);
    expect(result.after).toEqual([{ ...mariaTrained, value: false }]);
    expect(result.evidence).toEqual([]);
    expect(Effect.runSync(noEarlierTraining)).toEqual(result.after);
  });

  it("keeps caller mutations from changing stored facts", () => {
    Effect.runSync(
      Effect.gen(function* () {
        const store = makeStore();
        const input = { ...mariaTrained };
        yield* store.put(input);
        input.value = false;
        const result = yield* store.match({});
        result[0]!.value = false;
        expect(yield* store.match({})).toEqual([mariaTrained]);
      }),
    );
  });

  it("matches exact values, including falsy values, without conflating keys", () => {
    Effect.runSync(
      Effect.gen(function* () {
        const store = makeStore();
        const rows = [
          { entity: "a:b", attribute: "c", value: 0 },
          { entity: "a", attribute: "b:c", value: "0" },
          { entity: "a", attribute: "blank", value: "" },
        ];
        const pending = store.put(rows[0]!);
        expect(yield* store.match({})).toEqual([]);
        yield* pending;
        yield* store.put(rows[1]!);
        yield* store.put(rows[2]!);
        expect(yield* store.match({})).toEqual(rows);
        expect(yield* store.match({ value: 0 })).toEqual([rows[0]]);
        expect(yield* store.match({ value: "" })).toEqual([rows[2]]);
        expect(yield* store.match({ entity: "a", value: 0 })).toEqual([]);
        expect(yield* makeStore().match({})).toEqual([]);
      }),
    );
  });

  it("publishes nested blog pages as Markdown with resolved code regions", async () => {
    const docs = resolve(import.meta.dirname, "../../../..");
    const files = await renderLlmsFiles(docs, []);
    const part = files.get("blog/remembers-why/01-a-fact-is-a-triple.md")!;
    expect(part).toContain("export type Value = string | number | boolean;");
    expect(part).toContain("export const correction");
    expect(part).not.toContain("<<<");
    expect(files.get("llms.txt")).toContain(
      "https://triplex.build/blog/remembers-why/01-a-fact-is-a-triple.md",
    );
    expect(files.get("blog/index.md")).toContain("The Database That Remembers Why");
    const source = await readFile(
      resolve(docs, "blog/remembers-why/01-a-fact-is-a-triple.md"),
      "utf8",
    );
    expect(source).not.toContain("```");
  });
});
