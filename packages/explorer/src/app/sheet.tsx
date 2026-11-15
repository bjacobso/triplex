/**
 * The record sheet: the only place the explorer writes. It edits one entity as a
 * form typed from the live release and commits one attributed transaction, pinned
 * to that release and checked against its constraints.
 */
import { useEffect, useMemo, useState } from "react";
import { Minus, Plus, X } from "lucide-react";

import type { AttributeView, EntityRecord, WireValue } from "../shared/protocol.js";
import { call } from "./client.js";
import { formatInstant, localName, toInputDate, fromInputDate } from "./format.js";
import { useExplorer } from "./model.js";

const ACTOR_KEY = "triplex-explorer-actor";
const editable = (attribute: AttributeView) => !attribute.sensitive && attribute.kind !== "other";

const toText = (attribute: AttributeView, value: unknown): string =>
  attribute.kind === "instant" && typeof value === "number"
    ? toInputDate(value)
    : value === undefined || value === null
      ? ""
      : String(value);

const toWire = (attribute: AttributeView, text: string): WireValue | null => {
  if (text.trim() === "") return null;
  switch (attribute.kind) {
    case "number":
    case "integer":
      return { type: "number", value: Number(text) };
    case "boolean":
      return { type: "boolean", value: text === "true" };
    case "instant": {
      const at = fromInputDate(text);
      return at === undefined ? null : { type: "datetime", value: at };
    }
    case "ref":
      return { type: "ref", value: text.trim() };
    default:
      return { type: "string", value: text };
  }
};

function Field({
  attribute,
  values,
  onChange,
  labels,
}: {
  readonly attribute: AttributeView;
  readonly values: readonly string[];
  readonly onChange: (values: string[]) => void;
  readonly labels: Readonly<Record<string, string>>;
}) {
  const shown = values.length === 0 ? [""] : values;
  const input = (text: string, index: number) => {
    const set = (next: string) => onChange(shown.map((value, i) => (i === index ? next : value)));
    const id = `field-${attribute.key}-${index}`;
    if (!editable(attribute))
      return <input disabled id={id} value={attribute.sensitive ? "sealed" : text} />;
    if (attribute.kind === "enum")
      return (
        <select id={id} onChange={(event) => set(event.target.value)} value={text}>
          <option value="">—</option>
          {attribute.enumValues.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      );
    if (attribute.kind === "boolean")
      return (
        <select id={id} onChange={(event) => set(event.target.value)} value={text}>
          <option value="">—</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      );
    return (
      <input
        id={id}
        onChange={(event) => set(event.target.value)}
        placeholder={
          attribute.kind === "ref"
            ? `${attribute.ref?.toLowerCase()}:…`
            : attribute.kind === "date"
              ? "YYYY-MM-DD"
              : ""
        }
        step={attribute.kind === "integer" ? 1 : "any"}
        type={
          attribute.kind === "instant"
            ? "datetime-local"
            : attribute.kind === "number" || attribute.kind === "integer"
              ? "number"
              : "text"
        }
        value={text}
      />
    );
  };
  return (
    <div className="ex-field">
      <label htmlFor={`field-${attribute.key}-0`}>
        <code>{localName(attribute.key)}</code>
        <span className="ex-muted">
          {attribute.type}
          {attribute.required ? " · required" : ""}
          {attribute.unique ? " · unique" : ""}
        </span>
      </label>
      {shown.map((text, index) => (
        <div className="ex-field-row" key={index}>
          {input(text, index)}
          {attribute.kind === "ref" && labels[text] ? (
            <span className="ex-field-hint">{labels[text]}</span>
          ) : null}
          {attribute.cardinality === "many" && editable(attribute) ? (
            <button
              aria-label="Remove value"
              className="ex-icon"
              onClick={() => onChange(shown.filter((_, i) => i !== index))}
              type="button"
            >
              <Minus size={12} />
            </button>
          ) : null}
        </div>
      ))}
      {attribute.cardinality === "many" && editable(attribute) ? (
        <button className="ex-link" onClick={() => onChange([...shown, ""])} type="button">
          <Plus size={12} /> Add a value
        </button>
      ) : null}
    </div>
  );
}

export function RecordSheet() {
  const explorer = useExplorer();
  const sheet = explorer.sheet;
  const type = explorer.typeOf(sheet?.type);
  const [record, setRecord] = useState<EntityRecord | null>(null);
  const [entityId, setEntityId] = useState("");
  const [values, setValues] = useState<Record<string, string[]>>({});
  const [initial, setInitial] = useState<Record<string, string[]>>({});
  const [change, setChange] = useState<"replace" | "correct">("replace");
  const [from, setFrom] = useState(toInputDate(Date.now()));
  const [actor, setActor] = useState(() => localStorage.getItem(ACTOR_KEY) ?? "user:explorer");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setError(null);
    setRecord(null);
    setChange("replace");
    setFrom(toInputDate(Date.now()));
    if (!sheet || !type) return;
    if (sheet.mode === "create" || !sheet.entityId) {
      setEntityId(`${type.name.toLowerCase()}:`);
      setValues({});
      setInitial({});
      return;
    }
    setEntityId(sheet.entityId);
    // Edits always start from the current state, whatever basis the table shows.
    void call({ _tag: "Record", entityId: sheet.entityId, basis: {} }).then(
      (found) => {
        const start = Object.fromEntries(
          type.attributes.map((attribute) => [
            attribute.key,
            found.facts
              .filter((fact) => fact.attribute === attribute.key)
              .map((fact) =>
                toText(attribute, "value" in fact.value ? fact.value.value : undefined),
              ),
          ]),
        );
        setRecord(found);
        setValues(start);
        setInitial(start);
      },
      (cause) => setError(String((cause as Error).message ?? cause)),
    );
  }, [sheet, type]);

  const dirty = useMemo(
    () =>
      type?.attributes.filter(
        (attribute) =>
          editable(attribute) &&
          JSON.stringify((values[attribute.key] ?? []).filter((v) => v !== "")) !==
            JSON.stringify((initial[attribute.key] ?? []).filter((v) => v !== "")),
      ) ?? [],
    [type, values, initial],
  );

  if (!sheet || !type) return null;
  const close = () => explorer.setSheet(null);
  const missing = type.attributes.filter(
    (attribute) =>
      attribute.required &&
      editable(attribute) &&
      (values[attribute.key] ?? []).every((value) => value.trim() === ""),
  );
  const save = async () => {
    setSaving(true);
    setError(null);
    localStorage.setItem(ACTOR_KEY, actor);
    try {
      const saved = await call({
        _tag: "Save",
        entityId: entityId.trim(),
        entityType: type.name,
        mode: sheet.mode,
        change: sheet.mode === "create" ? "replace" : change,
        ...(change === "replace" || sheet.mode === "create"
          ? { effectiveFrom: fromInputDate(from) ?? Date.now() }
          : {}),
        actor,
        values: (sheet.mode === "create" ? type.attributes.filter(editable) : dirty)
          .map((attribute) => ({
            attribute: attribute.key,
            values: (values[attribute.key] ?? []).flatMap((text) => {
              const wire = toWire(attribute, text);
              return wire === null ? [] : [wire];
            }),
          }))
          .filter((entry) => sheet.mode === "edit" || entry.values.length > 0),
      });
      explorer.notify(`Committed ${entityId.trim()} at #${saved.position}`);
      close();
      explorer.select({ kind: "entity", entityId: entityId.trim() });
    } catch (cause) {
      setError(String((cause as Error).message ?? cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ex-sheet-backdrop" onMouseDown={close}>
      <aside
        aria-label={sheet.mode === "create" ? `New ${type.name}` : `Edit ${entityId}`}
        className="ex-sheet"
        onKeyDown={(event) => event.key === "Escape" && close()}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="ex-sheet-head">
          <div>
            <span className="ex-eyebrow">
              {sheet.mode === "create" ? `New ${type.name}` : `Edit ${type.name}`}
            </span>
            <h2>{sheet.mode === "create" ? "Create a record" : (record?.label ?? entityId)}</h2>
            {sheet.mode === "edit" ? <code className="ex-muted">{entityId}</code> : null}
          </div>
          <button aria-label="Close" className="ex-icon" onClick={close} type="button">
            <X size={15} />
          </button>
        </header>
        <form
          className="ex-sheet-body"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {sheet.mode === "create" ? (
            <div className="ex-field">
              <label htmlFor="field-id">
                <code>entity id</code>
                <span className="ex-muted">stable, such as {type.name.toLowerCase()}:0042</span>
              </label>
              <div className="ex-field-row">
                <input
                  autoFocus
                  id="field-id"
                  onChange={(event) => setEntityId(event.target.value)}
                  value={entityId}
                />
              </div>
            </div>
          ) : null}
          {sheet.mode === "edit" && !record && !error ? (
            <p className="ex-muted">Reading the current record…</p>
          ) : null}
          {sheet.mode === "create" || record
            ? type.attributes.map((attribute) => (
                <Field
                  attribute={attribute}
                  key={attribute.key}
                  labels={record?.labels ?? {}}
                  onChange={(next) => setValues((all) => ({ ...all, [attribute.key]: next }))}
                  values={values[attribute.key] ?? []}
                />
              ))
            : null}

          <fieldset className="ex-sheet-change">
            <legend>When is this true?</legend>
            {sheet.mode === "edit" ? (
              <>
                <label>
                  <input
                    checked={change === "replace"}
                    onChange={() => setChange("replace")}
                    type="radio"
                  />{" "}
                  It changed from{" "}
                  <input
                    aria-label="Effective from"
                    disabled={change !== "replace"}
                    onChange={(event) => setFrom(event.target.value)}
                    type="datetime-local"
                    value={from}
                  />{" "}
                  <span className="ex-muted">Earlier values stay true for the past.</span>
                </label>
                <label>
                  <input
                    checked={change === "correct"}
                    onChange={() => setChange("correct")}
                    type="radio"
                  />{" "}
                  Correct a mistake{" "}
                  <span className="ex-muted">
                    Rewrites each value over its whole interval; the old value stays in recorded
                    history.
                  </span>
                </label>
              </>
            ) : (
              <label>
                Valid from{" "}
                <input
                  aria-label="Valid from"
                  onChange={(event) => setFrom(event.target.value)}
                  type="datetime-local"
                  value={from}
                />
              </label>
            )}
            <label className="ex-sheet-actor">
              Recorded by{" "}
              <input
                aria-label="Actor"
                onChange={(event) => setActor(event.target.value)}
                value={actor}
              />
            </label>
          </fieldset>
          {error ? <p className="ex-error ex-sheet-error">{error}</p> : null}
          <footer className="ex-sheet-foot">
            <span className="ex-muted">
              {sheet.mode === "edit"
                ? dirty.length
                  ? `${dirty.length} changed: ${dirty.map((attribute) => localName(attribute.key)).join(", ")}`
                  : "No changes yet"
                : missing.length
                  ? `Required: ${missing.map((attribute) => localName(attribute.key)).join(", ")}`
                  : "Ready"}
              {explorer.description?.release
                ? ` · checked against ${explorer.description.release.label}`
                : ""}
            </span>
            <button className="ex-link ex-muted" onClick={close} type="button">
              Cancel
            </button>
            <button
              className="ex-button primary"
              disabled={
                saving ||
                (sheet.mode === "edit"
                  ? dirty.length === 0
                  : missing.length > 0 || entityId.trim().endsWith(":"))
              }
              type="submit"
            >
              {saving ? "Committing…" : "Commit"}
            </button>
          </footer>
          {record ? (
            <p className="ex-muted ex-sheet-note">
              Read at #{record.basis.recordedPosition}, valid {formatInstant(record.basis.validAt)}.
            </p>
          ) : null}
        </form>
      </aside>
    </div>
  );
}
