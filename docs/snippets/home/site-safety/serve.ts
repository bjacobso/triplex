import { NodeRuntime } from "@effect/platform-node";
import { Layer } from "effect";
import { Server } from "./app.ts";

// Serves whichever release `live` points at in app.db, with docs at /api/rest/latest/docs.
Layer.launch(Server).pipe(NodeRuntime.runMain);
