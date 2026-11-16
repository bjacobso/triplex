import type {
  Description,
  EntityRecord,
  Explanation,
  ExplorerRequest,
  JournalPage,
  LiveEvent,
  References,
  RowsPage,
  Saved,
  Transaction,
} from "../shared/protocol.js";

type Responses = {
  Describe: Description;
  Rows: RowsPage;
  Record: EntityRecord;
  Why: Explanation;
  References: References;
  Journal: JournalPage;
  Transaction: Transaction | null;
  Save: Saved;
};

/** Where requests go when not to the HTTP host, such as a database running in the page. */
export interface Transport {
  readonly call: (request: ExplorerRequest) => Promise<unknown>;
  readonly follow: typeof follow;
}

let transport: Transport | null = null;

/** Send every later request to `next` instead of the HTTP host; `null` restores the host. */
export const setTransport = (next: Transport | null) => {
  transport = next;
};

export const call = async <T extends ExplorerRequest["_tag"]>(
  request: Extract<ExplorerRequest, { _tag: T }>,
): Promise<Responses[T]> => {
  if (transport) return (await transport.call(request)) as Responses[T];
  const response = await fetch("/api/explorer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const body = (await response.json()) as { ok: boolean; value?: unknown; error?: string };
  if (!body.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body.value as Responses[T];
};

/**
 * Follows the journal from `after`, reconnecting after a dropped connection.
 * Returns a function that stops following.
 */
export const follow = (
  after: number,
  onEvent: (event: LiveEvent) => void,
  onConnection: (connected: boolean) => void,
): (() => void) => {
  if (transport) return transport.follow(after, onEvent, onConnection);
  const controller = new AbortController();
  let position = after;
  const run = async () => {
    while (!controller.signal.aborted) {
      try {
        const response = await fetch("/api/live", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ after: position }),
          signal: controller.signal,
        });
        if (!response.ok || response.body === null) throw new Error(`Live ${response.status}`);
        onConnection(true);
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += value;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line.trim() === "") continue;
            const event = JSON.parse(line) as LiveEvent;
            if (event.type === "tx") position = Math.max(position, event.transaction.position);
            if (event.type === "head") position = Math.max(position, event.position);
            onEvent(event);
          }
        }
      } catch {
        if (controller.signal.aborted) return;
      }
      onConnection(false);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  };
  void run();
  return () => controller.abort();
};
