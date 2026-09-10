import { DurableObject } from "cloudflare:workers";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { Triples } from "@triplex-build/triplex";
import { CloudflareTriples, type DOState } from "@triplex-build/triplex-cloudflare";
import {
  AuthorizationError,
  InstanceIdentity,
  TenantAuthorizer,
  TenantRecord,
  canonicalInstanceIdentity,
  decodeTenantDataRequest,
  executeTenantDataRequest,
  providerInstanceKey,
  transitionRecord,
  type Principal,
  type TenantDataRequest,
  type TenantRecord as TenantRecordType,
} from "@triplex-build/triplex-host";

interface HostEnv {
  readonly TENANT_DATABASES: DurableObjectNamespace<TenantDatabase>;
  readonly TENANT_REGISTRY: DurableObjectNamespace<TenantRegistryObject>;
  readonly ADMIN_TOKEN: string;
  readonly INTERNAL_CAPABILITY: string;
  readonly TENANT_TOKENS: string;
  readonly HOST_ENVIRONMENT: string;
  readonly RUNTIME_RELEASE: string;
}

const MAX_REQUEST_BYTES = 1_048_576;
const MAX_TRANSACTION_OPERATIONS = 1_000;
const MAX_QUERY_CLAUSES = 100;

const json = (value: unknown, status = 200): Response =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });

const publicError = (status: number): { readonly code: string; readonly message: string } => {
  switch (status) {
    case 400:
      return { code: "invalid_request", message: "The request could not be validated" };
    case 401:
      return { code: "unauthorized", message: "Authentication is required" };
    case 403:
      return { code: "forbidden", message: "The request is not allowed" };
    case 404:
      return { code: "not_found", message: "The requested resource was not found" };
    case 409:
      return { code: "conflict", message: "The request conflicts with current host state" };
    default:
      return { code: "internal_error", message: "The request could not be completed" };
  }
};

const errorResponse = (_error: unknown, status = 400): Response => {
  return json(
    {
      ok: false,
      error: publicError(status),
    },
    status,
  );
};

const readJson = async (request: Request): Promise<unknown> => {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_REQUEST_BYTES) throw new Error("Request body exceeds the 1 MiB limit");
  const body = await request.text();
  if (new TextEncoder().encode(body).length > MAX_REQUEST_BYTES) {
    throw new Error("Request body exceeds the 1 MiB limit");
  }
  return JSON.parse(body) as unknown;
};

const bearer = (request: Request): string | null => {
  const value = request.headers.get("authorization");
  return value?.startsWith("Bearer ") ? value.slice(7) : null;
};

const equalSecret = async (left: string | null, right: string): Promise<boolean> => {
  if (left === null) return false;
  const digest = async (value: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  let mismatch = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return mismatch === 0;
};

const requireInternal = async (request: Request, env: HostEnv): Promise<void> => {
  if (!(await equalSecret(request.headers.get("x-triplex-internal"), env.INTERNAL_CAPABILITY))) {
    throw new AuthorizationError({ message: "Invalid internal caller capability" });
  }
};

const decodeRecord = (value: unknown): TenantRecordType =>
  Schema.decodeUnknownSync(TenantRecord)(value);

const registryStub = (env: HostEnv) => env.TENANT_REGISTRY.getByName("registry-v1");

const registryGet = async (
  env: HostEnv,
  identity: InstanceIdentity,
): Promise<TenantRecordType | null> => {
  const response = await registryStub(env).fetch("https://registry/get", {
    method: "POST",
    headers: { "content-type": "application/json", "x-triplex-internal": env.INTERNAL_CAPABILITY },
    body: JSON.stringify({ identity }),
  });
  if (!response.ok) throw new Error(`Registry lookup failed (${response.status})`);
  const body = (await response.json()) as { record: unknown | null };
  return body.record === null ? null : decodeRecord(body.record);
};

const registryCompareAndSet = async (
  env: HostEnv,
  record: TenantRecordType,
  expectedRevision: number | null,
): Promise<TenantRecordType> => {
  const response = await registryStub(env).fetch("https://registry/cas", {
    method: "POST",
    headers: { "content-type": "application/json", "x-triplex-internal": env.INTERNAL_CAPABILITY },
    body: JSON.stringify({ record, expectedRevision }),
  });
  if (response.status === 409) throw new Error("Registry revision conflict");
  if (!response.ok) throw new Error(`Registry write failed (${response.status})`);
  return decodeRecord(((await response.json()) as { record: unknown }).record);
};

const tenantStub = (env: HostEnv, record: TenantRecordType) =>
  env.TENANT_DATABASES.getByName(record.placement.instanceKey);

const callTenantControl = async (
  env: HostEnv,
  record: TenantRecordType,
  action: "activate" | "fence" | "retire",
): Promise<void> => {
  const response = await tenantStub(env, record).fetch(`https://instance/internal/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-triplex-internal": env.INTERNAL_CAPABILITY },
    body: JSON.stringify({
      identity: record.identity,
      routingRevision: record.routingRevision,
      state: record.state,
    }),
  });
  if (!response.ok) throw new Error(`Instance ${action} failed (${response.status})`);
};

const authenticateTenant = async (request: Request, env: HostEnv): Promise<Principal | null> => {
  const token = bearer(request);
  const configured = JSON.parse(env.TENANT_TOKENS) as Record<string, string>;
  for (const [tenantId, expected] of Object.entries(configured)) {
    if (await equalSecret(token, expected)) return { subject: tenantId };
  }
  return null;
};

const enforceBudgets = (request: TenantDataRequest): void => {
  if (
    request.operation._tag === "Transact" &&
    request.operation.request.operations.length > MAX_TRANSACTION_OPERATIONS
  ) {
    throw new Error(`Transactions are limited to ${MAX_TRANSACTION_OPERATIONS} operations`);
  }
  const query =
    request.operation._tag === "Query"
      ? request.operation.query
      : request.operation._tag === "QueryPage"
        ? request.operation.query.inner
        : undefined;
  if (query !== undefined && query.where.length > MAX_QUERY_CLAUSES) {
    throw new Error(`Queries are limited to ${MAX_QUERY_CLAUSES} clauses`);
  }
};

const provision = async (request: Request, env: HostEnv): Promise<Response> => {
  const input = (await readJson(request)) as {
    tenantId?: unknown;
    databaseId?: unknown;
    generation?: unknown;
    operationId?: unknown;
  };
  const identity = Schema.decodeUnknownSync(InstanceIdentity)({
    environment: env.HOST_ENVIRONMENT,
    tenantId: input.tenantId,
    databaseId: input.databaseId ?? "default",
    generation: input.generation,
  });
  if (identity.databaseId !== "default") {
    throw new Error("The v1 host supports only the default database per tenant");
  }
  if (typeof input.operationId !== "string" || input.operationId.length === 0) {
    throw new Error("operationId is required");
  }
  const now = Date.now();
  const desired: TenantRecordType = {
    identity,
    placement: {
      provider: "cloudflare",
      location: "durable-object",
      instanceKey: providerInstanceKey(identity),
    },
    state: "provisioning",
    revision: 1,
    routingRevision: 0,
    operationId: input.operationId,
    runtimeRelease: env.RUNTIME_RELEASE,
    storageSchemaVersion: 1,
    createdAt: now,
    updatedAt: now,
  };

  let current = await registryGet(env, identity);
  if (current === null) {
    try {
      current = await registryCompareAndSet(env, desired, null);
    } catch {
      current = await registryGet(env, identity);
    }
  }
  if (current === null) throw new Error("Provisioning record disappeared");
  if (current.state === "ready") return json({ ok: true, record: current });
  if (current.state !== "provisioning" || current.operationId !== input.operationId) {
    return errorResponse(new Error(`Instance is ${current.state} under another operation`), 409);
  }

  const ready = transitionRecord(current, "ready", input.operationId, Date.now());
  try {
    await callTenantControl(env, ready, "activate");
  } catch (error) {
    const failed: TenantRecordType = {
      ...current,
      revision: current.revision + 1,
      updatedAt: Date.now(),
      lastFailure: {
        operationId: input.operationId,
        message: error instanceof Error ? error.message : String(error),
        recordedAt: Date.now(),
        retryable: true,
      },
    };
    await registryCompareAndSet(env, failed, current.revision).catch(() => undefined);
    throw error;
  }
  try {
    current = await registryCompareAndSet(env, ready, current.revision);
  } catch {
    current = await registryGet(env, identity);
    if (current?.state !== "ready") throw new Error("Concurrent provisioning did not converge");
  }
  return json({ ok: true, record: current }, 201);
};

const changeLifecycle = async (
  request: Request,
  env: HostEnv,
  action: "suspend" | "resume" | "delete",
): Promise<Response> => {
  const body = (await readJson(request)) as { identity?: unknown; operationId?: unknown };
  const identity = Schema.decodeUnknownSync(InstanceIdentity)(body.identity);
  if (typeof body.operationId !== "string" || body.operationId.length === 0) {
    throw new Error("operationId is required");
  }
  const current = await registryGet(env, identity);
  if (current === null) return errorResponse(new Error("Instance not found"), 404);

  if (action === "suspend") {
    if (current.state === "suspended") return json({ ok: true, record: current });
    const suspended = transitionRecord(current, "suspended", body.operationId, Date.now());
    await callTenantControl(env, suspended, "fence");
    return json({
      ok: true,
      record: await registryCompareAndSet(env, suspended, current.revision),
    });
  }

  if (action === "resume") {
    if (current.state === "ready") return json({ ok: true, record: current });
    const ready = transitionRecord(current, "ready", body.operationId, Date.now());
    await callTenantControl(env, ready, "activate");
    return json({ ok: true, record: await registryCompareAndSet(env, ready, current.revision) });
  }

  if (current.state === "deleted") return json({ ok: true, record: current });
  const deleting = transitionRecord(current, "deleting", body.operationId, Date.now());
  await callTenantControl(env, deleting, "fence");
  const fenced = await registryCompareAndSet(env, deleting, current.revision);
  const deleted = transitionRecord(fenced, "deleted", body.operationId, Date.now());
  await callTenantControl(env, deleted, "retire");
  return json({ ok: true, record: await registryCompareAndSet(env, deleted, fenced.revision) });
};

const dataRequest = async (request: Request, env: HostEnv): Promise<Response> => {
  const principal = await authenticateTenant(request, env);
  if (principal === null)
    return errorResponse(new AuthorizationError({ message: "Unauthorized" }), 401);
  const decoded = await Effect.runPromise(decodeTenantDataRequest(await readJson(request)));
  enforceBudgets(decoded);
  if (principal.subject !== decoded.identity.tenantId) {
    return errorResponse(
      new AuthorizationError({ message: "Tenant token does not own target" }),
      403,
    );
  }
  const record = await registryGet(env, decoded.identity);
  if (record === null) return errorResponse(new Error("Instance not found"), 404);
  if (record.state !== "ready" || record.routingRevision !== decoded.routingRevision) {
    return errorResponse(new Error(`Instance is unavailable or route is stale`), 409);
  }
  const response = await tenantStub(env, record).fetch("https://instance/v1/data", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-triplex-internal": env.INTERNAL_CAPABILITY,
      "x-triplex-subject": principal.subject,
    },
    body: JSON.stringify(decoded),
  });
  return new Response(response.body, response);
};

export default {
  async fetch(request: Request, env: HostEnv): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, release: env.RUNTIME_RELEASE });
      }
      if (request.method === "POST" && url.pathname === "/v1/data") {
        return await dataRequest(request, env);
      }
      if (request.method === "POST" && url.pathname.startsWith("/v1/admin/")) {
        if (!(await equalSecret(bearer(request), env.ADMIN_TOKEN))) {
          return errorResponse(new AuthorizationError({ message: "Unauthorized" }), 401);
        }
        if (url.pathname === "/v1/admin/provision") return await provision(request, env);
        if (url.pathname === "/v1/admin/suspend")
          return await changeLifecycle(request, env, "suspend");
        if (url.pathname === "/v1/admin/resume")
          return await changeLifecycle(request, env, "resume");
        if (url.pathname === "/v1/admin/delete")
          return await changeLifecycle(request, env, "delete");
      }
      return errorResponse(new Error("Not found"), 404);
    } catch (error) {
      return errorResponse(error);
    }
  },
};

export class TenantRegistryObject extends DurableObject<HostEnv> {
  constructor(ctx: DurableObjectState, env: HostEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS tenant_registry (
      instance_id TEXT PRIMARY KEY NOT NULL,
      revision INTEGER NOT NULL,
      record_json TEXT NOT NULL
    )`);
  }

  override async fetch(request: Request): Promise<Response> {
    try {
      await requireInternal(request, this.env);
      const url = new URL(request.url);
      const body = (await readJson(request)) as {
        identity?: unknown;
        record?: unknown;
        expectedRevision?: unknown;
      };
      if (url.pathname === "/get") {
        const identity = Schema.decodeUnknownSync(InstanceIdentity)(body.identity);
        const row = this.ctx.storage.sql
          .exec<{ record_json: string }>(
            "SELECT record_json FROM tenant_registry WHERE instance_id = ?",
            canonicalInstanceIdentity(identity),
          )
          .toArray()[0];
        return json({ record: row === undefined ? null : JSON.parse(row.record_json) });
      }
      if (url.pathname === "/cas") {
        const record = decodeRecord(body.record);
        const expectedRevision = body.expectedRevision;
        if (expectedRevision !== null && typeof expectedRevision !== "number") {
          throw new Error("expectedRevision must be a number or null");
        }
        const updated = this.ctx.storage.transactionSync(() => {
          const key = canonicalInstanceIdentity(record.identity);
          const row = this.ctx.storage.sql
            .exec<{ revision: number }>(
              "SELECT revision FROM tenant_registry WHERE instance_id = ?",
              key,
            )
            .toArray()[0];
          const matches =
            expectedRevision === null ? row === undefined : row?.revision === expectedRevision;
          if (!matches) return false;
          this.ctx.storage.sql.exec(
            `INSERT INTO tenant_registry (instance_id, revision, record_json) VALUES (?, ?, ?)
             ON CONFLICT(instance_id) DO UPDATE SET revision = excluded.revision, record_json = excluded.record_json`,
            key,
            record.revision,
            JSON.stringify(record),
          );
          return true;
        });
        return updated ? json({ record }) : errorResponse(new Error("Revision conflict"), 409);
      }
      return errorResponse(new Error("Not found"), 404);
    } catch (error) {
      return errorResponse(error);
    }
  }
}

type InstanceRuntime = ManagedRuntime.ManagedRuntime<Triples | TenantAuthorizer, unknown>;

export class TenantDatabase extends DurableObject<HostEnv> {
  private runtime: InstanceRuntime | undefined;
  private inFlight = 0;
  private readonly drainWaiters = new Set<() => void>();

  constructor(ctx: DurableObjectState, env: HostEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS triplex_host_binding (
      singleton INTEGER PRIMARY KEY NOT NULL,
      identity_json TEXT NOT NULL,
      routing_revision INTEGER NOT NULL,
      lifecycle_state TEXT NOT NULL
    )`);
  }

  private binding(): {
    identity: InstanceIdentity;
    routingRevision: number;
    state: TenantRecordType["state"];
  } | null {
    const row = this.ctx.storage.sql
      .exec<{ identity_json: string; routing_revision: number; lifecycle_state: string }>(
        "SELECT identity_json, routing_revision, lifecycle_state FROM triplex_host_binding WHERE singleton = 1",
      )
      .toArray()[0];
    if (row === undefined) return null;
    return {
      identity: Schema.decodeUnknownSync(InstanceIdentity)(JSON.parse(row.identity_json)),
      routingRevision: Number(row.routing_revision),
      state: row.lifecycle_state as TenantRecordType["state"],
    };
  }

  private bind(next: ReturnType<TenantDatabase["binding"]> & {}): void {
    const current = this.binding();
    if (
      current !== null &&
      canonicalInstanceIdentity(current.identity) !== canonicalInstanceIdentity(next.identity)
    ) {
      throw new Error("Durable Object is already bound to another instance identity");
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO triplex_host_binding (singleton, identity_json, routing_revision, lifecycle_state)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         routing_revision = excluded.routing_revision,
         lifecycle_state = excluded.lifecycle_state`,
      JSON.stringify(next.identity),
      next.routingRevision,
      next.state,
    );
  }

  private getRuntime(identity: InstanceIdentity): InstanceRuntime {
    if (this.runtime !== undefined) return this.runtime;
    const authorizer = Layer.succeed(
      TenantAuthorizer,
      TenantAuthorizer.of({
        authorize: ({ principal, identity: target }) =>
          principal.subject === target.tenantId
            ? Effect.void
            : Effect.fail(new AuthorizationError({ message: "Tenant mismatch at instance" })),
      }),
    );
    this.runtime = ManagedRuntime.make(
      Layer.merge(
        CloudflareTriples.layer({
          state: this.ctx as unknown as DOState,
          scope: canonicalInstanceIdentity(identity),
        }),
        authorizer,
      ),
    );
    return this.runtime;
  }

  private waitForDrain(): Promise<void> {
    if (this.inFlight === 0) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.add(resolve));
  }

  private async closeRuntime(): Promise<void> {
    const runtime = this.runtime;
    this.runtime = undefined;
    await runtime?.dispose();
  }

  private finishRequest(): void {
    this.inFlight--;
    if (this.inFlight === 0) {
      for (const resolve of this.drainWaiters) resolve();
      this.drainWaiters.clear();
    }
  }

  override async fetch(request: Request): Promise<Response> {
    try {
      await requireInternal(request, this.env);
      const url = new URL(request.url);
      if (url.pathname.startsWith("/internal/")) {
        const body = (await readJson(request)) as {
          identity?: unknown;
          routingRevision?: unknown;
          state?: unknown;
        };
        const identity = Schema.decodeUnknownSync(InstanceIdentity)(body.identity);
        if (typeof body.routingRevision !== "number")
          throw new Error("routingRevision is required");
        const state = Schema.decodeUnknownSync(TenantRecord.fields.state)(body.state);
        this.bind({ identity, routingRevision: body.routingRevision, state });
        if (url.pathname === "/internal/activate") {
          await this.getRuntime(identity).runPromise(Effect.service(Triples));
        } else {
          await this.waitForDrain();
          await this.closeRuntime();
        }
        return json({ ok: true });
      }
      if (url.pathname === "/v1/data") {
        const bound = this.binding();
        if (bound === null || bound.state !== "ready") {
          return errorResponse(new Error("Instance is not ready"), 409);
        }
        this.inFlight++;
        try {
          const decoded = await Effect.runPromise(decodeTenantDataRequest(await readJson(request)));
          enforceBudgets(decoded);
          const principal: Principal = { subject: request.headers.get("x-triplex-subject") ?? "" };
          const value = await this.getRuntime(bound.identity).runPromise(
            executeTenantDataRequest(bound, principal, decoded),
          );
          return json({ ok: true, value });
        } finally {
          this.finishRequest();
        }
      }
      return errorResponse(new Error("Not found"), 404);
    } catch (error) {
      return errorResponse(error);
    }
  }
}
