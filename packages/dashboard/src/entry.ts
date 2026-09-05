import { Runtime } from "foldkit";

import { remoteDashboardApiLayer } from "./api.js";
import { DashboardDemoLayer } from "./demo/layer.js";
import { Message, init, update, view } from "./main.js";
import { Model } from "./model.js";
import "./styles.css";

const search = new URLSearchParams(window.location.search);
const resources =
  search.get("source") === "remote" || search.has("api")
    ? remoteDashboardApiLayer(search.get("api") ?? "")
    : DashboardDemoLayer;

const application = Runtime.makeApplication({
  Model,
  container: document.getElementById("root"),
  init,
  update,
  view,
  resources,
  devTools: { Message },
});

Runtime.run(application);
