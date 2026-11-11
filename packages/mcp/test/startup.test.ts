import { Effect } from "effect";
import { expect, it } from "vitest";
import { parseOptions } from "../src/startup.js";

it("parses CLI-compatible backend flags and environment defaults", async () => {
  expect(await Effect.runPromise(parseOptions([], {}))).toEqual({
    sqlite: "./triplex.sqlite",
    dataDir: "./data",
  });
  expect(
    await Effect.runPromise(
      parseOptions(["--sqlite", "app.db", "--database-id", "app", "--data-dir", "/data"], {}),
    ),
  ).toEqual({ sqlite: "app.db", databaseId: "app", dataDir: "/data" });
  expect(
    await Effect.runPromise(
      parseOptions(["--postgres-url", "postgres://explicit/app"], {
        TRIPLEX_POSTGRES_URL: "postgres://env/app",
      }),
    ),
  ).toMatchObject({ postgresUrl: "postgres://explicit/app" });
  expect(
    await Effect.runPromise(parseOptions([], { TRIPLEX_POSTGRES_URL: "postgres://env/app" })),
  ).toMatchObject({ postgresUrl: "postgres://env/app" });
});

it("rejects unknown flags, missing values and unsafe database IDs", async () => {
  for (const args of [
    ["--unknown"],
    ["--sqlite"],
    ["--database-id", "../escape"],
    ["--sqlite", "--database-id", "app"],
  ]) {
    expect((await Effect.runPromise(parseOptions(args, {}).pipe(Effect.result)))._tag).toBe(
      "Failure",
    );
  }
});
