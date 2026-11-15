/**
 * The inspector beside the table, built from the reader's sections: the selected
 * value, its valid-time picture, every recorded assertion, the receipt that wrote
 * it, Why's explanation, and the attribute's declaration. With nothing selected
 * it shows the type, like the reader's outline.
 */
import { useEffect, useState, type ReactNode } from "react";
import { ArrowUpRight, GitCommitHorizontal, Pencil, Pin } from "lucide-react";

import type {
  AttributeView,
  EntityRecord,
  Explanation,
  Fact,
  Transaction,
} from "../shared/protocol.js";
import { call } from "./client.js";
import {
  backdated,
  formatDateTime,
  formatInstant,
  interval,
  localName,
  relative,
  shortId,
  valueText,
} from "./format.js";
import { useExplorer } from "./model.js";
import { useTransaction } from "./transactions.js";

export function Section({
  title,
  aside,
  children,
}: {
  readonly title: string;
  readonly aside?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="ex-section">
      <header>
        <h3>{title}</h3>
        {aside ? <span className="ex-section-aside">{aside}</span> : null}
      </header>
      {children}
    </section>
  );
}

export function Inspector() {
  const explorer = useExplorer();
  const { selection } = explorer;
  if (!explorer.description)
    return (
      <div className="ex-inspector-empty">
        <span className="ex-pulse" />
        Reading the release…
      </div>
    );
  if (selection?.kind === "transaction") return <TransactionView txId={selection.txId} />;
  if (selection)
    return (
      <EntityView
        attribute={selection.kind === "cell" ? selection.attribute : null}
        entityId={selection.entityId}
      />
    );
  return <TypeOutline />;
}

function TypeOutline() {
  const explorer = useExplorer();
  const type = explorer.activeType;
  if (!type) return <p className="ex-muted ex-tip">Open an entity type to see its attributes.</p>;
  return (
    <div className="ex-inspector-body">
      <div className="ex-subject">
        <div className="ex-subject-kind">
          <span>entity type</span>
          {explorer.description?.release ? (
            <span className="ex-badge">{explorer.description.release.label}</span>
          ) : null}
        </div>
        <code className="ex-subject-text">{type.name}</code>
      </div>
      <Section aside={`${type.attributes.length}`} title="Attributes">
        <table className="ex-slots">
          <tbody>
            {type.attributes.map((attribute) => (
              <tr className={attribute.required ? "filled" : ""} key={attribute.key}>
                <td>
                  <code>{attribute.key}</code>
                </td>
                <td>
                  <code className="ex-slot-type">{attribute.type}</code>
                  {attribute.required ? <span className="ex-chip ex-chip-ok">required</span> : null}
                  {attribute.unique ? <span className="ex-chip">unique</span> : null}
                  {attribute.cardinality === "many" ? <span className="ex-chip">many</span> : null}
                  {attribute.sensitive ? (
                    <span className="ex-chip ex-chip-warn">sensitive</span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      {type.referencedBy.length ? (
        <Section title="Referenced by">
          <ul className="ex-list">
            {type.referencedBy.map((reference) => (
              <li key={`${reference.type}:${reference.attribute}`}>
                <button
                  className="ex-link"
                  onClick={() => explorer.openType(reference.type)}
                  type="button"
                >
                  {reference.type}
                </button>{" "}
                <code className="ex-muted">{reference.attribute}</code>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <Section title="How rows are read">
        <p className="ex-doc">
          Every page comes from one commit, so scrolling never mixes cuts. Unsorted, the table pages{" "}
          {type.name} entities by ID. Sorted or filtered, it pages a Datalog query over{" "}
          {type.anchor ? (
            <>
              <code>{type.anchor}</code> and
            </>
          ) : null}{" "}
          the sorted and filtered attributes; entities without the sorted value follow, so blank
          cells sort last.
        </p>
      </Section>
      <p className="ex-muted ex-tip">
        Hover a cell for its intervals and receipt. Click one to see every value it has had, who
        recorded it, and why.
      </p>
    </div>
  );
}

function EntityView({
  entityId,
  attribute,
}: {
  readonly entityId: string;
  readonly attribute: string | null;
}) {
  const explorer = useExplorer();
  const record = explorer.record(entityId);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    setFailed(null);
    if (!record)
      explorer
        .loadRecord(entityId)
        .catch((cause) => setFailed(String((cause as Error).message ?? cause)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId, explorer.basis]);
  if (failed) return <div className="ex-inspector-empty ex-error">{failed}</div>;
  if (!record)
    return (
      <div className="ex-inspector-empty">
        <span className="ex-pulse" />
        Reading {entityId}…
      </div>
    );
  const type = explorer.typeOf(record.entityType);
  const declared = type?.attributes.find((candidate) => candidate.key === attribute) ?? null;
  return (
    <div className="ex-inspector-body" key={`${entityId}:${attribute}`}>
      <div className="ex-subject">
        <div className="ex-subject-kind">
          <span>{attribute ? "value" : (record.entityType ?? "entity")}</span>
          {explorer.isLive ? (
            <span className="ex-badge">now</span>
          ) : (
            <span className="ex-badge warn">as of #{record.basis.recordedPosition}</span>
          )}
        </div>
        <code className="ex-subject-text">
          {record.label}
          {attribute ? <span className="ex-muted"> · {attribute}</span> : null}
        </code>
        <div className="ex-subject-actions">
          {attribute ? (
            <button
              className="ex-link"
              onClick={() => explorer.select({ kind: "entity", entityId })}
              type="button"
            >
              Whole record
            </button>
          ) : null}
          {type && !explorer.description?.readOnly ? (
            <button
              className="ex-link"
              onClick={() => explorer.setSheet({ mode: "edit", type: type.name, entityId })}
              type="button"
            >
              <Pencil size={12} /> Edit
            </button>
          ) : null}
          <button className="ex-link" onClick={() => explorer.setPanel("references")} type="button">
            References
          </button>
        </div>
      </div>
      {attribute ? (
        <ValueSections attribute={attribute} declared={declared} record={record} />
      ) : (
        <RecordSections record={record} type={type?.attributes ?? []} />
      )}
    </div>
  );
}

const valueOf = (fact: Fact, record: EntityRecord) => valueText(fact.value, record.labels);

function ValueSections({
  record,
  attribute,
  declared,
}: {
  readonly record: EntityRecord;
  readonly attribute: string;
  readonly declared: AttributeView | null;
}) {
  const explorer = useExplorer();
  const visible = record.facts.filter((fact) => fact.attribute === attribute);
  const history = record.history.filter((fact) => fact.attribute === attribute);
  const visibleIds = new Set(visible.map((fact) => fact.id));
  return (
    <>
      <Section aside={visible.length > 1 ? `${visible.length} values` : undefined} title="Value">
        {visible.length === 0 ? (
          <p className="ex-muted">
            No visible fact at valid time {formatInstant(record.basis.validAt)}.
          </p>
        ) : null}
        {visible.map((fact) => (
          <div className="ex-value" key={fact.id}>
            <span className="ex-value-text">{valueOf(fact, record)}</span>
            {fact.value.type === "ref" ? (
              <button
                className="ex-link"
                onClick={() => explorer.follow((fact.value as { value: string }).value)}
                type="button"
              >
                Open <ArrowUpRight size={12} />
              </button>
            ) : null}
            <dl className="ex-effect">
              <dt>true from</dt>
              <dd>
                {formatInstant(fact.validFrom)}{" "}
                <span className="ex-muted">
                  until {fact.validTo === null ? "further notice" : formatInstant(fact.validTo)}
                </span>
              </dd>
              <dt>recorded</dt>
              <dd>
                {formatDateTime(fact.recordedAt)}{" "}
                {backdated(fact) ? <span className="ex-chip ex-chip-warn">backdated</span> : null}
              </dd>
            </dl>
          </div>
        ))}
      </Section>
      <Section
        aside={`${history.length} ${history.length === 1 ? "assertion" : "assertions"}`}
        title="Valid time"
      >
        <Timeline
          facts={history}
          labels={record.labels}
          validAt={record.basis.validAt}
          visible={visibleIds}
        />
      </Section>
      <Section title="Recorded history">
        <ol className="ex-history">
          {[...history].reverse().map((fact) => (
            <HistoryItem
              fact={fact}
              key={fact.id}
              record={record}
              visible={visibleIds.has(fact.id)}
            />
          ))}
        </ol>
      </Section>
      {visible[0]?.txId ? <Receipt txId={visible[0].txId} /> : null}
      <WhySection attribute={attribute} record={record} />
      {declared ? (
        <Section aside={explorer.description?.release?.label} title="Attribute">
          <dl className="ex-effect">
            <dt>type</dt>
            <dd>
              <code>{declared.type}</code>
            </dd>
            <dt>usage</dt>
            <dd>
              {declared.required ? (
                <span className="ex-chip ex-chip-ok">required</span>
              ) : (
                <span className="ex-chip">optional</span>
              )}
              <span className="ex-chip">
                {declared.cardinality === "many" ? "many values" : "one value"}
              </span>
              {declared.unique ? <span className="ex-chip">unique</span> : null}
            </dd>
            {declared.ref ? (
              <>
                <dt>points at</dt>
                <dd>
                  <button
                    className="ex-link"
                    onClick={() => explorer.openType(declared.ref!)}
                    type="button"
                  >
                    {declared.ref}
                  </button>
                </dd>
              </>
            ) : null}
          </dl>
        </Section>
      ) : null}
    </>
  );
}

function HistoryItem({
  fact,
  record,
  visible,
}: {
  readonly fact: Fact;
  readonly record: EntityRecord;
  readonly visible: boolean;
}) {
  const explorer = useExplorer();
  const tx = record.transactions.find((candidate) => candidate.txId === fact.txId);
  const retractTx = record.transactions.find((candidate) => candidate.txId === fact.retractTxId);
  return (
    <li className={`${visible ? "visible" : ""}${fact.retractedAt !== null ? " retracted" : ""}`}>
      <div className="ex-history-value">
        {valueOf(fact, record)}
        {visible ? <span className="ex-chip ex-chip-ok">shown</span> : null}
      </div>
      <div className="ex-history-meta">valid {interval(fact.validFrom, fact.validTo)}</div>
      <div className="ex-history-meta">
        recorded {formatInstant(fact.recordedAt)}
        {fact.retractedAt !== null ? <> → retracted {formatInstant(fact.retractedAt)}</> : null}
      </div>
      <div className="ex-history-tx">
        {fact.txId ? (
          <button
            className="ex-link"
            onClick={() => explorer.select({ kind: "transaction", txId: fact.txId! })}
            type="button"
          >
            <GitCommitHorizontal size={12} />
            {tx ? `#${tx.position} ${tx.actor ?? ""}` : shortId(fact.txId)}
          </button>
        ) : null}
        {fact.retractTxId ? (
          <button
            className="ex-link ex-muted"
            onClick={() => explorer.select({ kind: "transaction", txId: fact.retractTxId! })}
            type="button"
          >
            retracted by{" "}
            {retractTx
              ? `#${retractTx.position} ${retractTx.actor ?? ""}`
              : shortId(fact.retractTxId)}
          </button>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Each assertion as a bar over valid time, newest recorded at the bottom.
 * Retracted ones stay as hatched ghosts; the line marks the valid time being read.
 */
function Timeline({
  facts,
  labels,
  validAt,
  visible,
}: {
  readonly facts: readonly Fact[];
  readonly labels: Readonly<Record<string, string>>;
  readonly validAt: number;
  readonly visible: ReadonlySet<string>;
}) {
  if (facts.length === 0) return <p className="ex-muted">Never asserted.</p>;
  const ends = facts.flatMap((fact) => [fact.validFrom, fact.validTo ?? validAt]);
  const start = Math.min(...ends, validAt);
  const span = Math.max(Math.max(...ends, validAt) - start, 86_400_000) * 1.08;
  const x = (t: number) => ((t - start) / span) * 100;
  const shown = facts.slice(-8);
  return (
    <div className="ex-timeline">
      <div className="ex-timeline-rows">
        {shown.map((fact) => (
          <div className="ex-timeline-row" key={fact.id}>
            <div
              className={`ex-timeline-bar${visible.has(fact.id) ? " visible" : ""}${fact.retractedAt !== null ? " retracted" : ""}${fact.validTo === null ? " open" : ""}`}
              style={{
                left: `${x(fact.validFrom)}%`,
                width: `${Math.max(1.5, (fact.validTo === null ? 100 : x(fact.validTo)) - x(fact.validFrom))}%`,
              }}
              title={`${valueText(fact.value, labels)} · valid ${interval(fact.validFrom, fact.validTo)}`}
            >
              <span>{valueText(fact.value, labels)}</span>
            </div>
          </div>
        ))}
        <div
          className="ex-timeline-now"
          style={{ left: `${x(validAt)}%` }}
          title={`Reading valid time ${formatInstant(validAt)}`}
        />
      </div>
      <div className="ex-timeline-axis">
        <span>{formatInstant(start)}</span>
        <span>valid time →</span>
        <span>{formatInstant(start + span)}</span>
      </div>
      {facts.length > shown.length ? (
        <p className="ex-muted">
          The latest {shown.length} of {facts.length} assertions.
        </p>
      ) : null}
    </div>
  );
}

function Receipt({ txId }: { readonly txId: string }) {
  const explorer = useExplorer();
  const tx = useTransaction(txId);
  return (
    <Section aside={tx ? `#${tx.position}` : undefined} title="Receipt">
      {!tx ? <p className="ex-muted">Reading…</p> : <TransactionFacts tx={tx} />}
      {tx ? (
        <div className="ex-name-actions">
          <button
            className="ex-link"
            onClick={() => explorer.select({ kind: "transaction", txId })}
            type="button"
          >
            All {tx.changes.length} changes
          </button>
          <button className="ex-link" onClick={() => explorer.pin(tx.position)} type="button">
            <Pin size={12} /> View as of #{tx.position}
          </button>
        </div>
      ) : null}
    </Section>
  );
}

function TransactionFacts({ tx }: { readonly tx: Transaction }) {
  return (
    <dl className="ex-effect">
      <dt>actor</dt>
      <dd>
        {tx.actor ? (
          <span className="ex-chip ex-chip-actor">{tx.actor}</span>
        ) : (
          <span className="ex-muted">none</span>
        )}
      </dd>
      <dt>committed</dt>
      <dd>
        {formatDateTime(tx.instant)} <span className="ex-muted">{relative(tx.instant)}</span>
      </dd>
      {tx.commandId ? (
        <>
          <dt>command</dt>
          <dd>
            <code>{tx.commandId}</code>
          </dd>
        </>
      ) : null}
      {tx.correlationId ? (
        <>
          <dt>correlation</dt>
          <dd>
            <code>{tx.correlationId}</code>
          </dd>
        </>
      ) : null}
      {tx.causationId ? (
        <>
          <dt>caused by</dt>
          <dd>
            <code>{tx.causationId}</code>
          </dd>
        </>
      ) : null}
      <dt>release</dt>
      <dd>
        {tx.release ? (
          <span className="ex-chip ex-chip-ok" title={tx.release.id}>
            {tx.release.label ?? shortId(tx.release.id)}
          </span>
        ) : (
          <span className="ex-muted">unpinned</span>
        )}
      </dd>
    </dl>
  );
}

function WhySection({
  record,
  attribute,
}: {
  readonly record: EntityRecord;
  readonly attribute: string;
}) {
  const explorer = useExplorer();
  const [why, setWhy] = useState<Explanation | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setWhy(null);
    setError(null);
    call({
      _tag: "Why",
      subject: { kind: "attribute", entityId: record.entityId, attribute },
      basis: record.basis,
    }).then(
      (found) => current && setWhy(found),
      (cause) => current && setError(String((cause as Error).message ?? cause)),
    );
    return () => {
      current = false;
    };
  }, [record.entityId, attribute, record.basis.recordedPosition, record.basis.validAt]);
  const txs = new Map(why?.transactions.map((tx) => [tx.txId, tx]) ?? []);
  return (
    <Section aside={why ? `at #${why.basis.recordedPosition}` : undefined} title="Why">
      {error ? (
        <p className="ex-muted">{error}</p>
      ) : !why ? (
        <p className="ex-muted">Explaining…</p>
      ) : why.facts.length === 0 ? (
        <p className="ex-muted">Nothing asserts this attribute at this basis.</p>
      ) : (
        <>
          {why.causation.traces.map((trace) => {
            const chain = [trace.start, ...trace.ancestors];
            return (
              <ol className="ex-causation" key={trace.start}>
                {chain.map((txId, index) => {
                  const tx = txs.get(txId);
                  return (
                    <li key={txId}>
                      <button
                        className="ex-link"
                        onClick={() => explorer.select({ kind: "transaction", txId })}
                        type="button"
                      >
                        <span className="ex-step-n">{index === 0 ? "asserted" : "because of"}</span>
                        <code>{tx?.commandId ?? shortId(txId)}</code>
                      </button>
                      <span className="ex-muted">
                        {tx
                          ? `${tx.actor ?? "no actor"} · #${tx.position} · ${tx.release.status === "found" ? tx.release.label : tx.release.status}`
                          : ""}
                      </span>
                    </li>
                  );
                })}
                {trace.stop.reason !== "root" && trace.stop.reason !== "disabled" ? (
                  <li className="ex-muted">
                    stopped: {trace.stop.reason}
                    {trace.stop.commandId ? ` at ${trace.stop.commandId}` : ""}
                  </li>
                ) : null}
              </ol>
            );
          })}
          {why.gaps.length ? (
            <p className="ex-error">
              {why.gaps.length} journal gaps: history before them is incomplete.
            </p>
          ) : null}
        </>
      )}
    </Section>
  );
}

function RecordSections({
  record,
  type,
}: {
  readonly record: EntityRecord;
  readonly type: readonly AttributeView[];
}) {
  const explorer = useExplorer();
  const keys = [
    ...new Set([
      ...type.map((attribute) => attribute.key),
      ...record.facts.map((fact) => fact.attribute),
    ]),
  ];
  return (
    <>
      <Section aside={`${record.facts.length} facts`} title="Facts">
        <table className="ex-slots">
          <tbody>
            {keys.map((key) => {
              const facts = record.facts.filter((fact) => fact.attribute === key);
              return (
                <tr className={facts.length ? "filled" : ""} key={key}>
                  <td>
                    <button
                      className="ex-link"
                      onClick={() =>
                        explorer.select({ kind: "cell", entityId: record.entityId, attribute: key })
                      }
                      type="button"
                    >
                      <code>{localName(key)}</code>
                    </button>
                  </td>
                  <td>
                    {facts.length ? (
                      facts.map((fact) => (
                        <span className="ex-slot-value" key={fact.id}>
                          {valueOf(fact, record)}
                        </span>
                      ))
                    ) : (
                      <span className="ex-slot-empty">empty</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>
      <Section
        aside={`${record.transactions.length}${record.moreTransactions ? "+" : ""}`}
        title="Transactions"
      >
        <ol className="ex-txlist">
          {record.transactions.map((tx) => (
            <li key={tx.txId}>
              <button
                onClick={() => explorer.select({ kind: "transaction", txId: tx.txId })}
                type="button"
              >
                <span className="ex-tx-pos">#{tx.position}</span>
                <span className="ex-tx-actor">{tx.actor ?? "—"}</span>
                <code className="ex-tx-command">{tx.commandId ?? ""}</code>
                <span className="ex-muted">{relative(tx.instant)}</span>
              </button>
            </li>
          ))}
        </ol>
      </Section>
    </>
  );
}

function TransactionView({ txId }: { readonly txId: string }) {
  const explorer = useExplorer();
  const tx = useTransaction(txId);
  if (!tx)
    return (
      <div className="ex-inspector-empty">
        <span className="ex-pulse" />
        Reading the transaction…
      </div>
    );
  const byEntity = new Map<string, Transaction["changes"][number][]>();
  for (const change of tx.changes)
    byEntity.set(change.entityId, [...(byEntity.get(change.entityId) ?? []), change]);
  return (
    <div className="ex-inspector-body">
      <div className="ex-subject">
        <div className="ex-subject-kind">
          <span>transaction</span>
          <span className="ex-badge">#{tx.position}</span>
        </div>
        <code className="ex-subject-text">{tx.commandId ?? tx.txId}</code>
        <div className="ex-subject-actions">
          <button className="ex-link" onClick={() => explorer.pin(tx.position)} type="button">
            <Pin size={12} /> View as of #{tx.position}
          </button>
        </div>
      </div>
      <Section title="Receipt">
        <TransactionFacts tx={tx} />
      </Section>
      <Section aside={`${tx.changes.length} changes · ${byEntity.size} entities`} title="Changes">
        <div className="ex-changes">
          {[...byEntity].slice(0, 60).map(([entityId, changes]) => (
            <div className="ex-refs-file" key={entityId}>
              <button
                className="ex-refs-file-name"
                onClick={() => explorer.follow(entityId)}
                type="button"
              >
                <code>{entityId}</code>
                <span className="ex-panel-count">{changes.length}</span>
              </button>
              {changes.map((change, index) => (
                <div className={`ex-change ${change.op}`} key={index}>
                  <span className="ex-change-op">{change.op === "assert" ? "+" : "−"}</span>
                  <code>{localName(change.attribute)}</code>
                  <span className="ex-change-value">{valueText(change.value)}</span>
                  {change.validFrom !== null ? (
                    <span className="ex-muted">{interval(change.validFrom, change.validTo)}</span>
                  ) : null}
                </div>
              ))}
            </div>
          ))}
          {byEntity.size > 60 ? (
            <p className="ex-muted">and {byEntity.size - 60} more entities</p>
          ) : null}
        </div>
      </Section>
    </div>
  );
}
