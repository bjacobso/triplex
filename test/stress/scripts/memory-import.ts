/**
 * In-memory commit benchmark: load a large account into `KvTriples` and read it back.
 *
 * Shape: 25 scalar attributes, 16 facts per subject, valid-time intervals, and a closed interval
 * followed by its replacement on two attributes of every subject. Each size runs in a fresh Node
 * process so heap figures don't leak between runs.
 *
 *   pnpm --filter triplex-stress benchmark:memory
 *   MEMORY_BENCH_SIZES=16000 MEMORY_BENCH_MODES=transact pnpm --filter triplex-stress benchmark:memory
 *
 * Modes:
 * - `transact`: one `Triples.transact` with every assert (what WorldVM does today).
 * - `chunked`:  `MEMORY_BENCH_CHUNK` asserts per `transact`, yielding between chunks.
 * - `import`:   `Import.run` with the summary journal, publishing a `PositionRef`; the read
 *               resolves the ref and reads at its position.
 * - `segments`: build one `Segment` per chunk and attach it (what `Import.run` does with
 *               `store: "segments"`), timing build and attach apart, then publish the ref.
 * - `image`:    one prebuilt segment of everything, encoded ahead of time like a shipped
 *               dataset; time decoding it, attaching it and publishing the ref.
 * The last three need a build with the `operational` modules; `main` runs the first two.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Effect, Layer, ManagedRuntime } from "effect";
import {
  KvTriples,
  Triples,
  boolean,
  number,
  string,
  type EntityId,
  type TransactAssertOp,
  type TripleValue,
} from "@triplex-build/triplex";

const ATTRIBUTES = 25;
const FACTS_PER_SUBJECT = 16;
const DAY = 86_400_000;
const EPOCH = Date.UTC(2020, 0, 1);
const READ_AT = Date.UTC(2024, 6, 1);

type Mode = "transact" | "chunked" | "import" | "segments" | "image";
const MODES: readonly Mode[] = ["transact", "chunked", "import", "segments", "image"];

interface Result {
  readonly mode: Mode;
  readonly facts: number;
  /** Sorting and indexing segments: work that can run off the main thread. */
  readonly buildMs: number;
  /** Transactions, attaches and the ref move: work on the store. */
  readonly commitMs: number;
  readonly transactions: number;
  /** The first `match` at the published ref, then the full read. */
  readonly firstReadMs: number;
  readonly readMs: number;
  readonly readFacts: number;
  readonly heapBeforeMb: number;
  readonly heapAfterMb: number;
  readonly bytesPerFact: number;
  readonly peakRssMb: number;
}

const attribute = (index: number) => `:bench/a${String(index).padStart(2, "0")}`;

const valueFor = (subject: number, attr: number, version: number): TripleValue =>
  attr % 3 === 0
    ? string(`value-${subject % 997}-${attr}-${version}`)
    : attr % 3 === 1
      ? number((subject * 31 + attr * 7 + version) % 10_000)
      : boolean((subject + attr + version) % 2 === 0);

/** 14 attributes per subject; the first two get a closed interval and its successor. */
export const generate = (facts: number): readonly TransactAssertOp[] => {
  const subjects = Math.ceil(facts / FACTS_PER_SUBJECT);
  const ops: TransactAssertOp[] = [];
  for (let s = 0; s < subjects; s++) {
    const entityId = `worker:${String(s).padStart(6, "0")}` as EntityId;
    const start = EPOCH + (s % 1_000) * DAY;
    for (let k = 0; k < FACTS_PER_SUBJECT - 2; k++) {
      const attr = (s + k) % ATTRIBUTES;
      if (k < 2) {
        const change = start + (200 + ((s * 13 + k) % 900)) * DAY;
        ops.push(
          {
            op: "assert",
            entityId,
            attribute: attribute(attr),
            value: valueFor(s, attr, 0),
            entityType: "Worker",
            validFrom: start,
            validTo: change,
          },
          {
            op: "assert",
            entityId,
            attribute: attribute(attr),
            value: valueFor(s, attr, 1),
            entityType: "Worker",
            validFrom: change,
          },
        );
      } else {
        ops.push({
          op: "assert",
          entityId,
          attribute: attribute(attr),
          value: valueFor(s, attr, 0),
          entityType: "Worker",
          validFrom: start,
        });
      }
    }
  }
  return ops;
};

const heapMb = () => {
  globalThis.gc?.();
  globalThis.gc?.();
  // Typed-array and Buffer backing stores live outside the V8 heap but count against a tab.
  const { heapUsed, arrayBuffers } = process.memoryUsage();
  return (heapUsed + arrayBuffers) / 1_048_576;
};

// Let other work run between chunks, as a browser import would.
const yieldToHost = () => new Promise((resolve) => setImmediate(resolve));

const runOne = async (mode: Mode, facts: number, chunk: number): Promise<Result> => {
  const ops = generate(facts);
  const runtime = ManagedRuntime.make(KvTriples.layer as Layer.Layer<Triples>);
  const triples = await runtime.runPromise(Effect.service(Triples));
  // Loaded lazily so the same script still measures builds without these modules.
  const operational: Partial<typeof import("@triplex-build/triplex/operational")> =
    await import("@triplex-build/triplex/operational");
  const { Import, PositionRef, Segment } = operational;
  if (mode !== "transact" && mode !== "chunked" && (!Import || !PositionRef || !Segment)) {
    throw new Error(`This build can't run the ${mode} mode`);
  }
  const heapBeforeMb = heapMb();
  // A shipped dataset is encoded ahead of time, outside the timing; its bytes count as heap.
  const image = mode === "image" ? Segment!.encode(Segment!.build(ops)) : undefined;

  let buildMs = 0;
  let commitMs = 0;
  let transactions = 0;
  const time = async <A>(into: "build" | "commit", work: () => A | Promise<A>): Promise<A> => {
    const started = performance.now();
    const result = await work();
    if (into === "build") buildMs += performance.now() - started;
    else commitMs += performance.now() - started;
    return result;
  };
  const publish = () =>
    time("commit", () =>
      runtime.runPromise(
        Effect.flatMap(triples.currentPosition(), (position) =>
          PositionRef!.move(triples, { name: "bench/live", position }),
        ),
      ),
    );

  if (mode === "transact") {
    await time("commit", () => runtime.runPromise(triples.transact(ops, { actor: "bench" })));
    transactions = 1;
  } else if (mode === "chunked") {
    for (let offset = 0; offset < ops.length; offset += chunk) {
      await time("commit", () =>
        runtime.runPromise(triples.transact(ops.slice(offset, offset + chunk), { actor: "bench" })),
      );
      transactions++;
      await yieldToHost();
    }
  } else if (mode === "import") {
    const result = await time("commit", () =>
      runtime.runPromise(
        Import!.run(triples, ops, {
          chunkSize: chunk,
          ref: "bench/live",
          meta: { actor: "bench" },
        }),
      ),
    );
    transactions = result.chunks + 1;
  } else if (mode === "segments") {
    for (let offset = 0; offset < ops.length; offset += chunk) {
      const segment = await time("build", () => Segment!.build(ops.slice(offset, offset + chunk)));
      await time("commit", () =>
        runtime.runPromise(Segment!.attach(triples, segment, { actor: "bench" })),
      );
      transactions++;
      await yieldToHost();
    }
    await publish();
    transactions++;
  } else {
    const segment = await time("commit", () => Segment!.decode(image!));
    await time("commit", () =>
      runtime.runPromise(Segment!.attach(triples, segment, { actor: "bench" })),
    );
    await publish();
    transactions = 2;
  }

  const basis =
    mode === "transact" || mode === "chunked"
      ? { validAt: READ_AT }
      : await runtime.runPromise(PositionRef!.basis(triples, "bench/live", { validAt: READ_AT }));
  const readStarted = performance.now();
  let firstReadMs = 0;
  let readFacts = 0;
  for (let a = 0; a < ATTRIBUTES; a++) {
    const rows = await runtime.runPromise(triples.match({ attribute: attribute(a) }, basis));
    if (a === 0) firstReadMs = performance.now() - readStarted;
    readFacts += rows.length;
  }
  const readMs = performance.now() - readStarted;
  const heapAfterMb = heapMb();
  await runtime.dispose();

  return {
    mode,
    facts: ops.length,
    buildMs,
    commitMs,
    transactions,
    firstReadMs,
    readMs,
    readFacts,
    heapBeforeMb,
    heapAfterMb,
    bytesPerFact: ((heapAfterMb - heapBeforeMb) * 1_048_576) / ops.length,
    peakRssMb: process.resourceUsage().maxRSS / 1024,
  };
};

const fmt = (n: number, digits = 0) =>
  n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

const row = (r: Result) =>
  `| ${r.mode} | ${fmt(r.facts)} | ${fmt(r.transactions)} | ${r.buildMs === 0 ? "" : `${fmt(r.buildMs)} ms`} | ${fmt(r.commitMs)} ms | ${fmt(((r.buildMs + r.commitMs) * 1000) / r.facts, 1)} | ${fmt(r.firstReadMs, 1)} ms | ${fmt(r.readMs)} ms | ${fmt(r.readFacts)} | ${fmt(r.heapBeforeMb)} → ${fmt(r.heapAfterMb)} MB | ${fmt(r.bytesPerFact)} | ${fmt(r.peakRssMb)} MB |`;

const main = async () => {
  const child = process.env["MEMORY_BENCH_CHILD"];
  const chunk = Number(process.env["MEMORY_BENCH_CHUNK"] ?? 4_000);
  if (child !== undefined) {
    const [mode, facts] = child.split(":") as [Mode, string];
    const result = await runOne(mode, Number(facts), chunk);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  const sizes = (process.env["MEMORY_BENCH_SIZES"] ?? "16000,80000,160000").split(",").map(Number);
  const modes = (process.env["MEMORY_BENCH_MODES"]?.split(",") ?? MODES) as Mode[];
  const self = fileURLToPath(import.meta.url);
  const heapLimitMb = Number(process.env["MEMORY_BENCH_HEAP_MB"] ?? 4_096);
  const rows: string[] = [];
  for (const facts of sizes) {
    for (const mode of modes) {
      const run = spawnSync(
        process.execPath,
        ["--expose-gc", `--max-old-space-size=${heapLimitMb}`, "--import", "tsx", self],
        {
          env: { ...process.env, MEMORY_BENCH_CHILD: `${mode}:${facts}` },
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      if (run.status !== 0) {
        // A browser tab dies the same way; record it rather than abort the other sizes.
        const reason = /heap out of memory/.test(run.stderr)
          ? `out of memory (${fmt(heapLimitMb)} MB heap)`
          : `failed (${run.signal ?? run.status})`;
        process.stderr.write(`${mode} ${fmt(facts)} facts: ${reason}\n${run.stderr.slice(-2_000)}`);
        rows.push(`| ${mode} | ${fmt(facts)} | | | ${reason} | | | | | | | |`);
        continue;
      }
      const result = JSON.parse(run.stdout.trim().split("\n").at(-1)!) as Result;
      rows.push(row(result));
      process.stderr.write(
        `${mode} ${fmt(result.facts)} facts: build ${fmt(result.buildMs)} ms, commit ${fmt(result.commitMs)} ms, read ${fmt(result.readMs)} ms\n`,
      );
    }
  }

  const lines = [
    `Node ${process.version}, ${fmt(heapLimitMb)} MB heap limit, chunk ${fmt(chunk)} facts, read at one validAt over ${ATTRIBUTES} attributes`,
    "",
    "| Mode | Facts | Txs | Build | Commit | µs/fact | First read | Read | Facts read | Memory after GC | Bytes/fact | Peak RSS |",
    "| ---- | ----: | --: | ----: | -----: | ------: | ---------: | ---: | ---------: | --------------: | ---------: | -------: |",
    ...rows,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
};

await main();
