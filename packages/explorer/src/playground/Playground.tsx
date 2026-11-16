/**
 * The playground page: a bundle's types, seed commands and saved queries on the
 * left, and the explorer over the database they build on the right. The whole
 * database runs in the page; a share link carries the bundle in its hash.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  Check,
  Link,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  RotateCcw,
  Sun,
  Trash2,
} from "lucide-react";

import { Workspace } from "../app/App.js";
import { setTransport } from "../app/client.js";
import { formatInstant } from "../app/format.js";
import { useExplorer, ExplorerRoot, MOD } from "../app/model.js";
import { BasisControl, QuickOpen, Toast } from "../app/parts.js";
import { RecordSheet } from "../app/sheet.js";
import {
  decodeBundle,
  decodeHash,
  encodeBundle,
  MAX_LINK_BYTES,
  type Bundle,
  type SavedQuery,
} from "./bundle.js";
import { exampleBundle } from "./example.js";
import { messageOf, openPlayground, type PlaygroundDatabase } from "./runtime.js";

const THEME_KEY = "triplex-explorer-theme";

type Section = "types" | "seed" | "queries";
type Tab = Section | "notes";

interface Draft {
  readonly title: string;
  readonly description: string;
  readonly types: string;
  readonly seed: string;
  readonly queries: string;
}

/** Indented JSON that keeps short arrays of plain values, such as Datalog clauses, on one line. */
const pretty = (value: unknown, indent = ""): string => {
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const flat = `[${value.map((item) => pretty(item, inner)).join(", ")}]`;
    if (!flat.includes("\n") && flat.length + indent.length <= 88) return flat;
    return `[\n${value.map((item) => inner + pretty(item, inner)).join(",\n")}\n${indent}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (entries.length === 0) return "{}";
    const flat = `{ ${entries.map(([key, item]) => `${JSON.stringify(key)}: ${pretty(item, inner)}`).join(", ")} }`;
    if (!flat.includes("\n") && flat.length + indent.length <= 88) return flat;
    return `{\n${entries.map(([key, item]) => `${inner}${JSON.stringify(key)}: ${pretty(item, inner)}`).join(",\n")}\n${indent}}`;
  }
  return JSON.stringify(value);
};

const draftOf = (bundle: Bundle): Draft => ({
  title: bundle.title,
  description: bundle.description ?? "",
  types: pretty(bundle.types),
  seed: pretty(bundle.seed),
  queries: pretty(bundle.queries),
});

const sectionNames: Record<Section, string> = { types: "Types", seed: "Seed", queries: "Queries" };

/** The draft as a bundle, or the first problem with it, named by section. */
const parseDraft = (draft: Draft): { bundle: Bundle } | { error: string } => {
  const parsed: Record<string, unknown> = {};
  for (const section of ["types", "seed", "queries"] as const) {
    try {
      parsed[section] = JSON.parse(draft[section]);
    } catch (error) {
      return { error: `${sectionNames[section]}: ${messageOf(error)}` };
    }
  }
  try {
    return {
      bundle: decodeBundle({
        version: 1,
        title: draft.title,
        ...(draft.description.trim() === "" ? {} : { description: draft.description }),
        ...parsed,
      }),
    };
  } catch (error) {
    return { error: messageOf(error) };
  }
};

const sameBundle = (a: Bundle | undefined, b: Bundle | undefined) =>
  a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b);

interface Opened {
  /** The bundle the page opened with: from the link, or the example. */
  readonly bundle: Bundle;
  readonly fromLink: boolean;
  readonly linkError: string | null;
}

interface Applied {
  readonly db: PlaygroundDatabase;
  readonly bundle: Bundle;
  readonly revision: number;
}

export function Playground() {
  const [theme, setTheme] = useState<"light" | "dark">(
    () =>
      (localStorage.getItem(THEME_KEY) as "light" | "dark" | null) ??
      (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
  );
  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const [opened, setOpened] = useState<Opened | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [applied, setApplied] = useState<Applied | null>(null);
  const appliedRef = useRef(applied);
  appliedRef.current = applied;
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  /** The bundle the current link in the address bar carries. */
  const [linked, setLinked] = useState<Bundle | undefined>(undefined);
  const [shareStatus, setShareStatus] = useState("");
  const [pane, setPane] = useState(true);
  const [tab, setTab] = useState<Tab>("queries");
  const [queryIndex, setQueryIndex] = useState(0);

  const build = useCallback(async (bundle: Bundle) => {
    setBuilding(true);
    setBuildError(null);
    try {
      const db = await openPlayground(bundle);
      const previous = appliedRef.current;
      setTransport(db);
      setApplied({ db, bundle, revision: (previous?.revision ?? 0) + 1 });
      void previous?.db.dispose();
    } catch (error) {
      setBuildError(messageOf(error));
    } finally {
      setBuilding(false);
    }
  }, []);

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const open = (next: Opened) => {
      setOpened(next);
      setDraft(draftOf(next.bundle));
      if (next.fromLink) setLinked(next.bundle);
      void build(next.bundle);
    };
    decodeHash(window.location.hash).then(
      (bundle) =>
        open({ bundle: bundle ?? exampleBundle, fromLink: bundle !== null, linkError: null }),
      (error) =>
        open({
          bundle: exampleBundle,
          fromLink: false,
          linkError: `This link could not be opened (${messageOf(error)}). Showing the example instead.`,
        }),
    );
  }, [build]);

  const parsed = draft === null ? null : parseDraft(draft);
  const current = parsed !== null && "bundle" in parsed ? parsed.bundle : undefined;
  const dirty = current === undefined || !sameBundle(current, applied?.bundle);

  const run = () => {
    if (parsed === null) return;
    if ("error" in parsed) return setBuildError(parsed.error);
    void build(parsed.bundle);
  };

  const share = async () => {
    if (parsed === null) return;
    if ("error" in parsed) return setShareStatus(`Fix the bundle first: ${parsed.error}`);
    const hash = await encodeBundle(parsed.bundle);
    const url = `${window.location.origin}${window.location.pathname}${hash}`;
    window.history.replaceState(null, "", hash);
    setLinked(parsed.bundle);
    const size = `${(hash.length / 1024).toFixed(1)} KB`;
    const long =
      hash.length > MAX_LINK_BYTES ? ` It is ${size}; some chat apps cut links this long.` : "";
    try {
      await navigator.clipboard.writeText(url);
      setShareStatus(`Link copied (${size}). Anyone who opens it gets their own copy.${long}`);
    } catch {
      setShareStatus(`The address bar now holds the share link (${size}).${long}`);
    }
  };

  const state = !current
    ? "Bundle has errors"
    : sameBundle(current, linked)
      ? "Matches the link"
      : opened?.fromLink
        ? "Edited · copy a new link to share"
        : "Not shared yet";

  if (draft === null || opened === null) return <p className="pg-loading">Opening playground…</p>;

  const header = (
    <header className="ex-top pg-top">
      <div className="ex-title pg-title">
        <span className="ex-eyebrow">Triplex · playground</span>
        <input
          aria-label="Playground title"
          className="pg-title-input"
          maxLength={160}
          onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          value={draft.title}
        />
        <p>
          <span className={`pg-state${current && sameBundle(current, linked) ? " shared" : ""}`}>
            {state}
          </span>
          {applied
            ? ` · ${applied.bundle.types.length} types · ${applied.db.commands} seed commands · runs in this tab`
            : ""}
        </p>
      </div>
      {applied ? <BasisControl /> : null}
      <div className="pg-actions">
        <button
          className={`ex-button${dirty ? " primary" : ""}`}
          disabled={building}
          onClick={run}
          title={`Rebuild the database from the bundle (${MOD}↵)`}
          type="button"
        >
          <Play size={13} /> {building ? "Building…" : dirty ? "Run" : "Rebuild"}
        </button>
        <button
          className="ex-button"
          onClick={() => {
            setDraft(draftOf(opened.bundle));
            setShareStatus("");
            void build(opened.bundle);
          }}
          title={opened.fromLink ? "Back to the bundle the link opened" : "Back to the example"}
          type="button"
        >
          <RotateCcw size={13} /> Reset
        </button>
        <button className="ex-button" onClick={() => void share()} type="button">
          {current && sameBundle(current, linked) && shareStatus ? (
            <Check size={13} />
          ) : (
            <Link size={13} />
          )}{" "}
          Copy share link
        </button>
        <button
          aria-label="Toggle the theme"
          className="ex-icon"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          type="button"
        >
          {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
        </button>
      </div>
    </header>
  );

  const notices = (
    <>
      {opened.linkError ? <p className="pg-notice error">{opened.linkError}</p> : null}
      {shareStatus ? (
        <p className="pg-notice" role="status">
          {shareStatus}
        </p>
      ) : null}
    </>
  );

  if (!applied)
    return (
      <main className="ex-page pg-page">
        {header}
        {notices}
        <p className={buildError ? "pg-notice error" : "pg-loading"}>
          {buildError ?? "Building the database in this tab…"}
        </p>
      </main>
    );

  return (
    <ExplorerRoot key={applied.revision}>
      <main className="ex-page pg-page">
        {header}
        {notices}
        <div className={`pg-body${pane ? "" : " collapsed"}`}>
          {pane ? (
            <BundlePane
              applied={applied}
              buildError={buildError}
              draft={draft}
              onClose={() => setPane(false)}
              onRun={run}
              queryIndex={queryIndex}
              setDraft={setDraft}
              setQueryIndex={setQueryIndex}
              setTab={setTab}
              tab={tab}
            />
          ) : (
            <button
              aria-label="Show the bundle"
              className="ex-icon pg-open-pane"
              onClick={() => setPane(true)}
              type="button"
            >
              <PanelLeftOpen size={16} />
            </button>
          )}
          <Workspace />
          <NarrowSidebar wide={!pane} />
        </div>
        <QuickOpen />
        <RecordSheet />
        <Toast />
      </main>
    </ExplorerRoot>
  );
}

/** The bundle pane takes the types sidebar's room; the table tabs and quick open still list types. */
function NarrowSidebar({ wide }: { readonly wide: boolean }) {
  const explorer = useExplorer();
  const { setSidebar } = explorer;
  useEffect(() => setSidebar(wide && window.innerWidth >= 1280), [wide, setSidebar]);
  return null;
}

const hints: Record<Section, string> = {
  types:
    'Each type has a name and attributes keyed by alias: { key: ":ns/name", type: text | number | integer | boolean | date | instant | enum | ref, values (enum), target (ref), required, many, unique }. They are published as the live release.',
  seed: 'Each command is one attributed transaction, enforced against the release: { actor, at, create: [{ type, id, values, validFrom, validTo }], update: [...] }. Dates are ISO, epoch ms, "today" or "-30d". Updates replace values from their date on.',
  queries: "",
};

function BundlePane({
  applied,
  buildError,
  draft,
  setDraft,
  tab,
  setTab,
  queryIndex,
  setQueryIndex,
  onRun,
  onClose,
}: {
  readonly applied: Applied;
  readonly buildError: string | null;
  readonly draft: Draft;
  readonly setDraft: (draft: Draft) => void;
  readonly tab: Tab;
  readonly setTab: (tab: Tab) => void;
  readonly queryIndex: number;
  readonly setQueryIndex: (index: number) => void;
  readonly onRun: () => void;
  readonly onClose: () => void;
}) {
  const problems = [...(buildError ? [buildError] : []), ...applied.db.problems];
  const runKeys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onRun();
    }
  };
  return (
    <section aria-label="Bundle" className="pg-pane">
      <header className="ex-panel-tabs" role="tablist">
        {(["queries", "types", "seed", "notes"] as const).map((name) => (
          <button
            aria-selected={tab === name}
            key={name}
            onClick={() => setTab(name)}
            role="tab"
            type="button"
          >
            {name === "notes" ? "Notes" : sectionNames[name]}
          </button>
        ))}
        <span className="ex-files-gap" />
        <button aria-label="Hide the bundle" className="ex-icon" onClick={onClose} type="button">
          <PanelLeftClose size={14} />
        </button>
      </header>
      {problems.length > 0 ? (
        <ul className="pg-problems" role="alert">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}
      {tab === "queries" ? (
        <QueriesTab
          db={applied.db}
          draft={draft}
          index={queryIndex}
          onKeyDown={runKeys}
          setDraft={setDraft}
          setIndex={setQueryIndex}
        />
      ) : tab === "notes" ? (
        <div className="pg-section">
          <p className="ex-muted pg-hint">
            What the playground shows and what to try. It travels in the share link.
          </p>
          <textarea
            aria-label="Notes"
            className="pg-editor pg-prose"
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            value={draft.description}
          />
        </div>
      ) : (
        <div className="pg-section">
          <p className="ex-muted pg-hint">
            {hints[tab]} <kbd>{MOD}↵</kbd> runs.
          </p>
          <JsonEditor
            label={sectionNames[tab]}
            onChange={(text) => setDraft({ ...draft, [tab]: text })}
            onKeyDown={runKeys}
            value={draft[tab]}
          />
        </div>
      )}
      <footer className="pg-pane-foot ex-muted">
        Edits made in the table change only this tab's database. The share link carries the bundle.
      </footer>
    </section>
  );
}

function JsonEditor({
  label,
  value,
  onChange,
  onKeyDown,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (text: string) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  let error = "";
  try {
    JSON.parse(value);
  } catch (cause) {
    error = messageOf(cause);
  }
  return (
    <>
      <textarea
        aria-invalid={error !== ""}
        aria-label={`${label} JSON`}
        className="pg-editor"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Tab" && !event.shiftKey) {
            event.preventDefault();
            const target = event.currentTarget;
            const at = target.selectionStart;
            onChange(`${value.slice(0, at)}  ${value.slice(target.selectionEnd)}`);
            requestAnimationFrame(() => target.setSelectionRange(at + 2, at + 2));
            return;
          }
          onKeyDown(event);
        }}
        spellCheck={false}
        value={value}
      />
      {error ? <p className="ex-error pg-json-error">{error}</p> : null}
    </>
  );
}

const newQuery: SavedQuery = {
  name: "New query",
  query: { find: ["?e", "?a", "?v"], where: [["?e", "?a", "?v"]], limit: 50 },
};

type QueryRun =
  | {
      readonly kind: "rows";
      readonly rows: readonly Record<string, unknown>[];
      readonly ms: number;
    }
  | { readonly kind: "error"; readonly message: string };

function QueriesTab({
  db,
  draft,
  setDraft,
  index,
  setIndex,
  onKeyDown,
}: {
  readonly db: PlaygroundDatabase;
  readonly draft: Draft;
  readonly setDraft: (draft: Draft) => void;
  readonly index: number;
  readonly setIndex: (index: number) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const explorer = useExplorer();
  let queries: SavedQuery[] | null = null;
  try {
    const value: unknown = JSON.parse(draft.queries);
    if (Array.isArray(value)) queries = value as SavedQuery[];
  } catch {
    queries = null;
  }
  const selected = queries?.[Math.min(index, queries.length - 1)];
  const [text, setText] = useState(() => (selected ? pretty(selected) : ""));
  const [result, setResult] = useState<QueryRun | null>(null);
  const shown = useRef(index);
  useEffect(() => {
    if (shown.current === index) return;
    shown.current = index;
    setText(selected ? pretty(selected) : "");
    setResult(null);
  }, [index, selected]);

  const runQuery = useCallback(
    async (source: string) => {
      try {
        const saved = JSON.parse(source) as SavedQuery;
        const { rows, ms } = await db.query(saved.query, explorer.basis);
        setResult({ kind: "rows", rows, ms });
      } catch (error) {
        setResult({ kind: "error", message: messageOf(error) });
      }
    },
    [db, explorer.basis],
  );

  // A shown result follows the explorer's basis.
  const textRef = useRef(text);
  textRef.current = text;
  const hasResult = result !== null;
  useEffect(() => {
    if (hasResult) void runQuery(textRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [explorer.basis.recordedPosition, explorer.basis.validAt]);

  if (queries === null)
    return (
      <div className="pg-section">
        <p className="ex-muted pg-hint">The saved queries are not a JSON array; fix them here.</p>
        <JsonEditor
          label="Queries"
          onChange={(value) => setDraft({ ...draft, queries: value })}
          onKeyDown={onKeyDown}
          value={draft.queries}
        />
      </div>
    );

  const writeQueries = (next: SavedQuery[]) => setDraft({ ...draft, queries: pretty(next) });
  const edit = (value: string) => {
    setText(value);
    try {
      const saved = JSON.parse(value) as SavedQuery;
      writeQueries(queries.map((query, at) => (at === index ? saved : query)));
    } catch {
      // Keep the text; the editor shows the parse error.
    }
  };
  const rows = result?.kind === "rows" ? result.rows : [];
  const columns =
    result?.kind === "rows"
      ? [
          ...new Set([
            ...((selected?.query["find"] as string[] | undefined) ?? []).filter(
              (column) => typeof column === "string",
            ),
            ...rows.flatMap((row) => Object.keys(row)),
          ]),
        ]
      : [];

  return (
    <div className="pg-section">
      {draft.description.trim() ? <p className="pg-intro">{draft.description}</p> : null}
      <div className="pg-query-list" role="listbox" aria-label="Saved queries">
        {queries.map((query, at) => (
          <button
            aria-selected={at === index}
            key={at}
            onClick={() => setIndex(at)}
            role="option"
            type="button"
          >
            {query.name || `Query ${at + 1}`}
          </button>
        ))}
        <button
          className="pg-add"
          onClick={() => {
            writeQueries([...queries, newQuery]);
            setIndex(queries.length);
          }}
          type="button"
        >
          <Plus size={12} /> Query
        </button>
      </div>
      {selected ? (
        <>
          {selected.description ? <p className="ex-muted pg-hint">{selected.description}</p> : null}
          <JsonEditor
            label="Query"
            onChange={edit}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void runQuery(text);
              }
            }}
            value={text}
          />
          <div className="pg-query-actions">
            <button className="ex-button primary" onClick={() => void runQuery(text)} type="button">
              <Play size={13} /> Run query
            </button>
            <span className="ex-muted">
              <kbd>{MOD}↵</kbd> · at the explorer's basis:{" "}
              {explorer.isLive ? "live" : `#${explorer.basis.recordedPosition}`}, valid{" "}
              {explorer.basis.validAt === undefined ? "now" : formatInstant(explorer.basis.validAt)}
            </span>
            <span className="ex-files-gap" />
            <button
              aria-label="Delete this query"
              className="ex-icon"
              onClick={() => {
                const next = queries.filter((_, at) => at !== index);
                const at = Math.max(0, index - 1);
                writeQueries(next);
                shown.current = at;
                setIndex(at);
                setText(next[at] ? pretty(next[at]) : "");
                setResult(null);
              }}
              type="button"
            >
              <Trash2 size={14} />
            </button>
          </div>
          {result?.kind === "error" ? (
            <p className="ex-error pg-json-error">{result.message}</p>
          ) : null}
          {result?.kind === "rows" ? (
            <div className="pg-results">
              <p className="ex-muted">
                {rows.length} {rows.length === 1 ? "row" : "rows"} · {result.ms.toFixed(1)} ms
              </p>
              {rows.length > 0 ? (
                <table>
                  <thead>
                    <tr>
                      {columns.map((column) => (
                        <th key={column}>{column}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, at) => (
                      <tr key={at}>
                        {columns.map((column) => (
                          <td key={column}>
                            <ResultValue value={row[column]} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </div>
          ) : null}
        </>
      ) : (
        <p className="ex-muted pg-hint">No saved queries. Add one to keep it in the share link.</p>
      )}
    </div>
  );
}

const ENTITY_ID = /^[a-z][\w-]*:[^\s]+$/i;

/** Entity IDs open the entity in the explorer; other values print as JSON. */
function ResultValue({ value }: { readonly value: unknown }) {
  const explorer = useExplorer();
  if (typeof value === "string" && ENTITY_ID.test(value) && !value.startsWith(":"))
    return (
      <button className="ex-link" onClick={() => explorer.follow(value)} type="button">
        {value}
      </button>
    );
  return <code>{typeof value === "string" ? value : JSON.stringify(value)}</code>;
}
