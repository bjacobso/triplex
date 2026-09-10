<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { Effect, ManagedRuntime, Option, Schema } from "effect";
import {
  DatalogQuery,
  EntityId,
  KvTriples,
  TransactRequest,
  Triples,
  ref as reference,
  string,
  type TransactionRecord,
  type Triple,
  type TripleId,
} from "@triplex-build/triplex";

type Runtime = ManagedRuntime.ManagedRuntime<Triples, never>;

interface Domain {
  readonly label: string;
  readonly description: string;
  readonly question: string;
  readonly action: string;
  readonly explanation: string;
  readonly empty: string;
  readonly focusEntity: string;
  readonly operations: ReadonlyArray<(typeof TransactRequest.Type)["operations"][number]>;
  readonly query: object;
  readonly transaction: object;
}

const domains: Record<string, Domain> = {
  learning: {
    label: "Learning",
    description: "Mina submitted a quiz. Give it a score and watch it leave the grading queue.",
    question: "Which submissions need grading?",
    action: "Grade Mina’s quiz",
    explanation:
      "Adding a score makes this submission stop matching the query. The submission stays in the database.",
    empty: "No submissions need grading. The query finds submitted work without a score.",
    focusEntity: "submission:mina-temporal-data",
    operations: [
      {
        op: "assert",
        entityId: EntityId.make("student:mina"),
        entityType: "Student",
        attribute: ":person/name",
        value: string("Mina Patel"),
      },
      {
        op: "assert",
        entityId: EntityId.make("quiz:temporal-data"),
        entityType: "Quiz",
        attribute: ":quiz/title",
        value: string("Temporal data"),
      },
      {
        op: "assert",
        entityId: EntityId.make("submission:mina-temporal-data"),
        entityType: "Submission",
        attribute: ":submission/student",
        value: reference(EntityId.make("student:mina")),
      },
      {
        op: "assert",
        entityId: EntityId.make("submission:mina-temporal-data"),
        entityType: "Submission",
        attribute: ":submission/quiz",
        value: reference(EntityId.make("quiz:temporal-data")),
      },
      {
        op: "assert",
        entityId: EntityId.make("submission:mina-temporal-data"),
        entityType: "Submission",
        attribute: ":submission/status",
        value: string("submitted"),
      },
    ],
    query: {
      find: ["?submission", "?studentName", "?quizTitle"],
      where: [
        ["?submission", ":submission/status", "submitted"],
        ["?submission", ":submission/student", "?student"],
        ["?student", ":person/name", "?studentName"],
        ["?submission", ":submission/quiz", "?quiz"],
        ["?quiz", ":quiz/title", "?quizTitle"],
        ["not", ["?submission", ":submission/score", "?score"]],
      ],
      orderBy: [{ variable: "?submission", direction: "asc" }],
    },
    transaction: {
      operations: [
        {
          op: "assert",
          entityId: "submission:mina-temporal-data",
          entityType: "Submission",
          attribute: ":submission/score",
          value: { type: "number", value: 92 },
        },
      ],
      meta: {
        actor: "user:playground",
        commandId: "playground/grade-mina/v1",
      },
    },
  },
  compliance: {
    label: "Site compliance",
    description:
      "Maria is assigned to Harbor. Record her safety training and watch the outstanding requirement clear.",
    question: "Who still needs safety training?",
    action: "Record Maria’s training",
    explanation:
      "Linking a training record to Maria and Harbor satisfies this query’s missing-training check.",
    empty:
      "No placements are missing training. The query checks for training that matches both worker and site.",
    focusEntity: "training:maria-harbor",
    operations: [
      {
        op: "assert",
        entityId: EntityId.make("worker:maria"),
        entityType: "Worker",
        attribute: ":worker/name",
        value: string("Maria"),
      },
      {
        op: "assert",
        entityId: EntityId.make("site:harbor"),
        entityType: "Site",
        attribute: ":site/name",
        value: string("Harbor"),
      },
      {
        op: "assert",
        entityId: EntityId.make("placement:maria-harbor"),
        entityType: "Placement",
        attribute: ":placement/worker",
        value: reference(EntityId.make("worker:maria")),
      },
      {
        op: "assert",
        entityId: EntityId.make("placement:maria-harbor"),
        entityType: "Placement",
        attribute: ":placement/site",
        value: reference(EntityId.make("site:harbor")),
      },
    ],
    query: {
      find: ["?worker", "?workerName", "?site"],
      where: [
        ["?placement", ":placement/worker", "?worker"],
        ["?placement", ":placement/site", "?site"],
        ["?worker", ":worker/name", "?workerName"],
        [
          "not",
          ["?training", ":training/worker", "?worker"],
          ["?training", ":training/site", "?site"],
        ],
      ],
      orderBy: [{ variable: "?worker", direction: "asc" }],
    },
    transaction: {
      operations: [
        {
          op: "assert",
          entityId: "training:maria-harbor",
          entityType: "Training",
          attribute: ":training/worker",
          value: { type: "ref", value: "worker:maria" },
        },
        {
          op: "assert",
          entityId: "training:maria-harbor",
          entityType: "Training",
          attribute: ":training/site",
          value: { type: "ref", value: "site:harbor" },
        },
      ],
      meta: {
        actor: "user:playground",
        commandId: "playground/train-maria/v1",
      },
    },
  },
  blank: {
    label: "Blank database",
    description: "Start with no facts and use the transaction editor to create your own domain.",
    question: "Which example names are stored?",
    action: "Add your first fact",
    explanation: "Create a named example entity. Its name will appear in the query results.",
    empty: "No example names yet. Add your first fact to see a result here.",
    focusEntity: "example:first",
    operations: [],
    query: {
      find: ["?entity", "?name"],
      where: [["?entity", ":example/name", "?name"]],
      orderBy: [{ variable: "?entity", direction: "asc" }],
    },
    transaction: {
      operations: [
        {
          op: "assert",
          entityId: "example:first",
          entityType: "Example",
          attribute: ":example/name",
          value: { type: "string", value: "My first fact" },
        },
      ],
      meta: {
        actor: "user:playground",
        commandId: "playground/create-example/v1",
      },
    },
  },
};

const selectedDomain = ref("learning");
const queryText = ref("");
const transactionText = ref("");
const queryOutput = ref("Run the sample query to see actual bindings.");
const queryRows = ref<ReadonlyArray<Record<string, unknown>>>([]);
const queryColumns = ref<readonly string[]>([]);
const querySucceeded = ref(false);
const hasMoreResults = ref(false);
const lastQueryIsSample = ref(true);
const guidedIds = ref<readonly TripleId[]>([]);
const score = ref(92);
const exampleName = ref("My first fact");
const changeMessage = ref("");
const transactionOutput = ref("");
const facts = ref<readonly Triple[]>([]);
const transactions = ref<readonly TransactionRecord[]>([]);
const selectedEntity = ref("");
const busy = ref(false);
const error = ref("");
let runtime: Runtime | undefined;
let runtimeSequence = 0;

const currentDomain = computed(() => domains[selectedDomain.value] ?? domains["learning"]!);
const activeGuidedIds = computed(() =>
  guidedIds.value.filter((id) => facts.value.some((fact) => fact.id === id)),
);
const displayValue = (value: unknown): string =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "—");
const columnLabel = (column: string): string =>
  column.replace(/^\?/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
const entityIds = computed(() => [...new Set(facts.value.map((fact) => fact.entityId))].sort());
const entityFacts = computed(() =>
  facts.value
    .filter((fact) => fact.entityId === selectedEntity.value)
    .map((fact) => ({
      id: fact.id,
      attribute: fact.attribute,
      value: fact.value,
      type: Option.getOrNull(fact.entityType),
      validFrom: fact.validFrom,
      validTo: Option.getOrNull(fact.validTo),
    })),
);

const formatError = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const refresh = async () => {
  if (runtime === undefined) return;
  const state = await runtime.runPromise(
    Effect.gen(function* () {
      const triples = yield* Triples;
      const allFacts = yield* triples.match({});
      const journal = yield* triples.transactions({ after: 0, limit: 50 });
      return {
        allFacts: allFacts.filter((fact) => !fact.entityId.startsWith("_")),
        journal: journal.transactions,
      };
    }),
  );
  facts.value = state.allFacts;
  transactions.value = state.journal;
  if (!entityIds.value.some((entityId) => entityId === selectedEntity.value)) {
    selectedEntity.value = entityIds.value[0] ?? "";
  }
};

const executeQuery = async () => {
  if (runtime === undefined) return;
  const source = JSON.parse(queryText.value) as unknown;
  const query = await Effect.runPromise(Schema.decodeUnknownEffect(DatalogQuery)(source));
  const result = await runtime.runPromise(
    Effect.gen(function* () {
      const triples = yield* Triples;
      return yield* triples.query(query, { pageSize: 100, debug: true });
    }),
  );
  queryRows.value = result.results;
  queryColumns.value = [...new Set(result.results.flatMap((row) => Object.keys(row)))];
  querySucceeded.value = true;
  hasMoreResults.value = Boolean(result.nextCursor);
  lastQueryIsSample.value = JSON.stringify(source) === JSON.stringify(currentDomain.value.query);
  queryOutput.value = JSON.stringify(
    {
      results: result.results,
      nextCursor: result.nextCursor ?? null,
      metrics: result.debug?.metrics ?? null,
    },
    null,
    2,
  );
};

const runQuery = async () => {
  busy.value = true;
  error.value = "";
  try {
    await executeQuery();
  } catch (cause) {
    error.value = formatError(cause);
    querySucceeded.value = false;
    queryOutput.value = "Query failed. Fix the JSON or query and try again.";
  } finally {
    busy.value = false;
  }
};

const applyTransaction = async (sourceText = transactionText.value, guided = false) => {
  if (runtime === undefined) return;
  busy.value = true;
  error.value = "";
  let committed = false;
  try {
    const source = JSON.parse(sourceText) as unknown;
    const request = await Effect.runPromise(Schema.decodeUnknownEffect(TransactRequest)(source));
    const meta = request.meta;
    const actor = meta?.actor;
    const commandId = meta?.commandId;
    const correlationId = meta?.correlationId;
    const causationId = meta?.causationId;
    const configSnapshot = meta?.configSnapshot;
    const enforce = meta?.enforce;
    const preconditions = meta?.preconditions;
    if (actor === undefined || commandId === undefined) {
      throw new Error("Playground transactions require meta.actor and meta.commandId.");
    }
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const triples = yield* Triples;
        return yield* triples.transact(request.operations, {
          actor,
          commandId,
          ...(correlationId === undefined ? {} : { correlationId }),
          ...(causationId === undefined ? {} : { causationId }),
          ...(configSnapshot === undefined ? {} : { configSnapshot }),
          ...(enforce === undefined ? {} : { enforce }),
          ...(preconditions === undefined ? {} : { preconditions }),
        });
      }),
    );
    committed = true;
    if (guided) guidedIds.value = result.triples.map((fact) => fact.id);
    changeMessage.value = `Commit #${result.position}: ${result.triples.length} fact${result.triples.length === 1 ? "" : "s"} added, ${result.retracted} retracted.`;
    transactionOutput.value = JSON.stringify(
      {
        transactionId: result.txId,
        position: result.position,
        asserted: result.triples.length,
        retracted: result.retracted,
      },
      null,
      2,
    );
    await refresh();
    if (guided) selectedEntity.value = currentDomain.value.focusEntity;
    await runQuery();
  } catch (cause) {
    error.value = committed
      ? `The write committed, but refreshing the view failed: ${formatError(cause)}`
      : formatError(cause);
    if (!committed) transactionOutput.value = "Transaction failed; no partial write was applied.";
  } finally {
    busy.value = false;
  }
};

const applyGuidedChange = async () => {
  const request = JSON.parse(JSON.stringify(currentDomain.value.transaction));
  request.meta.commandId = `playground/guided/${crypto.randomUUID()}`;
  if (selectedDomain.value === "learning") request.operations[0].value.value = score.value;
  if (selectedDomain.value === "blank") request.operations[0].value.value = exampleName.value;
  transactionText.value = JSON.stringify(request, null, 2);
  await applyTransaction(transactionText.value, true);
};

const retractGuidedChange = async () => {
  const request = {
    operations: activeGuidedIds.value.map((id) => ({ op: "retract", id })),
    meta: { actor: "user:playground", commandId: `playground/retract/${crypto.randomUUID()}` },
  };
  transactionText.value = JSON.stringify(request, null, 2);
  await applyTransaction();
};

const restoreQuery = async () => {
  queryText.value = JSON.stringify(currentDomain.value.query, null, 2);
  await runQuery();
};

const reset = async () => {
  busy.value = true;
  error.value = "";
  transactionOutput.value = "";
  changeMessage.value = "";
  guidedIds.value = [];
  queryRows.value = [];
  querySucceeded.value = false;
  queryOutput.value = "Run the sample query to see actual bindings.";
  try {
    await runtime?.dispose();
    runtimeSequence += 1;
    runtime = ManagedRuntime.make(
      KvTriples.layerWithScope(`docs-playground-${runtimeSequence}-${selectedDomain.value}`),
    );
    const domain = currentDomain.value;
    queryText.value = JSON.stringify(domain.query, null, 2);
    transactionText.value = JSON.stringify(domain.transaction, null, 2);
    if (domain.operations.length > 0) {
      await runtime.runPromise(
        Effect.gen(function* () {
          const triples = yield* Triples;
          yield* triples.transact(domain.operations, {
            actor: "triplex/docs-playground",
            commandId: `playground/seed/${selectedDomain.value}/v1`,
          });
        }),
      );
    }
    await refresh();
    if (entityIds.value.some((id) => id === domain.focusEntity))
      selectedEntity.value = domain.focusEntity;
    await executeQuery();
  } catch (cause) {
    error.value = formatError(cause);
  } finally {
    busy.value = false;
  }
};

const chooseDomain = async () => reset();

onMounted(reset);
onBeforeUnmount(() => {
  void runtime?.dispose();
  runtime = undefined;
});
</script>

<template>
  <section class="playground" aria-label="Triplex in-memory playground">
    <header class="playground__header">
      <div>
        <p class="playground__eyebrow">Your own live database</p>
        <h2>Small change. Live result.</h2>
        <p>{{ currentDomain.description }}</p>
      </div>
      <div class="playground__controls">
        <label for="playground-domain">Domain</label>
        <select
          id="playground-domain"
          v-model="selectedDomain"
          :disabled="busy"
          @change="chooseDomain"
        >
          <option v-for="(domain, key) in domains" :key="key" :value="key">
            {{ domain.label }}
          </option>
        </select>
        <button type="button" :disabled="busy" @click="reset">Reset database</button>
      </div>
    </header>

    <p class="playground__notice">
      Runs in your browser · No setup · Resets when you reload, leave, or change domain
    </p>
    <p v-if="error" class="playground__error" role="alert">{{ error }}</p>

    <div class="playground__grid playground__experiment">
      <article class="playground__panel">
        <div class="playground__panel-heading">
          <div>
            <p class="playground__eyebrow">1 · Ask the database</p>
            <h3>{{ lastQueryIsSample ? currentDomain.question : "Your query results" }}</h3>
          </div>
        </div>
        <div class="playground__results" aria-live="polite" aria-label="Query results">
          <template v-if="querySucceeded">
            <p class="playground__result-count">
              <strong>{{ queryRows.length }}</strong>
              {{ queryRows.length === 1 ? "match" : "matches" }}
            </p>
            <div v-if="queryRows.length" class="playground__table-scroll">
              <table>
                <thead>
                  <tr>
                    <th v-for="column in queryColumns" :key="column">{{ columnLabel(column) }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(row, index) in queryRows" :key="index">
                    <td v-for="column in queryColumns" :key="column">
                      {{ displayValue(row[column]) }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-else class="playground__empty">
              {{
                lastQueryIsSample
                  ? currentDomain.empty
                  : "No matches. Check the attributes, values, and joins in your query."
              }}
            </p>
            <p v-if="hasMoreResults" class="playground__hint">
              Showing the first 100 rows. The raw response includes a cursor for the next page.
            </p>
          </template>
          <p v-else>
            {{
              busy
                ? "Reading the database…"
                : "Query failed. Check the error above and edit the query below."
            }}
          </p>
        </div>
        <p class="playground__hint">
          This query runs on load and after every write. Open the editors below to change what it
          asks.
        </p>
      </article>

      <article class="playground__panel playground__action">
        <div class="playground__panel-heading">
          <div>
            <p class="playground__eyebrow">2 · Change a fact</p>
            <h3>{{ currentDomain.action }}</h3>
          </div>
        </div>
        <p>{{ currentDomain.explanation }}</p>
        <div v-if="selectedDomain === 'learning'" class="playground__field">
          <label for="playground-score">Quiz score</label>
          <input
            id="playground-score"
            v-model.number="score"
            type="number"
            min="0"
            max="100"
            :disabled="busy || activeGuidedIds.length > 0"
          />
          <span>out of 100</span>
        </div>
        <div v-if="selectedDomain === 'blank'" class="playground__field">
          <label for="playground-name">Example name</label>
          <input
            id="playground-name"
            v-model="exampleName"
            :disabled="busy || activeGuidedIds.length > 0"
          />
        </div>
        <button
          v-if="activeGuidedIds.length === 0"
          class="playground__primary"
          type="button"
          :disabled="
            busy ||
            (selectedDomain === 'learning' &&
              (!Number.isFinite(score) || score < 0 || score > 100)) ||
            (selectedDomain === 'blank' && !exampleName.trim())
          "
          @click="applyGuidedChange"
        >
          {{ currentDomain.action }}
        </button>
        <template v-else>
          <p class="playground__success">
            Fact added. Check the query result, then try reversing the change.
          </p>
          <button type="button" :disabled="busy" @click="retractGuidedChange">
            Retract this change
          </button>
          <p class="playground__hint">
            Retraction removes the new fact from current reads. Both commits remain in the journal.
          </p>
        </template>
      </article>
    </div>
    <p v-if="changeMessage" class="playground__change" role="status">{{ changeMessage }}</p>

    <div class="playground__grid playground__grid--inspect">
      <article class="playground__panel">
        <div class="playground__panel-heading">
          <div>
            <p class="playground__eyebrow">3 · See what changed</p>
            <h3>Facts in the database</h3>
          </div>
          <span>{{ facts.length }} visible facts</span>
        </div>
        <label for="playground-entity">Entity</label>
        <select id="playground-entity" v-model="selectedEntity">
          <option v-if="entityIds.length === 0" value="">No entities yet</option>
          <option v-for="entityId in entityIds" :key="entityId" :value="entityId">
            {{ entityId }}
          </option>
        </select>
        <div v-if="entityFacts.length" class="playground__table-scroll">
          <table>
            <thead>
              <tr>
                <th>Attribute</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(fact, index) in entityFacts" :key="index">
                <td>
                  <code>{{ fact.attribute }}</code>
                </td>
                <td>
                  {{ displayValue(fact.value.value) }}
                  <span v-if="fact.value.type === 'ref'" class="playground__ref-label"
                    >relationship</span
                  >
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="playground__hint">Add a fact to create your first entity.</p>
        <details v-if="entityFacts.length">
          <summary>Raw facts and valid time</summary>
          <pre>{{ JSON.stringify(entityFacts, null, 2) }}</pre>
        </details>
      </article>

      <article class="playground__panel">
        <div class="playground__panel-heading">
          <div>
            <p class="playground__eyebrow">Every write leaves a record</p>
            <h3>Transaction journal</h3>
          </div>
          <span
            >{{ transactions.length }} {{ transactions.length === 1 ? "commit" : "commits" }}</span
          >
        </div>
        <ol v-if="transactions.length > 0" class="playground__journal">
          <li v-for="transaction in [...transactions].reverse()" :key="transaction.txId">
            <strong>#{{ transaction.position }}</strong>
            <div>
              <span>{{
                transaction.commandId?.startsWith("playground/seed/")
                  ? "Loaded the sample domain"
                  : `${transaction.changes.length} ${transaction.changes.length === 1 ? "change" : "changes"} by ${transaction.actor || "unattributed"}`
              }}</span>
              <details>
                <summary>Commit details</summary>
                <pre>{{ JSON.stringify(transaction, null, 2) }}</pre>
              </details>
            </div>
          </li>
        </ol>
        <p v-else>No transactions yet.</p>
        <p class="playground__hint">
          Most recent first · Up to the first 50 commits in this session
        </p>
      </article>
    </div>

    <details class="playground__editors">
      <summary>
        Go further: edit queries and transactions <span>Public Triplex JSON APIs</span>
      </summary>
      <p>
        Change the query to explore other relationships, or write your own transaction. Each new
        transaction needs a unique <code>meta.commandId</code>. Guided actions fill in the
        transaction editor for you.
      </p>
      <div class="playground__grid">
        <article class="playground__panel">
          <div class="playground__panel-heading">
            <h3>Datalog query</h3>
            <button type="button" :disabled="busy" @click="runQuery">Run query</button>
          </div>
          <p class="playground__hint">
            <code>find</code> selects result columns. <code>where</code> matches facts and joins
            shared variables; <code>not</code> checks for missing facts.
          </p>
          <label class="playground__sr-only" for="playground-query">Datalog query JSON</label>
          <textarea
            id="playground-query"
            v-model="queryText"
            rows="16"
            spellcheck="false"
            :disabled="busy"
          />
          <button type="button" :disabled="busy" @click="restoreQuery">Restore sample query</button>
          <details>
            <summary>Raw query response and metrics</summary>
            <pre>{{ queryOutput }}</pre>
          </details>
        </article>
        <article class="playground__panel">
          <div class="playground__panel-heading">
            <h3>Atomic transaction</h3>
            <button type="button" :disabled="busy" @click="applyTransaction()">
              Apply transaction
            </button>
          </div>
          <p class="playground__hint">
            An <code>assert</code> adds a fact. A <code>retract</code> uses an existing fact’s ID.
            Operations in one transaction commit together.
          </p>
          <label class="playground__sr-only" for="playground-transaction">Transaction JSON</label>
          <textarea
            id="playground-transaction"
            v-model="transactionText"
            rows="16"
            spellcheck="false"
            :disabled="busy"
          />
          <details>
            <summary>Raw transaction receipt</summary>
            <pre>{{ transactionOutput || "No transaction applied yet." }}</pre>
          </details>
        </article>
      </div>
    </details>
  </section>
</template>

<style scoped>
.playground {
  margin-top: 28px;
}

.playground__header,
.playground__panel-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
}

.playground__header h2,
.playground__panel h3,
.playground__panel h4 {
  margin: 0;
  padding: 0;
  border: 0;
}

.playground__header p {
  max-width: 680px;
  margin: 8px 0 0;
}

.playground__eyebrow {
  margin: 0 0 6px !important;
  color: var(--vp-c-brand-1) !important;
  font-family: var(--vp-font-family-mono);
  font-size: 0.72rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.playground__controls {
  display: grid;
  grid-template-columns: auto auto;
  gap: 6px 10px;
  flex: none;
}

.playground__controls button {
  grid-column: 1 / -1;
}

.playground__notice,
.playground__error {
  margin: 22px 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 7px;
  background: var(--vp-c-bg-alt);
  padding: 12px 14px;
  font-size: 0.9rem;
}

.playground__notice {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--vp-c-text-2);
  font-size: 0.82rem;
}

.playground__experiment {
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
}

.playground__action {
  background: var(--vp-c-brand-soft) !important;
}

.playground__action p {
  margin: 8px 0 16px;
}

.playground__hint {
  color: var(--vp-c-text-2);
  font-size: 0.82rem;
  line-height: 1.6;
}

.playground__result-count {
  margin: 0 0 12px;
  color: var(--vp-c-text-2);
}

.playground__result-count strong {
  font-size: 1.8rem;
  color: var(--vp-c-text-1);
}

.playground__empty {
  padding: 14px;
  border: 1px dashed var(--vp-c-divider);
  border-radius: 6px;
  font-size: 0.9rem;
}

.playground__field {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: 18px 0;
  font-size: 0.9rem;
}

.playground__field input {
  min-width: 0;
  max-width: 100%;
  padding: 7px 10px;
}

.playground__field input[type="number"] {
  width: 80px;
}

.playground button.playground__primary {
  background: var(--vp-c-brand-1);
  color: var(--vp-c-bg);
  border-color: transparent;
}

.playground__change,
.playground__success {
  color: var(--vp-c-text-1);
  font-size: 0.88rem;
}

.playground__change {
  padding: 12px 16px;
  background: var(--vp-c-brand-soft);
  border-radius: 6px;
}

.playground__table-scroll {
  overflow-x: auto;
  margin: 12px 0;
}

.playground table {
  display: table;
  width: 100%;
  margin: 0;
  font-size: 0.82rem;
}

.playground th,
.playground td {
  padding: 9px 10px;
  text-align: left;
  overflow-wrap: anywhere;
}

.playground td code {
  white-space: normal;
}

.playground th {
  text-transform: capitalize;
}

.playground__ref-label {
  display: block;
  color: var(--vp-c-text-2);
  font-size: 0.7rem;
}

.playground details {
  min-width: 0;
  margin-top: 14px;
}

.playground summary {
  cursor: pointer;
  color: var(--vp-c-brand-1);
  font-size: 0.85rem;
  font-weight: 600;
}

.playground__editors {
  padding: 20px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
}

.playground__editors > summary {
  font-size: 1rem;
}

.playground__editors > summary span {
  display: block;
  margin: 6px 0 0 18px;
  color: var(--vp-c-text-2);
  font-size: 0.8rem;
  font-weight: 400;
}

.playground__error {
  border-color: var(--vp-c-danger-1);
  color: var(--vp-c-danger-1);
}

.playground__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
}

.playground__grid--inspect {
  margin-top: 20px;
}

.playground__panel {
  min-width: 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-elv);
  padding: 18px;
}

.playground__panel-heading {
  align-items: center;
  margin-bottom: 14px;
}

.playground__panel-heading span {
  color: var(--vp-c-text-2);
  font-size: 0.82rem;
}

.playground button,
.playground select,
.playground input,
.playground textarea {
  border: 1px solid var(--vp-c-divider);
  border-radius: 5px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font: inherit;
}

.playground button {
  cursor: pointer;
  padding: 7px 11px;
  color: var(--vp-c-brand-1);
  font-weight: 600;
}

.playground button:hover:not(:disabled) {
  border-color: var(--vp-c-brand-1);
}

.playground button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.playground :is(button, select, input, textarea, summary):focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 3px;
}

.playground select {
  max-width: 100%;
  padding: 6px 8px;
}

.playground textarea {
  box-sizing: border-box;
  width: 100%;
  resize: vertical;
  padding: 12px;
  font-family: var(--vp-font-family-mono);
  font-size: 0.78rem;
  line-height: 1.55;
}

.playground pre {
  min-height: 74px;
  max-height: 340px;
  margin: 10px 0 0;
  overflow: auto;
  border-radius: 5px;
  padding: 12px;
  background: var(--vp-c-bg-alt);
  color: var(--vp-c-text-1);
  font-size: 0.76rem;
  line-height: 1.5;
}

.playground__journal {
  margin: 0;
  padding: 0;
  list-style: none;
}

.playground__journal li {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 3px 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--vp-c-divider);
  font-size: 0.84rem;
}

.playground__journal li > div {
  min-width: 0;
  overflow-wrap: anywhere;
}

.playground__journal code {
  overflow: hidden;
  color: var(--vp-c-text-2);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.playground__sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (max-width: 820px) {
  .playground__header,
  .playground__panel-heading {
    align-items: stretch;
    flex-direction: column;
  }

  .playground__controls,
  .playground__grid {
    grid-template-columns: 1fr;
    width: 100%;
  }

  .playground__controls button {
    grid-column: auto;
  }
}
</style>
