/**
 * Writes a reproducible demo database: two releases, imports from several
 * actors, facts valid from hire and issue dates, certifications that expire,
 * corrections, changes from a date, offboarding, and incident commands whose
 * causation chains Why can follow.
 *
 *   pnpm --filter @triplex-build/triplex-explorer seed -- --sqlite ./explorer.db --fresh
 *
 * Every transaction pins the release it was written under, and values are encoded by
 * the declared entity types. Constraints are not enforced while seeding: the data is
 * valid by construction, and commit-time enforcement currently grows faster than
 * linearly with a type's facts (see the package README). The explorer's own edits
 * enforce the full release.
 */
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { NodeRuntime } from "@effect/platform-node";
import { SqliteTriples } from "@triplex-build/triplex-sqlite";
import {
  Change,
  EntityId,
  Triples,
  ref,
  type TransactOp,
  type TransactionMeta,
  type Triple,
} from "@triplex-internal/core";
import { ConfigStore, EntityType } from "@triplex-internal/core/config";
import { Effect, Layer } from "effect";

import {
  Certification,
  Incident,
  ModelV1,
  ModelV2,
  Placement,
  Site,
  Worker,
  certificationKinds,
  regions,
  roles,
  severities,
} from "./model.js";
import { DAY, firstNames, lastNames, prng, siteNames, summaries } from "./names.js";

const args = process.argv.slice(2);
const target = args[args.indexOf("--sqlite") + 1];
if (!args.includes("--sqlite") || target === undefined) {
  throw new Error("Usage: seed --sqlite <database.db> [--fresh] [--workers 1200]");
}
const filename = resolve(target);
const workerCount = Number(args.includes("--workers") ? args[args.indexOf("--workers") + 1] : 1200);

const random = prng(20261115);
const pick = <A>(values: readonly A[]): A => values[Math.floor(random() * values.length)]!;
const between = (low: number, high: number) => low + Math.floor(random() * (high - low));
const now = Date.now();
const day = (offset: number) => Math.floor((now + offset * DAY) / DAY) * DAY;

const slug = (text: string) => text.toLowerCase().replace(/\W+/g, "-");
const workerId = (index: number) => EntityId.make(`worker:${String(index + 1).padStart(4, "0")}`);

const chunks = <A>(values: readonly A[], size: number): A[][] =>
  Array.from({ length: Math.ceil(values.length / size) }, (_, index) =>
    values.slice(index * size, index * size + size),
  );

const sites = siteNames.map((name, index) => ({
  id: EntityId.make(`site:${slug(name)}`),
  name,
  region: regions[index % regions.length]!,
  capacity: between(40, 400),
  opened: day(-between(950, 1400)),
}));

const workers = Array.from({ length: workerCount }, (_, index) => {
  const name = `${pick(firstNames)} ${pick(lastNames)}`;
  // One worker in twenty is imported with a typo and corrected later.
  const typo = index % 20 === 7 ? name.replace(/([aeiou])/, "$1$1") : null;
  return {
    id: workerId(index),
    name,
    typo: typo === name ? null : typo,
    role: index % 25 === 0 ? ("supervisor" as const) : pick(roles),
    rate: Math.round((22 + random() * 38) * 4) / 4,
    // Supervisors (every 25th worker) join first, so their reports can reference them.
    hired:
      index === 0 ? day(-950) : index % 25 === 0 ? day(-between(900, 940)) : day(-between(60, 880)),
    sites: [...new Set(Array.from({ length: between(1, 4) }, () => pick(sites).id))],
    manager:
      index === 0
        ? null
        : index % 25 === 0
          ? workerId(0)
          : workerId(25 * Math.floor(random() * Math.ceil(index / 25))),
  };
});

const program = Effect.gen(function* () {
  const triples = yield* Triples;
  const config = yield* ConfigStore.ConfigStore;
  if ((yield* config.resolveRef("live")) !== undefined) {
    return yield* Effect.log(`${filename} already has a live release; pass --fresh to rebuild it`);
  }
  let release = "";
  const publish = (label: string, objects: Effect.Success<ReturnType<typeof EntityType.nodesOf>>) =>
    Effect.gen(function* () {
      const snapshot = yield* config.commit({ label, objects, ref: "live" });
      release = snapshot.snapshot.id;
    });
  const commit = (
    meta: Omit<TransactionMeta, "configSnapshot">,
    ops: readonly TransactOp[],
    preconditions: Change.Change["preconditions"] = [],
  ) =>
    triples.transact(ops, {
      ...meta,
      configSnapshot: release,
      ...(preconditions.length === 0 ? {} : { preconditions }),
    });
  const factsOf = (id: EntityId, attribute: string) =>
    Effect.map(triples.entity(id), (all) => all.filter((fact) => fact.attribute === attribute));

  // --- Release 1 ------------------------------------------------------------
  yield* publish("workforce-v1", yield* EntityType.nodesOf(...ModelV1.types));
  yield* commit(
    { actor: "import:erp", commandId: "seed:sites", correlationId: "import:erp:sites" },
    sites.flatMap((site) =>
      Site.assert(
        site.id,
        { name: site.name, region: site.region, capacity: site.capacity, opened: site.opened },
        { validFrom: site.opened },
      ),
    ),
  );

  // Workers arrive in batches from the HR system, each valid from its hire date.
  for (const [batch, group] of chunks(workers, 100).entries()) {
    yield* commit(
      {
        actor: "import:hris",
        commandId: `seed:workers:${batch}`,
        correlationId: "import:hris:2026-q3",
      },
      group.flatMap((worker) =>
        Worker.assert(
          worker.id,
          {
            name: worker.typo ?? worker.name,
            email: `${slug(worker.name).replace(/-/g, ".")}.${worker.id.slice(-4)}@example.com`,
            role: worker.role,
            rate: worker.rate,
            active: true,
            trainedFor: worker.sites,
            ...(worker.manager === null ? {} : { manager: worker.manager }),
          },
          { validFrom: worker.hired },
        ),
      ),
    );
  }

  // Certifications are valid from issue to expiry; some have lapsed, some lapse within weeks.
  const certifications = workers.flatMap((worker, index) =>
    Array.from({ length: between(1, 4) }, (_, n) => {
      const issued = Math.max(worker.hired, day(-between(30, 1000)));
      return {
        id: EntityId.make(`cert:${worker.id.slice(7)}-${n + 1}`),
        worker: worker.id,
        kind: certificationKinds[(index + n) % certificationKinds.length]!,
        number: `C-${String(100000 + index * 7 + n * 131).slice(-6)}-${n + 1}`,
        issuer: pick(["SafeWork Institute", "Northline Training", "OSHA Outreach", "Red Cross"]),
        issued,
        expires: issued + between(180, 1100) * DAY,
      };
    }),
  );
  for (const [batch, group] of chunks(certifications, 200).entries()) {
    yield* commit(
      {
        actor: "sync:lms",
        commandId: `seed:certifications:${batch}`,
        correlationId: "sync:lms:full",
      },
      group.flatMap((cert) =>
        Certification.assert(
          cert.id,
          { worker: cert.worker, kind: cert.kind, number: cert.number, issuer: cert.issuer },
          { validFrom: cert.issued, validTo: cert.expires },
        ),
      ),
    );
  }

  const placements = workers.flatMap((worker, index) =>
    worker.sites.slice(0, index % 3 === 0 ? 2 : 1).map((site, n) => ({
      id: EntityId.make(`placement:${worker.id.slice(7)}-${n + 1}`),
      worker: worker.id,
      site,
      shift: pick(["day", "night"] as const),
      from: worker.hired + between(0, 30) * DAY,
    })),
  );
  for (const [batch, group] of chunks(placements, 150).entries()) {
    yield* commit(
      {
        actor: pick(["user:dana", "user:priya", "scheduler"]),
        commandId: `seed:placements:${batch}`,
      },
      group.flatMap((placement) =>
        Placement.assert(
          placement.id,
          { worker: placement.worker, site: placement.site, shift: placement.shift },
          { validFrom: placement.from },
        ),
      ),
    );
  }

  // Corrections: the import typo was never true, so its whole interval is rewritten.
  for (const worker of workers.filter((candidate) => candidate.typo !== null)) {
    const [name] = yield* factsOf(worker.id, ":worker/name");
    if (name === undefined) continue;
    const change = Worker.correct(name, { name: worker.name });
    yield* commit(
      { actor: "user:dana", commandId: `seed:correct-name:${worker.id}` },
      change.ops,
      change.preconditions,
    );
  }

  // Pay changes take effect from a date; earlier pay stays true for the past.
  for (const worker of workers.filter((_, index) => index % 6 === 1)) {
    const [rate] = yield* factsOf(worker.id, ":worker/hourly-rate");
    if (rate === undefined || rate.value.type !== "number") continue;
    const at = Math.max(rate.validFrom + DAY, day(-between(5, 200)));
    const change = Worker.replace(rate, { rate: Math.round(rate.value.value * 1.06 * 4) / 4 }, at);
    yield* commit(
      {
        actor: "sync:payroll",
        commandId: `seed:rate:${worker.id}`,
        correlationId: "payroll:2026-review",
      },
      change.ops,
      change.preconditions,
    );
  }

  // Offboarding ends a worker's active flag and their placements on one date.
  for (const worker of workers.filter((_, index) => index % 17 === 5)) {
    const leaving = day(-between(3, 120));
    const [active] = yield* factsOf(worker.id, ":worker/active");
    if (active === undefined || leaving <= active.validFrom) continue;
    const found = yield* triples.queryAll({
      find: ["?placement"],
      where: [["?placement", ":placement/worker", ref(worker.id)]],
    });
    const placementFacts: Triple[] = (yield* Effect.forEach(found.results, (row) =>
      triples.entity(EntityId.make(String(row["?placement"]))),
    )).flat();
    const change = Change.combine(
      Worker.replace(active, { active: false }, leaving),
      ...placementFacts
        .filter((fact) => leaving > fact.validFrom)
        .map((fact) => Change.end(fact, leaving)),
    );
    yield* commit(
      {
        actor: "user:priya",
        commandId: `seed:offboard:${worker.id}`,
        correlationId: `offboarding:${worker.id}`,
      },
      change.ops,
      change.preconditions,
    );
  }

  // --- Release 2 adds incidents and phone numbers -----------------------------
  yield* publish("workforce-v2", yield* EntityType.nodesOf(...ModelV2.types));
  for (const [batch, group] of chunks(
    workers.filter((_, index) => index % 4 === 0),
    150,
  ).entries()) {
    yield* commit(
      {
        actor: "import:hris",
        commandId: `seed:phones:${batch}`,
        correlationId: "import:hris:phones",
      },
      group.map((worker) => ({
        op: "assert" as const,
        entityId: worker.id,
        entityType: Worker.entityType,
        attribute: ":worker/phone",
        value: {
          type: "string" as const,
          value: `+1 555 ${between(100, 999)} ${between(1000, 9999)}`,
        },
        validFrom: worker.hired,
      })),
    );
  }

  // Incidents: each step is caused by the command before it, so Why can follow the chain.
  for (let index = 0; index < 160; index++) {
    const id = EntityId.make(`incident:${String(index + 1).padStart(4, "0")}`);
    const site = pick(sites);
    const reporter = pick(workers);
    const report = `incident:${index + 1}:report`;
    const occurred = Math.max(day(-between(1, 80)), reporter.hired);
    yield* commit(
      { actor: "app:field", commandId: report, correlationId: `case:${index + 1}` },
      Incident.assert(
        id,
        {
          site: site.id,
          summary: pick(summaries),
          severity: pick(severities),
          status: "open",
          reportedBy: reporter.id,
        },
        { validFrom: occurred },
      ),
    );
    if (index % 5 === 4) continue;
    const investigate = `incident:${index + 1}:investigate`;
    const [opened] = yield* factsOf(id, ":incident/status");
    const investigating = Math.min(now - DAY, opened!.validFrom + between(1, 4) * DAY);
    if (investigating <= opened!.validFrom) continue;
    const step = Incident.replace(opened!, { status: "investigating" }, investigating);
    yield* commit(
      {
        actor: "user:sam",
        commandId: investigate,
        correlationId: `case:${index + 1}`,
        causationId: report,
      },
      step.ops,
      step.preconditions,
    );
    if (index % 3 === 0) continue;
    const [current] = (yield* factsOf(id, ":incident/status")).filter(
      (fact) => fact.validTo._tag === "None",
    );
    const closing = Math.min(now - 3_600_000, current!.validFrom + between(1, 9) * DAY);
    if (closing <= current!.validFrom) continue;
    const close = Incident.replace(current!, { status: "closed" }, closing);
    yield* commit(
      {
        actor: "user:sam",
        commandId: `incident:${index + 1}:close`,
        correlationId: `case:${index + 1}`,
        causationId: investigate,
      },
      close.ops,
      close.preconditions,
    );
  }

  yield* Effect.log(
    `Seeded ${filename}: ${workers.length} workers, head position ${yield* triples.currentPosition()}`,
  );
});

if (args.includes("--fresh")) {
  for (const suffix of ["", "-wal", "-shm"])
    if (existsSync(`${filename}${suffix}`)) rmSync(`${filename}${suffix}`);
}

program.pipe(
  Effect.provide(ConfigStore.layer.pipe(Layer.provideMerge(SqliteTriples.layer({ filename })))),
  NodeRuntime.runMain,
);
