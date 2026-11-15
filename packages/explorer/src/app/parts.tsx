/** The explorer's chrome. Each part reads the explorer it is inside with useExplorer(). */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Database as DatabaseIcon,
  Eye,
  EyeOff,
  Hourglass,
  Moon,
  PanelBottom,
  PanelLeft,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Sun,
  Table2,
  X,
} from "lucide-react";

import type { References, Transaction } from "../shared/protocol.js";
import { call } from "./client.js";
import {
  formatInstant,
  fromInputDate,
  localName,
  relative,
  toInputDate,
  valueText,
} from "./format.js";
import { useRows } from "./grid.js";
import { MOD, useExplorer } from "./model.js";
import { remember } from "./transactions.js";

export function TopBar({
  theme,
  onTheme,
}: {
  readonly theme: "light" | "dark";
  readonly onTheme: () => void;
}) {
  const explorer = useExplorer();
  const description = explorer.description;
  return (
    <header className="ex-top">
      <div className="ex-title">
        <span className="ex-eyebrow">Triplex · explorer</span>
        <h1>
          <DatabaseIcon size={18} /> {description?.database ?? "…"}
        </h1>
        <p>
          {description?.release ? (
            <>
              Release <code title={description.release.id}>{description.release.label}</code> ·{" "}
            </>
          ) : null}
          {description ? `${description.types.length} entity types` : "Connecting…"}
          {description?.readOnly ? " · read-only" : ""}
        </p>
      </div>
      <BasisControl />
      <button aria-label="Toggle the theme" className="ex-icon" onClick={onTheme} type="button">
        {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
      </button>
    </header>
  );
}

/** The two clocks: which commit to read (live or pinned), and which instant to read facts true at. */
export function BasisControl() {
  const explorer = useExplorer();
  const { basis, head } = explorer;
  const [position, setPosition] = useState("");
  useEffect(
    () => setPosition(basis.recordedPosition === undefined ? "" : String(basis.recordedPosition)),
    [basis.recordedPosition],
  );
  return (
    <div aria-label="Temporal basis" className="ex-basis" role="group">
      <div className="ex-basis-clock">
        <span className="ex-basis-label">Recorded</span>
        <div className="ex-segmented">
          <button
            aria-pressed={explorer.isLive}
            className={explorer.isLive ? "active live" : ""}
            onClick={explorer.goLive}
            type="button"
          >
            <span className={`ex-dot${explorer.connected ? " on" : ""}`} />
            Live #{head}
          </button>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const n = Number(position);
              if (Number.isInteger(n) && n >= 0) explorer.pin(Math.min(n, head));
            }}
          >
            <label className={explorer.isLive ? "" : "active"}>
              <Pin size={12} />
              as of #
              <input
                aria-label="Recorded position"
                inputMode="numeric"
                onChange={(event) => setPosition(event.target.value)}
                placeholder={String(head)}
                value={position}
              />
            </label>
          </form>
        </div>
      </div>
      <div className="ex-basis-clock">
        <span className="ex-basis-label">Valid</span>
        <div className="ex-segmented">
          <button
            aria-pressed={basis.validAt === undefined}
            className={basis.validAt === undefined ? "active" : ""}
            onClick={() =>
              explorer.setBasis(
                basis.recordedPosition === undefined
                  ? {}
                  : { recordedPosition: basis.recordedPosition },
              )
            }
            type="button"
          >
            Now
          </button>
          <label className={basis.validAt === undefined ? "" : "active"}>
            at{" "}
            <input
              aria-label="Valid time"
              onChange={(event) => {
                const at = fromInputDate(event.target.value);
                explorer.setBasis({
                  ...(basis.recordedPosition === undefined
                    ? {}
                    : { recordedPosition: basis.recordedPosition }),
                  ...(at === undefined ? {} : { validAt: at }),
                });
              }}
              type="datetime-local"
              value={basis.validAt === undefined ? "" : toInputDate(basis.validAt)}
            />
          </label>
        </div>
      </div>
    </div>
  );
}

export function TypesSidebar() {
  const explorer = useExplorer();
  const type = explorer.activeType;
  return (
    <aside aria-label="Entity types" className="ex-sidebar">
      <section>
        <header>
          <h3>Entity types</h3>
        </header>
        <ul className="ex-tree">
          {explorer.description?.types.map((candidate) => (
            <li key={candidate.name}>
              <button
                aria-current={candidate.name === explorer.active}
                onClick={() => explorer.openType(candidate.name)}
                type="button"
              >
                <Table2 size={13} />
                <span className="ex-tree-name">{candidate.name}</span>
                <span className="ex-tree-count">{candidate.attributes.length}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      {type ? (
        <section className="ex-sidebar-outline">
          <header>
            <h3>Columns</h3>
            <span className="ex-section-aside">{type.name}</span>
          </header>
          <ul className="ex-symbols">
            {type.attributes.map((attribute) => {
              const hidden = explorer.table?.hidden.includes(attribute.key) ?? false;
              return (
                <li key={attribute.key}>
                  <button
                    className={`ex-symbol${hidden ? " hidden" : ""}`}
                    onClick={() => explorer.toggleColumn(attribute.key)}
                    title={hidden ? "Show column" : "Hide column"}
                    type="button"
                  >
                    {hidden ? <EyeOff size={12} /> : <Eye size={12} />}
                    <code className="ex-symbol-name">{localName(attribute.key)}</code>
                    <span className="ex-symbol-type">
                      {attribute.kind === "ref" ? `→ ${attribute.ref}` : attribute.kind}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </aside>
  );
}

export function TableTabs() {
  const explorer = useExplorer();
  return (
    <div aria-label="Open tables" className="ex-files" role="tablist">
      <button
        aria-label="Toggle the types sidebar"
        aria-pressed={explorer.sidebar}
        className="ex-back"
        onClick={() => explorer.setSidebar(!explorer.sidebar)}
        title={`Entity types (${MOD}B)`}
        type="button"
      >
        <PanelLeft size={14} />
      </button>
      <button
        aria-label="Back"
        className="ex-back"
        disabled={!explorer.canGoBack}
        onClick={explorer.back}
        title="Back to where you came from (Alt-←)"
        type="button"
      >
        <ArrowLeft size={14} />
      </button>
      <div className="ex-files-scroll">
        {explorer.tabs.map((name) => (
          <div
            aria-selected={name === explorer.active}
            className={`ex-file${name === explorer.active ? " active" : ""}`}
            key={name}
            role="tab"
          >
            <button onClick={() => explorer.openType(name)} type="button">
              <Table2 size={12} />
              {name}
            </button>
            {explorer.tabs.length > 1 ? (
              <button
                aria-label={`Close ${name}`}
                className="ex-file-close"
                onClick={() => explorer.closeType(name)}
                type="button"
              >
                <X size={12} />
              </button>
            ) : null}
          </div>
        ))}
      </div>
      <button
        aria-label="Quick open"
        className="ex-back"
        onClick={() => explorer.setQuickOpen(true)}
        title={`Go to a type, attribute or entity (${MOD}K)`}
        type="button"
      >
        <Search size={14} />
      </button>
      <button
        aria-label="Toggle the bottom panel"
        aria-pressed={Boolean(explorer.panel)}
        className="ex-back"
        onClick={() => explorer.setPanel(explorer.panel ? null : "journal")}
        title="References and journal (Ctrl-`)"
        type="button"
      >
        <PanelBottom size={14} />
      </button>
    </div>
  );
}

/** Where the selection sits. One line high whatever it shows, so the table below never moves. */
export function Breadcrumbs() {
  const explorer = useExplorer();
  const selection = explorer.selection;
  const entityId = selection && selection.kind !== "transaction" ? selection.entityId : null;
  const record = entityId ? explorer.record(entityId) : undefined;
  return (
    <nav aria-label="Selection" className="ex-breadcrumbs">
      <button onClick={() => explorer.select(null)} type="button">
        {explorer.description?.database ?? "database"}
      </button>
      {explorer.active ? (
        <button
          className={selection ? "" : "current"}
          onClick={() => explorer.select(null)}
          type="button"
        >
          {explorer.active}
        </button>
      ) : null}
      {entityId ? (
        <button
          className={selection?.kind === "entity" ? "current" : ""}
          onClick={() => explorer.select({ kind: "entity", entityId })}
          type="button"
        >
          {record?.label ?? entityId}
        </button>
      ) : null}
      {selection?.kind === "cell" ? (
        <button className="current" type="button">
          {selection.attribute}
        </button>
      ) : null}
      {selection?.kind === "transaction" ? (
        <button className="current" type="button">
          transaction
        </button>
      ) : null}
    </nav>
  );
}

export function TableToolbar() {
  const explorer = useExplorer();
  const table = explorer.table;
  return (
    <div className="ex-toolbar">
      <Breadcrumbs />
      <div className="ex-tools">
        {table?.sort ? (
          <span className="ex-filter-chip">
            sort <code>{localName(table.sort.attribute)}</code> {table.sort.direction}
            <button
              aria-label="Clear the sort"
              onClick={() => explorer.setSort(undefined)}
              type="button"
            >
              <X size={11} />
            </button>
          </span>
        ) : null}
        {table?.filters.map((filter, index) => (
          <span className="ex-filter-chip" key={filter.attribute}>
            <code>{localName(filter.attribute)}</code>{" "}
            {filter.op === "not-empty"
              ? "has a value"
              : filter.op === "empty"
                ? "is empty"
                : filter.op}{" "}
            {filter.value === undefined ? "" : String(filter.value)}
            <button
              aria-label="Remove the filter"
              onClick={() => explorer.removeFilter(index)}
              type="button"
            >
              <X size={11} />
            </button>
          </span>
        ))}
        <span className="ex-tool-gap" />
        <label className="ex-toggle" title="Mark values that stop being true within 30 days">
          <input
            checked={explorer.timeMarks}
            onChange={(event) => explorer.setTimeMarks(event.target.checked)}
            type="checkbox"
          />
          <Hourglass size={12} />
          Ending soon
        </label>
        <button onClick={explorer.refresh} title="Read the table again" type="button">
          <RefreshCw size={14} />
          <span className="ex-tool-label">Refresh</span>
        </button>
        {explorer.activeType && !explorer.description?.readOnly ? (
          <button
            onClick={() =>
              explorer.setSheet({ mode: "create", type: explorer.activeType!.name, entityId: null })
            }
            title="Create a record"
            type="button"
          >
            <Plus size={14} />
            <span className="ex-tool-label">New</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function StatusBar() {
  const explorer = useExplorer();
  const rows = useRows();
  const first = explorer.table?.pages[0];
  const last = explorer.table?.pages.at(-1);
  return (
    <footer className="ex-status">
      <span
        className={`ex-check ${!explorer.isLive ? "pinned" : explorer.connected ? "good" : "busy"}`}
      >
        <span className="ex-dot" />
        {!explorer.isLive
          ? `Pinned at #${explorer.basis.recordedPosition}`
          : explorer.connected
            ? "Live"
            : "Connecting…"}
        {first ? (
          <span className="ex-muted">
            {" "}
            · {rows.length.toLocaleString()}
            {first.totalCount !== null ? ` of ${first.totalCount.toLocaleString()}` : ""} rows ·{" "}
            {first.source === "entities" ? "entity pages" : "query window"} · {last?.durationMs} ms
          </span>
        ) : null}
        {explorer.isLive &&
        explorer.basis.validAt === undefined &&
        explorer.nextBoundary !== null ? (
          <span className="ex-muted">
            {" "}
            · next valid-time change {relative(explorer.nextBoundary)}
          </span>
        ) : null}
      </span>
      <span className="ex-keys">
        <kbd>↑↓←→</kbd> move <kbd>Enter</kbd> edit <kbd>{MOD}-click</kbd> follow <kbd>⇧F12</kbd>{" "}
        references <kbd>{MOD}K</kbd> go to
      </span>
    </footer>
  );
}

export function BottomPanel() {
  const explorer = useExplorer();
  if (!explorer.panel) return null;
  return (
    <section
      aria-label={explorer.panel === "references" ? "References" : "Journal"}
      className="ex-panel"
    >
      <header className="ex-panel-tabs" role="tablist">
        <button
          aria-selected={explorer.panel === "references"}
          onClick={() => explorer.setPanel("references")}
          role="tab"
          type="button"
        >
          References
        </button>
        <button
          aria-selected={explorer.panel === "journal"}
          onClick={() => explorer.setPanel("journal")}
          role="tab"
          type="button"
        >
          Journal <span className="ex-panel-count">#{explorer.head}</span>
        </button>
        <span className="ex-files-gap" />
        <button
          aria-label="Close the panel"
          className="ex-icon"
          onClick={() => explorer.setPanel(null)}
          type="button"
        >
          <X size={13} />
        </button>
      </header>
      <div className="ex-panel-body">
        {explorer.panel === "references" ? <ReferencesList /> : <JournalList />}
      </div>
    </section>
  );
}

function ReferencesList() {
  const explorer = useExplorer();
  const selection = explorer.selection;
  const entityId = selection && selection.kind !== "transaction" ? selection.entityId : null;
  const [found, setFound] = useState<References | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setFound(null);
    setError(null);
    if (!entityId) return;
    let current = true;
    call({ _tag: "References", entityId, basis: explorer.basis }).then(
      (references) => current && setFound(references),
      (cause) => current && setError(String((cause as Error).message ?? cause)),
    );
    return () => {
      current = false;
    };
  }, [entityId, explorer.basis, explorer.head]);
  if (!entityId)
    return (
      <p className="ex-muted ex-panel-empty">
        Select a row and press <kbd>⇧F12</kbd> to see every entity that points at it.
      </p>
    );
  if (error) return <p className="ex-error ex-panel-empty">{error}</p>;
  if (!found)
    return (
      <p className="ex-muted ex-panel-empty">
        Finding references to <code>{entityId}</code>…
      </p>
    );
  const groups = new Map<string, References["references"][number][]>();
  for (const reference of found.references) {
    const key = `${reference.sourceType ?? "untyped"}\u0000${reference.attribute}`;
    groups.set(key, [...(groups.get(key) ?? []), reference]);
  }
  return (
    <div className="ex-refs">
      <p className="ex-refs-summary">
        {found.total ?? found.references.length} references to <code>{entityId}</code>
        {found.truncated ? " · showing the first 200" : ""}
      </p>
      {found.references.length === 0 ? (
        <p className="ex-muted">Nothing points here at this basis.</p>
      ) : null}
      {[...groups].map(([key, references]) => {
        const [type, attribute] = key.split("\u0000");
        return (
          <div className="ex-refs-file" key={key}>
            <div className="ex-refs-file-name">
              <Table2 size={12} />
              {type} <code className="ex-muted">{attribute}</code>
              <span className="ex-panel-count">{references.length}</span>
            </div>
            {references.map((reference) => (
              <button
                className="ex-ref-row"
                key={reference.source}
                onClick={() => explorer.follow(reference.source)}
                type="button"
              >
                <code className="ex-ref-id">{reference.source}</code>
                <span className="ex-ref-preview">{reference.label}</span>
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}

const summarize = (tx: Transaction) => {
  const types = new Map<string, number>();
  for (const change of tx.changes)
    if (change.op === "assert")
      types.set(change.entityType ?? "?", (types.get(change.entityType ?? "?") ?? 0) + 1);
  const retracted = tx.changes.filter((change) => change.op === "retract").length;
  return [
    ...[...types].map(([type, n]) => `+${n} ${type}`),
    ...(retracted ? [`−${retracted}`] : []),
  ].join(" · ");
};

function JournalList() {
  const explorer = useExplorer();
  const [older, setOlder] = useState<readonly Transaction[]>([]);
  const [loading, setLoading] = useState(false);
  const all = useMemo(
    () => [
      ...explorer.feed,
      ...older.filter((tx) => !explorer.feed.some((f) => f.txId === tx.txId)),
    ],
    [explorer.feed, older],
  );
  all.forEach(remember);
  const oldest = all.at(-1)?.position;
  const more = async () => {
    if (oldest === undefined || oldest <= 1) return;
    setLoading(true);
    try {
      const page = await call({ _tag: "Journal", before: oldest, limit: 60 });
      setOlder((list) => [...list, ...page.transactions]);
    } finally {
      setLoading(false);
    }
  };
  const selected = explorer.selection?.kind === "transaction" ? explorer.selection.txId : null;
  return (
    <div className="ex-journal">
      {all.map((tx) => (
        <div
          aria-current={tx.txId === selected}
          className={`ex-journal-row${explorer.basis.recordedPosition === tx.position ? " pinned" : ""}`}
          key={tx.txId}
        >
          <button
            className="ex-journal-main"
            onClick={() => explorer.select({ kind: "transaction", txId: tx.txId })}
            type="button"
          >
            <span className="ex-tx-pos">#{tx.position}</span>
            <span className="ex-muted ex-journal-when" title={new Date(tx.instant).toISOString()}>
              {relative(tx.instant)}
            </span>
            <span className="ex-tx-actor">{tx.actor ?? "—"}</span>
            <code className="ex-tx-command">{tx.commandId ?? ""}</code>
            <span className="ex-journal-summary">{summarize(tx)}</span>
          </button>
          <button
            aria-label={`View as of #${tx.position}`}
            className="ex-icon"
            onClick={() => explorer.pin(tx.position)}
            title={`View every table as of #${tx.position}`}
            type="button"
          >
            <Pin size={12} />
          </button>
        </div>
      ))}
      {oldest !== undefined && oldest > 1 ? (
        <button
          className="ex-link ex-journal-more"
          disabled={loading}
          onClick={() => void more()}
          type="button"
        >
          {loading ? "Reading…" : "Older transactions"}
        </button>
      ) : null}
    </div>
  );
}

/** Subsequence match, earlier and tighter matches first. */
function score(query: string, text: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 1000 - t.length;
  const at = t.indexOf(q);
  if (at >= 0) return 500 - at;
  let index = 0;
  for (const char of t) if (char === q[index]) index++;
  return index === q.length ? 100 - t.length : -1;
}

export function QuickOpen() {
  const explorer = useExplorer();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const rows = useRows();
  useEffect(() => {
    if (explorer.quickOpen) {
      setQuery("");
      setCursor(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [explorer.quickOpen]);
  const items = useMemo(() => {
    const types = explorer.description?.types ?? [];
    const candidates = [
      ...types.map((type) => ({
        key: `type:${type.name}`,
        label: type.name,
        detail: "entity type",
        go: () => explorer.openType(type.name),
      })),
      ...types.flatMap((type) =>
        type.attributes.map((attribute) => ({
          key: `attr:${type.name}:${attribute.key}`,
          label: attribute.key,
          detail: `${type.name} · ${attribute.type}`,
          go: () => {
            explorer.openType(type.name);
            explorer.setSort({ attribute: attribute.key, direction: "asc" });
          },
        })),
      ),
      ...rows.slice(0, 400).map((row) => ({
        key: `row:${row.id}`,
        label: row.id,
        detail: valueText(
          row.facts.find((fact) => /\/(name|summary|title)$/.test(fact.attribute))?.value,
        ),
        go: () => explorer.select({ kind: "entity", entityId: row.id }),
      })),
    ];
    const ranked = candidates
      .map((item) => ({
        ...item,
        score: Math.max(score(query, item.label), score(query, item.detail) - 200),
      }))
      .filter((item) => item.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 40);
    // An exact entity ID opens that entity, even when it is not in the loaded rows.
    return /^[a-z][\w-]*:\S+$/i.test(query) && !ranked.some((item) => item.label === query)
      ? [
          {
            key: `open:${query}`,
            label: query,
            detail: "open entity",
            score: 2000,
            go: () => explorer.follow(query),
          },
          ...ranked,
        ]
      : ranked;
  }, [query, explorer, rows]);
  if (!explorer.quickOpen) return null;
  const choose = (index: number) => {
    const item = items[index];
    explorer.setQuickOpen(false);
    item?.go();
  };
  return (
    <div className="ex-palette-backdrop" onMouseDown={() => explorer.setQuickOpen(false)}>
      <div
        aria-label="Go to a type, attribute or entity"
        className="ex-palette"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <input
          aria-label="Search types, attributes and entities"
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(0);
          }}
          placeholder="Go to a type, attribute, or entity ID such as worker:0042…"
          ref={input}
          value={query}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setCursor((at) => Math.min(items.length - 1, at + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setCursor((at) => Math.max(0, at - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(cursor);
            } else if (event.key === "Escape") {
              event.preventDefault();
              explorer.setQuickOpen(false);
            }
          }}
        />
        <ul role="listbox">
          {items.map((item, index) => (
            <li aria-selected={index === cursor} key={item.key} role="option">
              <button
                onClick={() => choose(index)}
                onMouseMove={() => setCursor(index)}
                type="button"
              >
                <code className="ex-palette-label">{item.label}</code>
                <span className="ex-palette-detail">{item.detail}</span>
              </button>
            </li>
          ))}
          {items.length ? null : <li className="ex-muted ex-palette-empty">Nothing matches.</li>}
        </ul>
      </div>
    </div>
  );
}

export function Toast() {
  const { toast } = useExplorer();
  return toast ? (
    <div className="ex-toast" role="status">
      {toast}
    </div>
  ) : null;
}

export const describeBasis = (validAt: number | undefined) =>
  validAt === undefined ? "now" : formatInstant(validAt);
