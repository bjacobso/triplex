/**
 * The explorer's state and actions, shared by its parts through context, the way
 * Forma's reader shares one <ReaderRoot> with its editor, tabs, inspector and
 * panels. Compose the parts in ./parts freely inside an <ExplorerRoot>.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type {
  Basis,
  Description,
  EntityRecord,
  Filter,
  RowsPage,
  Sort,
  Transaction,
  TypeView,
} from "../shared/protocol.js";
import { call, follow } from "./client.js";

export const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = MAC ? "⌘" : "Ctrl";

const PAGE = 100;

export interface TableState {
  readonly sort: Sort | undefined;
  readonly filters: readonly Filter[];
  readonly hidden: readonly string[];
  readonly widths: Readonly<Record<string, number>>;
  readonly pages: readonly RowsPage[];
  readonly loading: boolean;
  readonly error: string | null;
  /** Cells whose facts changed in the latest live refresh, as `entity\u0000attribute`. */
  readonly flash: ReadonlySet<string>;
  readonly flashAt: number;
}

export type Selection =
  | { readonly kind: "cell"; readonly entityId: string; readonly attribute: string }
  | { readonly kind: "entity"; readonly entityId: string }
  | { readonly kind: "transaction"; readonly txId: string };

export interface Hover {
  readonly entityId: string;
  readonly attribute: string;
}

export type Panel = "references" | "journal";

interface Place {
  readonly type: string;
  readonly selection: Selection | null;
}

export interface Sheet {
  readonly mode: "create" | "edit";
  readonly type: string;
  readonly entityId: string | null;
}

export interface ExplorerModel {
  readonly description: Description | null;
  readonly error: string | null;
  readonly basis: Basis;
  readonly isLive: boolean;
  readonly setBasis: (basis: Basis) => void;
  readonly pin: (recordedPosition: number) => void;
  readonly goLive: () => void;
  readonly head: number;
  readonly connected: boolean;
  readonly nextBoundary: number | null;
  readonly feed: readonly Transaction[];

  readonly tabs: readonly string[];
  readonly active: string | null;
  readonly activeType: TypeView | null;
  readonly typeOf: (name: string | null | undefined) => TypeView | null;
  readonly openType: (name: string) => void;
  readonly closeType: (name: string) => void;
  readonly table: TableState | null;
  readonly setSort: (sort: Sort | undefined) => void;
  readonly addFilter: (filter: Filter) => void;
  readonly removeFilter: (index: number) => void;
  readonly toggleColumn: (attribute: string) => void;
  readonly resizeColumn: (attribute: string, width: number) => void;
  readonly loadMore: () => void;
  readonly refresh: () => void;

  readonly selection: Selection | null;
  readonly select: (selection: Selection | null) => void;
  readonly follow: (entityId: string) => void;
  readonly back: () => void;
  readonly canGoBack: boolean;
  readonly hover: Hover | null;
  readonly setHover: (hover: Hover | null) => void;
  readonly record: (entityId: string) => EntityRecord | undefined;
  readonly loadRecord: (entityId: string) => Promise<EntityRecord>;

  readonly panel: Panel | null;
  readonly setPanel: (panel: Panel | null) => void;
  readonly quickOpen: boolean;
  readonly setQuickOpen: (open: boolean) => void;
  readonly sidebar: boolean;
  readonly setSidebar: (open: boolean) => void;
  readonly timeMarks: boolean;
  readonly setTimeMarks: (on: boolean) => void;
  readonly sheet: Sheet | null;
  readonly setSheet: (sheet: Sheet | null) => void;
  readonly toast: string | null;
  readonly notify: (message: string) => void;
}

const ExplorerContext = createContext<ExplorerModel | null>(null);

export function useExplorer(): ExplorerModel {
  const model = useContext(ExplorerContext);
  if (!model) throw new Error("Explorer parts must be inside <ExplorerRoot>.");
  return model;
}

const emptyTable = (): TableState => ({
  sort: undefined,
  filters: [],
  hidden: [],
  widths: {},
  pages: [],
  loading: false,
  error: null,
  flash: new Set(),
  flashAt: 0,
});

const cellKeys = (pages: readonly RowsPage[]) => {
  const keys = new Map<string, string>();
  for (const page of pages)
    for (const row of page.rows) {
      const byAttribute = new Map<string, string[]>();
      for (const fact of row.facts)
        byAttribute.set(fact.attribute, [...(byAttribute.get(fact.attribute) ?? []), fact.id]);
      for (const [attribute, ids] of byAttribute)
        keys.set(`${row.id}\u0000${attribute}`, ids.sort().join(","));
    }
  return keys;
};

const recordKey = (entityId: string, basis: Basis) =>
  `${entityId}\u0000${basis.recordedPosition ?? "live"}\u0000${basis.validAt ?? "now"}`;

export function ExplorerRoot({ children }: { readonly children: ReactNode }) {
  const [description, setDescription] = useState<Description | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [basis, setBasisState] = useState<Basis>({});
  const basisRef = useRef(basis);
  basisRef.current = basis;
  const [head, setHead] = useState(0);
  const [connected, setConnected] = useState(false);
  const [nextBoundary, setNextBoundary] = useState<number | null>(null);
  const [feed, setFeed] = useState<readonly Transaction[]>([]);
  const [tabs, setTabs] = useState<readonly string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [tables, setTables] = useState<Readonly<Record<string, TableState>>>({});
  const tablesRef = useRef(tables);
  tablesRef.current = tables;
  const [selection, setSelection] = useState<Selection | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const [backStack, setBackStack] = useState<readonly Place[]>([]);
  const [hover, setHover] = useState<Hover | null>(null);
  const [records, setRecords] = useState<ReadonlyMap<string, EntityRecord>>(new Map());
  const [panel, setPanel] = useState<Panel | null>("journal");
  const [quickOpen, setQuickOpen] = useState(false);
  const [sidebar, setSidebar] = useState(
    typeof window === "undefined" ? true : window.innerWidth >= 1280,
  );
  const [timeMarks, setTimeMarks] = useState(true);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4200);
  }, []);

  const typeOf = useCallback(
    (name: string | null | undefined) =>
      description?.types.find((type) => type.name === name) ?? null,
    [description],
  );

  const patchTable = useCallback((type: string, patch: (table: TableState) => TableState) => {
    setTables((all) => ({ ...all, [type]: patch(all[type] ?? emptyTable()) }));
  }, []);

  /** Reload a table from its first row. `keep` reloads as many rows as are loaded, for live refreshes. */
  const reload = useCallback(
    async (type: string, options: { readonly keep?: boolean } = {}) => {
      const table = tablesRef.current[type] ?? emptyTable();
      const loaded = table.pages.reduce((sum, page) => sum + page.rows.length, 0);
      const limit = options.keep ? Math.min(200, Math.max(PAGE, loaded)) : PAGE;
      patchTable(type, (t) => ({ ...t, loading: true, error: null }));
      try {
        const page = await call({
          _tag: "Rows",
          entityType: type,
          basis: basisRef.current,
          ...(table.sort === undefined ? {} : { sort: table.sort }),
          filters: table.filters,
          limit,
        });
        patchTable(type, (t) => {
          if (!options.keep) return { ...t, pages: [page], loading: false, flash: new Set() };
          const before = cellKeys(t.pages);
          const after = cellKeys([page]);
          const flash = new Set<string>();
          for (const [key, ids] of after)
            if (before.has(key) && before.get(key) !== ids) flash.add(key);
          for (const row of page.rows)
            if (!t.pages.some((p) => p.rows.some((r) => r.id === row.id)))
              for (const fact of row.facts) flash.add(`${row.id}\u0000${fact.attribute}`);
          return { ...t, pages: [page], loading: false, flash, flashAt: Date.now() };
        });
      } catch (cause) {
        patchTable(type, (t) => ({
          ...t,
          loading: false,
          error: String((cause as Error).message ?? cause),
        }));
      }
    },
    [patchTable],
  );

  const loadMore = useCallback(async () => {
    const type = activeRef.current;
    if (type === null) return;
    const table = tablesRef.current[type];
    const last = table?.pages.at(-1);
    if (!table || !last?.nextCursor || table.loading) return;
    patchTable(type, (t) => ({ ...t, loading: true }));
    try {
      const page = await call({
        _tag: "Rows",
        entityType: type,
        // Continue from the first page's exact cut.
        basis: last.basis,
        ...(table.sort === undefined ? {} : { sort: table.sort }),
        filters: table.filters,
        cursor: last.nextCursor,
        limit: PAGE,
      });
      patchTable(type, (t) => ({ ...t, pages: [...t.pages, page], loading: false }));
    } catch (cause) {
      patchTable(type, (t) => ({
        ...t,
        loading: false,
        error: String((cause as Error).message ?? cause),
      }));
    }
  }, [patchTable]);

  const loadRecord = useCallback(async (entityId: string) => {
    const record = await call({ _tag: "Record", entityId, basis: basisRef.current });
    setRecords((all) => new Map(all).set(recordKey(entityId, basisRef.current), record));
    return record;
  }, []);

  const record = useCallback(
    (entityId: string) => records.get(recordKey(entityId, basis)),
    [records, basis],
  );

  const openType = useCallback(
    (name: string) => {
      setTabs((open) => (open.includes(name) ? open : [...open, name]));
      setActive(name);
      if (!tablesRef.current[name]) void reload(name);
    },
    [reload],
  );

  const closeType = useCallback((name: string) => {
    setTabs((open) => {
      const next = open.filter((tab) => tab !== name);
      if (activeRef.current === name) setActive(next.at(-1) ?? null);
      return next;
    });
  }, []);

  const select = useCallback(
    (next: Selection | null) => {
      setSelection(next);
      if (next && next.kind !== "transaction")
        void loadRecord(next.entityId).catch(() => undefined);
    },
    [loadRecord],
  );

  // Following a reference opens the target's table and remembers where you came from.
  const followRef = useCallback(
    (entityId: string) => {
      const from = activeRef.current;
      if (from !== null)
        setBackStack((stack) => [
          ...stack.slice(-30),
          { type: from, selection: selectionRef.current },
        ]);
      void loadRecord(entityId).then(
        (target) => {
          if (target.entityType) openType(target.entityType);
          setSelection({ kind: "entity", entityId });
        },
        (cause) => notify(String((cause as Error).message ?? cause)),
      );
    },
    [loadRecord, openType, notify],
  );

  const back = useCallback(() => {
    setBackStack((stack) => {
      const place = stack.at(-1);
      if (!place) return stack;
      openType(place.type);
      setSelection(place.selection);
      return stack.slice(0, -1);
    });
  }, [openType]);

  const setBasis = useCallback((next: Basis) => setBasisState(next), []);

  // A new basis rereads every open table and the selected record.
  const basisKey = `${basis.recordedPosition ?? "live"}:${basis.validAt ?? "now"}`;
  const firstBasis = useRef(true);
  useEffect(() => {
    if (firstBasis.current) {
      firstBasis.current = false;
      return;
    }
    for (const type of Object.keys(tablesRef.current)) void reload(type);
    const current = selectionRef.current;
    if (current && current.kind !== "transaction")
      void loadRecord(current.entityId).catch(() => undefined);
  }, [basisKey, reload, loadRecord]);

  const updateTable = useCallback(
    (patch: (table: TableState) => TableState) => {
      const type = activeRef.current;
      if (type === null) return;
      // Reload reads the ref, so update it now rather than after the next render.
      const next = patch(tablesRef.current[type] ?? emptyTable());
      tablesRef.current = { ...tablesRef.current, [type]: next };
      setTables(tablesRef.current);
      void reload(type);
    },
    [reload],
  );

  // Describe, then follow the journal.
  useEffect(() => {
    let stop = () => {};
    call({ _tag: "Describe" }).then(
      (described) => {
        setDescription(described);
        setHead(described.head);
        const params = new URLSearchParams(window.location.search);
        // Open the requested type, else the one most other types point at.
        const first =
          described.types.find((type) => type.name === params.get("type")) ??
          [...described.types].sort((a, b) => b.referencedBy.length - a.referencedBy.length)[0];
        if (first) openType(first.name);
        void call({ _tag: "Journal", limit: 40 }).then((page) => setFeed(page.transactions));
        stop = follow(described.head, onLiveEvent, setConnected);
      },
      (cause) => setError(String((cause as Error).message ?? cause)),
    );
    return () => stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshTimer = useRef<number | undefined>(undefined);
  const pendingTypes = useRef(new Set<string>());
  const scheduleRefresh = useCallback(
    (types: Iterable<string>, entities: ReadonlySet<string>) => {
      for (const type of types) pendingTypes.current.add(type);
      const current = selectionRef.current;
      if (current && current.kind !== "transaction" && entities.has(current.entityId))
        void loadRecord(current.entityId).catch(() => undefined);
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => {
        const due = [...pendingTypes.current];
        pendingTypes.current.clear();
        for (const type of due) if (tablesRef.current[type]) void reload(type, { keep: true });
      }, 250);
    },
    [reload, loadRecord],
  );

  const onLiveEventRef = useRef<(event: import("../shared/protocol.js").LiveEvent) => void>(
    () => {},
  );
  onLiveEventRef.current = (event) => {
    if (event.type === "head") {
      setHead((h) => Math.max(h, event.position));
      setNextBoundary(event.nextTemporalBoundary);
    } else if (event.type === "tx") {
      const tx = event.transaction;
      setHead((h) => Math.max(h, tx.position));
      setFeed((all) => [tx, ...all.filter((t) => t.txId !== tx.txId)].slice(0, 200));
      // A pinned view does not move; a live one rereads what the commit touched.
      if (basisRef.current.recordedPosition === undefined) {
        const types = new Set(tx.changes.flatMap((c) => (c.entityType ? [c.entityType] : [])));
        scheduleRefresh(types, new Set(tx.changes.map((c) => c.entityId)));
      }
    }
  };
  const onLiveEvent = useCallback(
    (event: import("../shared/protocol.js").LiveEvent) => onLiveEventRef.current(event),
    [],
  );

  // Facts start and expire on their own: wake at the next valid-time boundary.
  useEffect(() => {
    if (
      nextBoundary === null ||
      basis.recordedPosition !== undefined ||
      basis.validAt !== undefined
    )
      return;
    const wait = nextBoundary - Date.now();
    if (wait > 2_147_000_000) return;
    const timer = window.setTimeout(
      () => scheduleRefresh(Object.keys(tablesRef.current), new Set()),
      Math.max(0, wait) + 50,
    );
    return () => window.clearTimeout(timer);
  }, [nextBoundary, basisKey, scheduleRefresh, basis.recordedPosition, basis.validAt]);

  // Keyboard: quick open, sidebar, panel.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && (event.key === "k" || event.key === "p")) {
        event.preventDefault();
        setQuickOpen((open) => !open);
      } else if (mod && event.key === "b") {
        event.preventDefault();
        setSidebar((open) => !open);
      } else if (event.ctrlKey && event.key === "`") {
        event.preventDefault();
        setPanel((open) => (open ? null : "journal"));
      } else if (event.altKey && event.key === "ArrowLeft") {
        event.preventDefault();
        back();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [back]);

  const activeType = typeOf(active);
  const model: ExplorerModel = {
    description,
    error,
    basis,
    isLive: basis.recordedPosition === undefined,
    setBasis,
    pin: (recordedPosition) => setBasis({ ...basisRef.current, recordedPosition }),
    goLive: () => setBasis({}),
    head,
    connected,
    nextBoundary,
    feed,
    tabs,
    active,
    activeType,
    typeOf,
    openType,
    closeType,
    table: active === null ? null : (tables[active] ?? null),
    setSort: (sort) => updateTable((t) => ({ ...t, sort })),
    addFilter: (filter) =>
      updateTable((t) => ({
        ...t,
        filters: [...t.filters.filter((f) => f.attribute !== filter.attribute), filter],
      })),
    removeFilter: (index) =>
      updateTable((t) => ({ ...t, filters: t.filters.filter((_, i) => i !== index) })),
    toggleColumn: (attribute) =>
      active !== null &&
      patchTable(active, (t) => ({
        ...t,
        hidden: t.hidden.includes(attribute)
          ? t.hidden.filter((a) => a !== attribute)
          : [...t.hidden, attribute],
      })),
    resizeColumn: (attribute, width) =>
      active !== null &&
      patchTable(active, (t) => ({ ...t, widths: { ...t.widths, [attribute]: width } })),
    loadMore: () => void loadMore(),
    refresh: () => active !== null && void reload(active, { keep: true }),
    selection,
    select,
    follow: followRef,
    back,
    canGoBack: backStack.length > 0,
    hover,
    setHover,
    record,
    loadRecord,
    panel,
    setPanel,
    quickOpen,
    setQuickOpen,
    sidebar,
    setSidebar,
    timeMarks,
    setTimeMarks,
    sheet,
    setSheet,
    toast,
    notify,
  };
  return <ExplorerContext.Provider value={model}>{children}</ExplorerContext.Provider>;
}
