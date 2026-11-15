import type { AttributeView, Fact, Value } from "../shared/protocol.js";

const pad = (n: number) => String(n).padStart(2, "0");

/** A compact UTC date, plus the time when it is not midnight. */
export const formatInstant = (ms: number | null | undefined): string => {
  if (ms === null || ms === undefined) return "—";
  const d = new Date(ms);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0
    ? date
    : `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

export const formatDateTime = (ms: number): string => {
  const d = new Date(ms);
  return `${formatInstant(ms).slice(0, 10)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};

export const relative = (ms: number, now = Date.now()): string => {
  const seconds = Math.round((now - ms) / 1000);
  const abs = Math.abs(seconds);
  const unit =
    abs < 60
      ? ([seconds, "s"] as const)
      : abs < 3600
        ? ([Math.round(seconds / 60), "m"] as const)
        : abs < 86400
          ? ([Math.round(seconds / 3600), "h"] as const)
          : ([Math.round(seconds / 86400), "d"] as const);
  if (abs < 5) return "just now";
  return unit[0] >= 0 ? `${unit[0]}${unit[1]} ago` : `in ${-unit[0]}${unit[1]}`;
};

export const interval = (from: number, to: number | null): string =>
  `${formatInstant(from)} → ${to === null ? "open" : formatInstant(to)}`;

export const valueText = (
  value: Value | null | undefined,
  labels?: Readonly<Record<string, string>>,
): string => {
  if (value === null || value === undefined) return "";
  switch (value.type) {
    case "string":
      return value.value;
    case "number":
      return Number.isInteger(value.value)
        ? String(value.value)
        : value.value.toLocaleString(undefined, { maximumFractionDigits: 4 });
    case "boolean":
      return value.value ? "true" : "false";
    case "datetime":
      return formatInstant(value.value);
    case "ref":
      return labels?.[value.value] ?? value.value;
    case "json":
      return JSON.stringify(value.value);
    case "blob":
      return `blob ${value.mimeType ?? ""}`.trim();
    case "sealed":
      return `sealed ${value.valueType}`;
  }
};

/** The attribute's local name without its namespace, such as `name` for `:worker/name`. */
export const localName = (key: string) => key.slice(key.indexOf("/") + 1);
export const namespaceOf = (key: string) => key.slice(0, key.indexOf("/") + 1);

export const shortId = (id: string | null | undefined) =>
  id === null || id === undefined ? "—" : id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;

/** Facts recorded more than a day after the time they became valid were backdated. */
export const backdated = (fact: Fact) => fact.recordedAt - fact.validFrom > 86_400_000;

export const numeric = (attribute: AttributeView) =>
  attribute.kind === "number" || attribute.kind === "integer";

export const toInputDate = (ms: number) => new Date(ms).toISOString().slice(0, 16);
export const fromInputDate = (text: string) => (text === "" ? undefined : Date.parse(`${text}Z`));
