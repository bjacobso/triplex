/**
 * The table: one row per entity, one column per attribute the release declares,
 * and each cell the facts visible at the basis. Cells only read; hover shows a
 * fact's intervals and receipt, click inspects, Enter or F2 opens the record sheet.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { ArrowDown, ArrowUp, ArrowUpRight, Filter as FilterIcon, Hourglass } from "lucide-react";

import type { AttributeView, Fact, FilterOp, Row } from "../shared/protocol.js";
import {
  backdated,
  formatInstant,
  interval,
  localName,
  numeric,
  relative,
  valueText,
} from "./format.js";
import { MOD, useExplorer, type Hover } from "./model.js";
import { useTransaction } from "./transactions.js";

const defaultWidth = (attribute: AttributeView) =>
  attribute.kind === "ref"
    ? 190
    : attribute.kind === "text"
      ? 210
      : attribute.kind === "boolean"
        ? 92
        : attribute.kind === "instant" || attribute.kind === "date"
          ? 124
          : numeric(attribute)
            ? 112
            : 132;

/** Name-like columns first, then required ones, then the rest, each alphabetical. */
export const columnsOf = (attributes: readonly AttributeView[], hidden: readonly string[]) =>
  attributes
    .filter((attribute) => !hidden.includes(attribute.key))
    .map((attribute) => ({
      attribute,
      rank: /\/(name|title|summary|label)$/.test(attribute.key) ? 0 : attribute.required ? 1 : 2,
    }))
    .sort((a, b) => a.rank - b.rank || a.attribute.key.localeCompare(b.attribute.key))
    .map(({ attribute }) => attribute);

const hue = (text: string) => {
  let h = 0;
  for (const char of text) h = (h * 31 + char.charCodeAt(0)) % 360;
  return h;
};

export function useRows(): readonly Row[] {
  const { table } = useExplorer();
  return useMemo(() => {
    const seen = new Set<string>();
    const rows: Row[] = [];
    for (const page of table?.pages ?? [])
      for (const row of page.rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        rows.push(row);
      }
    return rows;
  }, [table?.pages]);
}

export function useLabels(): Readonly<Record<string, string>> {
  const { table } = useExplorer();
  return useMemo(
    () => Object.assign({}, ...(table?.pages ?? []).map((page) => page.labels)),
    [table?.pages],
  );
}

function CellValue({
  attribute,
  fact,
  labels,
}: {
  readonly attribute: AttributeView;
  readonly fact: Fact;
  readonly labels: Readonly<Record<string, string>>;
}) {
  const value = fact.value;
  if (value.type === "ref")
    return (
      <span className="ex-ref" data-ref={value.value} title={value.value}>
        <span className="ex-ref-label">{labels[value.value] ?? value.value}</span>
        <button
          aria-label={`Open ${value.value}`}
          className="ex-ref-go"
          data-follow={value.value}
          tabIndex={-1}
          type="button"
        >
          <ArrowUpRight size={12} />
        </button>
      </span>
    );
  if (value.type === "boolean")
    return (
      <span className={`ex-bool ${value.value ? "yes" : "no"}`}>{value.value ? "Yes" : "No"}</span>
    );
  if (attribute.kind === "enum" && value.type === "string")
    return (
      <span className="ex-enum" style={{ "--h": hue(value.value) } as React.CSSProperties}>
        {value.value}
      </span>
    );
  if (value.type === "sealed") return <span className="ex-sealed">sealed</span>;
  return (
    <span className={value.type === "number" || value.type === "datetime" ? "ex-num" : "ex-text"}>
      {valueText(value, labels)}
    </span>
  );
}

function FilterPopover({
  attribute,
  onClose,
}: {
  readonly attribute: AttributeView;
  readonly onClose: () => void;
}) {
  const explorer = useExplorer();
  const ops: FilterOp[] =
    attribute.kind === "text"
      ? ["contains", "=", "!=", "empty", "not-empty"]
      : numeric(attribute) || attribute.kind === "instant"
        ? [">=", "<", "=", "!=", ">", "<=", "empty", "not-empty"]
        : ["=", "!=", "empty", "not-empty"];
  const existing = explorer.table?.filters.find((filter) => filter.attribute === attribute.key);
  const [op, setOp] = useState<FilterOp>(existing?.op ?? ops[0]!);
  const [text, setText] = useState(
    existing?.value === undefined
      ? ""
      : attribute.kind === "instant"
        ? new Date(Number(existing.value)).toISOString().slice(0, 10)
        : String(existing.value),
  );
  const needsValue = op !== "empty" && op !== "not-empty";
  const apply = () => {
    const value = !needsValue
      ? undefined
      : attribute.kind === "boolean"
        ? text === "true"
        : numeric(attribute)
          ? Number(text)
          : attribute.kind === "instant"
            ? Date.parse(`${text}T00:00:00Z`)
            : text;
    explorer.addFilter({ attribute: attribute.key, op, ...(value === undefined ? {} : { value }) });
    onClose();
  };
  return (
    <div
      className="ex-popover"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="ex-popover-title">
        Filter <code>{attribute.key}</code>
      </div>
      <form
        className="ex-popover-form"
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
      >
        <select
          aria-label="Operator"
          onChange={(event) => setOp(event.target.value as FilterOp)}
          value={op}
        >
          {ops.map((candidate) => (
            <option key={candidate} value={candidate}>
              {candidate === "not-empty"
                ? "has a value"
                : candidate === "empty"
                  ? "is empty"
                  : candidate}
            </option>
          ))}
        </select>
        {!needsValue ? null : attribute.kind === "enum" ? (
          <select aria-label="Value" onChange={(event) => setText(event.target.value)} value={text}>
            <option value="">choose…</option>
            {attribute.enumValues.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        ) : attribute.kind === "boolean" ? (
          <select aria-label="Value" onChange={(event) => setText(event.target.value)} value={text}>
            <option value="">choose…</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        ) : (
          <input
            aria-label="Value"
            autoFocus
            onChange={(event) => setText(event.target.value)}
            placeholder={attribute.kind === "ref" ? `${attribute.ref?.toLowerCase()}:…` : "value"}
            type={attribute.kind === "instant" ? "date" : numeric(attribute) ? "number" : "text"}
            value={text}
          />
        )}
        <div className="ex-popover-actions">
          {existing ? (
            <button
              className="ex-link ex-muted"
              onClick={() => {
                explorer.removeFilter(explorer.table!.filters.indexOf(existing));
                onClose();
              }}
              type="button"
            >
              Remove
            </button>
          ) : (
            <span />
          )}
          <button className="ex-button primary" disabled={needsValue && text === ""} type="submit">
            Apply
          </button>
        </div>
      </form>
    </div>
  );
}

function HeaderCell({
  attribute,
  width,
}: {
  readonly attribute: AttributeView;
  readonly width: number;
}) {
  const explorer = useExplorer();
  const sort = explorer.table?.sort;
  const sorted = sort?.attribute === attribute.key ? sort.direction : undefined;
  const filtered =
    explorer.table?.filters.some((filter) => filter.attribute === attribute.key) ?? false;
  const [filtering, setFiltering] = useState(false);
  useEffect(() => {
    if (!filtering) return;
    const close = () => setFiltering(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [filtering]);
  const cycle = () =>
    explorer.setSort(
      sorted === undefined
        ? { attribute: attribute.key, direction: "asc" }
        : sorted === "asc"
          ? { attribute: attribute.key, direction: "desc" }
          : undefined,
    );
  const startResize = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const start = event.clientX;
    const move = (e: globalThis.MouseEvent) =>
      explorer.resizeColumn(attribute.key, Math.max(72, width + e.clientX - start));
    const up = () => (
      window.removeEventListener("mousemove", move), window.removeEventListener("mouseup", up)
    );
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  return (
    <th
      aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"}
      className={`${numeric(attribute) ? "num" : ""}${sorted ? " sorted" : ""}`}
      scope="col"
    >
      <button
        className="ex-th-main"
        onClick={cycle}
        title={`${attribute.key} · ${attribute.type}${attribute.cardinality === "many" ? " · many" : ""}. Click to sort.`}
        type="button"
      >
        <span className="ex-th-name">{localName(attribute.key)}</span>
        {attribute.required ? (
          <span className="ex-th-req" title="required">
            •
          </span>
        ) : null}
        {sorted === "asc" ? (
          <ArrowUp size={12} />
        ) : sorted === "desc" ? (
          <ArrowDown size={12} />
        ) : null}
      </button>
      <span className="ex-th-type">
        {attribute.kind === "ref" ? `→ ${attribute.ref}` : attribute.kind}
        {attribute.cardinality === "many" ? " · many" : ""}
      </span>
      <button
        aria-label={`Filter ${attribute.key}`}
        className={`ex-th-filter${filtered ? " on" : ""}`}
        onClick={() => setFiltering(!filtering)}
        onMouseDown={(event) => event.stopPropagation()}
        type="button"
      >
        <FilterIcon size={11} />
      </button>
      {filtering ? (
        <FilterPopover attribute={attribute} onClose={() => setFiltering(false)} />
      ) : null}
      <span aria-hidden className="ex-resize" onMouseDown={startResize} />
    </th>
  );
}

interface HoverAt extends Hover {
  readonly x: number;
  readonly y: number;
  readonly below: boolean;
}

export function Grid() {
  const explorer = useExplorer();
  const { activeType: type, table, selection } = explorer;
  const rows = useRows();
  const labels = useLabels();
  const scroller = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [hoverAt, setHoverAt] = useState<HoverAt | null>(null);

  const columns = useMemo(
    () => (type ? columnsOf(type.attributes, table?.hidden ?? []) : []),
    [type, table?.hidden],
  );
  const byRow = useMemo(() => {
    const map = new Map<string, Map<string, Fact[]>>();
    for (const row of rows) {
      const cells = new Map<string, Fact[]>();
      for (const fact of row.facts)
        cells.set(fact.attribute, [...(cells.get(fact.attribute) ?? []), fact]);
      map.set(row.id, cells);
    }
    return map;
  }, [rows]);

  const selectedEntity = selection && selection.kind !== "transaction" ? selection.entityId : null;
  const selectedAttribute = selection?.kind === "cell" ? selection.attribute : null;
  const last = table?.pages.at(-1);
  const total = table?.pages[0]?.totalCount ?? null;

  // Keep the selected cell in view as the keyboard moves it.
  useEffect(() => {
    if (!selectedEntity) return;
    const cell = scroller.current?.querySelector(
      `[data-entity="${CSS.escape(selectedEntity)}"]${selectedAttribute ? `[data-attr="${CSS.escape(selectedAttribute)}"]` : ""}`,
    );
    cell?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedEntity, selectedAttribute]);

  const cellAt = (target: EventTarget) =>
    (target as HTMLElement).closest<HTMLElement>("td[data-entity]");

  const onMove = (event: MouseEvent) => {
    const cell = cellAt(event.target);
    const entityId = cell?.dataset["entity"];
    const attribute = cell?.dataset["attr"];
    if (!cell || !entityId || !attribute) {
      window.clearTimeout(timer.current);
      if (hoverAt)
        timer.current = window.setTimeout(() => (setHoverAt(null), explorer.setHover(null)), 120);
      return;
    }
    if (hoverAt?.entityId === entityId && hoverAt.attribute === attribute) return;
    window.clearTimeout(timer.current);
    explorer.setHover({ entityId, attribute });
    // Like an editor's hover tooltip: wait for the pointer to settle, then follow it from cell to cell.
    timer.current = window.setTimeout(
      () => {
        const rect = cell.getBoundingClientRect();
        const below = rect.bottom + 240 < window.innerHeight;
        setHoverAt({
          entityId,
          attribute,
          x: Math.min(rect.left, window.innerWidth - 400),
          y: below ? rect.bottom + 4 : rect.top - 4,
          below,
        });
      },
      hoverAt ? 60 : 380,
    );
  };
  const onLeave = () => {
    window.clearTimeout(timer.current);
    setHoverAt(null);
    explorer.setHover(null);
  };

  const onClick = (event: MouseEvent) => {
    const followTarget = (event.target as HTMLElement).closest<HTMLElement>("[data-follow]")
      ?.dataset["follow"];
    const refTarget = (event.target as HTMLElement).closest<HTMLElement>("[data-ref]")?.dataset[
      "ref"
    ];
    if (followTarget) return explorer.follow(followTarget);
    if (refTarget && (event.metaKey || event.ctrlKey)) return explorer.follow(refTarget);
    const cell = cellAt(event.target);
    const entityId = cell?.dataset["entity"];
    if (!entityId) return;
    const attribute = cell.dataset["attr"];
    explorer.select(
      attribute ? { kind: "cell", entityId, attribute } : { kind: "entity", entityId },
    );
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!type || rows.length === 0) return;
    const rowIndex = Math.max(
      0,
      rows.findIndex((row) => row.id === selectedEntity),
    );
    const colIndex = selectedAttribute
      ? columns.findIndex((column) => column.key === selectedAttribute)
      : -1;
    const move = (r: number, c: number) => {
      const row = rows[Math.min(rows.length - 1, Math.max(0, r))]!;
      const column = c < 0 ? undefined : columns[Math.min(columns.length - 1, c)];
      explorer.select(
        column
          ? { kind: "cell", entityId: row.id, attribute: column.key }
          : { kind: "entity", entityId: row.id },
      );
      if (r >= rows.length - 5) explorer.loadMore();
    };
    const keys: Record<string, () => void> = {
      ArrowDown: () => move(selectedEntity ? rowIndex + 1 : 0, colIndex),
      ArrowUp: () => move(rowIndex - 1, colIndex),
      ArrowRight: () => move(rowIndex, colIndex + 1),
      ArrowLeft: () => move(rowIndex, colIndex - 1),
      PageDown: () => move(rowIndex + 20, colIndex),
      PageUp: () => move(rowIndex - 20, colIndex),
      Home: () => move(0, colIndex),
      End: () => move(rows.length - 1, colIndex),
      Escape: () => explorer.select(null),
      Enter: () =>
        selectedEntity &&
        explorer.setSheet({ mode: "edit", type: type.name, entityId: selectedEntity }),
      F2: () =>
        selectedEntity &&
        explorer.setSheet({ mode: "edit", type: type.name, entityId: selectedEntity }),
    };
    const run =
      event.key === "F12" && event.shiftKey
        ? () => explorer.setPanel("references")
        : keys[event.key];
    if (!run) return;
    event.preventDefault();
    run();
  };

  const onScroll = () => {
    const element = scroller.current;
    if (element && element.scrollTop + element.clientHeight > element.scrollHeight - 400)
      explorer.loadMore();
  };

  if (!type)
    return (
      <div className="ex-grid-empty">
        {explorer.description ? "This release declares no entity types." : "Loading the release…"}
      </div>
    );
  const flashing = table && Date.now() - table.flashAt < 2000 ? table.flash : undefined;

  return (
    <div
      aria-label={`${type.name} table`}
      className="ex-grid"
      onKeyDown={onKeyDown}
      onMouseLeave={onLeave}
      onMouseMove={onMove}
      onScroll={onScroll}
      ref={scroller}
      role="grid"
      tabIndex={0}
    >
      <table
        onClick={onClick}
        onDoubleClick={(event) => {
          const entityId = cellAt(event.target)?.dataset["entity"];
          if (entityId) explorer.setSheet({ mode: "edit", type: type.name, entityId });
        }}
      >
        <colgroup>
          <col style={{ width: 168 }} />
          {columns.map((column) => (
            <col
              key={column.key}
              style={{ width: table?.widths[column.key] ?? defaultWidth(column) }}
            />
          ))}
          <col />
        </colgroup>
        <thead>
          <tr>
            <th className="ex-th-id" scope="col">
              <span className="ex-th-name">entity</span>
              <span className="ex-th-type">
                {total === null ? `${rows.length}` : `${rows.length} of ${total.toLocaleString()}`}
              </span>
            </th>
            {columns.map((column) => (
              <HeaderCell
                attribute={column}
                key={column.key}
                width={table?.widths[column.key] ?? defaultWidth(column)}
              />
            ))}
            <th aria-hidden className="ex-th-fill" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const cells = byRow.get(row.id)!;
            const rowSelected = row.id === selectedEntity;
            return (
              <tr
                aria-selected={rowSelected}
                className={rowSelected ? "selected" : undefined}
                key={row.id}
              >
                <td
                  className={`ex-id${rowSelected && !selectedAttribute ? " current" : ""}`}
                  data-entity={row.id}
                >
                  <code>{row.id}</code>
                </td>
                {columns.map((column) => {
                  const facts = cells.get(column.key) ?? [];
                  const key = `${row.id}\u0000${column.key}`;
                  const current = rowSelected && selectedAttribute === column.key;
                  const validAt = table?.pages[0]?.basis.validAt ?? Date.now();
                  // Mark only what needs attention: a value that stops being true within 30 days.
                  const ends =
                    explorer.timeMarks &&
                    facts.some(
                      (fact) => fact.validTo !== null && fact.validTo - validAt < 30 * 86_400_000,
                    );
                  return (
                    <td
                      aria-selected={current}
                      className={[
                        numeric(column) ? "num" : "",
                        current ? "current" : "",
                        flashing?.has(key) ? "flash" : "",
                        facts.length === 0 ? "empty" : "",
                        column.cardinality === "many" ? "many" : "",
                      ].join(" ")}
                      data-attr={column.key}
                      data-entity={row.id}
                      key={`${column.key}:${flashing?.has(key) ? table!.flashAt : 0}`}
                    >
                      <div className="ex-cell">
                        {facts.map((fact) => (
                          <CellValue attribute={column} fact={fact} key={fact.id} labels={labels} />
                        ))}
                        {ends ? (
                          <span
                            className="ex-marks"
                            title={`Ends ${formatInstant(Math.min(...facts.flatMap((fact) => (fact.validTo === null ? [] : [fact.validTo]))))}`}
                          >
                            <Hourglass aria-label="ends within 30 days" size={11} />
                          </span>
                        ) : null}
                      </div>
                    </td>
                  );
                })}
                <td aria-hidden className="ex-fill" />
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="ex-grid-foot">
        {table?.error ? (
          <span className="ex-error">{table.error}</span>
        ) : table?.loading ? (
          <span className="ex-muted">
            <span className="ex-pulse" /> Reading…
          </span>
        ) : last?.nextCursor ? (
          <button className="ex-link" onClick={explorer.loadMore} type="button">
            Load more rows
          </button>
        ) : rows.length === 0 ? (
          <span className="ex-muted">No {type.name} entities match at this basis.</span>
        ) : (
          <span className="ex-muted">
            All {rows.length.toLocaleString()} rows, read at position #
            {last?.basis.recordedPosition}
          </span>
        )}
      </div>
      {hoverAt ? <HoverCard at={hoverAt} /> : null}
    </div>
  );
}

/** The facts behind one cell, for the hover card and the value line. */
export function useCellFacts(
  entityId: string | undefined,
  attribute: string | undefined,
): readonly Fact[] {
  const rows = useRows();
  return useMemo(
    () =>
      rows
        .find((row) => row.id === entityId)
        ?.facts.filter((fact) => fact.attribute === attribute) ?? [],
    [rows, entityId, attribute],
  );
}

function FactReceipt({ fact }: { readonly fact: Fact }) {
  const tx = useTransaction(fact.txId);
  return (
    <span className="ex-hover-receipt">
      {tx ? (
        <>
          #{tx.position} · <b>{tx.actor ?? "no actor"}</b>
          {tx.commandId ? (
            <>
              {" "}
              · <code>{tx.commandId}</code>
            </>
          ) : null}
        </>
      ) : (
        <span className="ex-muted">reading receipt…</span>
      )}
    </span>
  );
}

function HoverCard({ at }: { readonly at: HoverAt }) {
  const explorer = useExplorer();
  const attribute = explorer.activeType?.attributes.find(
    (candidate) => candidate.key === at.attribute,
  );
  const facts = useCellFacts(at.entityId, at.attribute);
  const labels = useLabels();
  if (!attribute) return null;
  return (
    <div
      className="ex-hover"
      role="tooltip"
      style={{ left: at.x, top: at.y, transform: at.below ? undefined : "translateY(-100%)" }}
    >
      <div className="ex-hover-head">
        <span>{attribute.key}</span>
        <span className="ex-hover-source">
          {attribute.type}
          {attribute.cardinality === "many" ? " · many" : ""}
        </span>
      </div>
      {facts.length === 0 ? (
        <p className="ex-hover-doc">
          No visible fact at this basis.{attribute.required ? " The release requires one." : ""}
        </p>
      ) : null}
      {facts.map((fact) => (
        <div className="ex-hover-fact" key={fact.id}>
          <div className="ex-hover-value">
            {valueText(fact.value, labels)}
            {fact.value.type === "ref" ? (
              <code className="ex-muted"> {fact.value.value}</code>
            ) : null}
          </div>
          <div className="ex-hover-row">
            <span className="ex-hover-label">valid</span>
            <span>{interval(fact.validFrom, fact.validTo)}</span>
          </div>
          <div className="ex-hover-row">
            <span className="ex-hover-label">recorded</span>
            <span>
              {formatInstant(fact.recordedAt)} · {relative(fact.recordedAt)}
              {backdated(fact) ? <span className="ex-chip ex-chip-warn">backdated</span> : null}
            </span>
          </div>
          <div className="ex-hover-row">
            <span className="ex-hover-label">by</span>
            <FactReceipt fact={fact} />
          </div>
        </div>
      ))}
      <div className="ex-hover-foot">
        Click to inspect history
        {facts.some((fact) => fact.value.type === "ref") ? ` · ${MOD}-click to follow` : ""} · Enter
        to edit
      </div>
    </div>
  );
}

/** One line under the table about the hovered or selected cell, like the reader's type line. */
export function ValueLine() {
  const explorer = useExplorer();
  const cell = explorer.hover ?? (explorer.selection?.kind === "cell" ? explorer.selection : null);
  const facts = useCellFacts(cell?.entityId, cell?.attribute);
  const labels = useLabels();
  const attribute = explorer.activeType?.attributes.find(
    (candidate) => candidate.key === cell?.attribute,
  );
  const first = facts[0];
  const tx = useTransaction(first?.txId);
  return (
    <div className="ex-valueline">
      {!cell || !attribute ? (
        <span className="ex-muted">
          Hover a cell to see when it became true and who recorded it. Click to inspect its history.
        </span>
      ) : (
        <>
          <span className="ex-valueline-kind">{attribute.type}</span>
          <code className="ex-valueline-attr">{attribute.key}</code>
          <span className="ex-valueline-value">
            {facts.length === 0 ? (
              <span className="ex-muted">empty</span>
            ) : (
              facts.map((fact) => valueText(fact.value, labels)).join(", ")
            )}
          </span>
          {first ? (
            <>
              <span className="ex-chip">valid {interval(first.validFrom, first.validTo)}</span>
              <span className="ex-chip">recorded {relative(first.recordedAt)}</span>
              {tx ? (
                <span className="ex-chip ex-chip-actor">
                  {tx.actor ?? "no actor"} · #{tx.position}
                </span>
              ) : null}
            </>
          ) : null}
          <span className="ex-valueline-aside">
            <code>{cell.entityId}</code>
          </span>
        </>
      )}
    </div>
  );
}
