import { useEffect, useState } from "react";

import { Grid, ValueLine } from "./grid.js";
import { Inspector } from "./inspector.js";
import { ExplorerRoot, useExplorer } from "./model.js";
import {
  BottomPanel,
  QuickOpen,
  StatusBar,
  TableTabs,
  TableToolbar,
  Toast,
  TopBar,
  TypesSidebar,
} from "./parts.js";
import { RecordSheet } from "./sheet.js";

const THEME_KEY = "triplex-explorer-theme";

export function App() {
  const [theme, setTheme] = useState<"light" | "dark">(
    () =>
      (localStorage.getItem(THEME_KEY) as "light" | "dark" | null) ??
      (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
  );
  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);
  return (
    <ExplorerRoot>
      <main className="ex-page">
        <TopBar onTheme={() => setTheme(theme === "dark" ? "light" : "dark")} theme={theme} />
        <Workspace />
        <QuickOpen />
        <RecordSheet />
        <Toast />
      </main>
    </ExplorerRoot>
  );
}

/** Types, the table with its panels, and the inspector beside it: the reader's workspace layout. */
export function Workspace() {
  const explorer = useExplorer();
  if (explorer.error)
    return (
      <div className="ex-fatal">
        <h2>The explorer cannot reach its database</h2>
        <p>{explorer.error}</p>
      </div>
    );
  return (
    <div className={`ex-workspace${explorer.sidebar ? " with-sidebar" : ""}`}>
      {explorer.sidebar ? <TypesSidebar /> : null}
      <section className="ex-table-pane">
        <TableTabs />
        <TableToolbar />
        <Grid />
        <ValueLine />
        <BottomPanel />
        <StatusBar />
      </section>
      <aside aria-label="Inspector" className="ex-inspector">
        <Inspector />
      </aside>
    </div>
  );
}
