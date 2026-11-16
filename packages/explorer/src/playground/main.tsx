import "@fontsource-variable/ibm-plex-sans";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "../app/explorer.css";
import "./playground.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { Playground } from "./Playground.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Playground />
  </StrictMode>,
);
