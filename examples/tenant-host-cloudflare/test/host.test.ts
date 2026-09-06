import { env, exports } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

interface Identity {
  readonly environment: string;
  readonly tenantId: string;
  readonly databaseId: string;
  readonly generation: string;
}

interface RecordResponse {
  readonly ok: true;
  readonly record: {
    readonly identity: Identity;
    readonly placement: { readonly instanceKey: string };
    readonly state: string;
    readonly revision: number;
    readonly routingRevision: number;
  };
}

interface DataResponse {
  readonly ok: boolean;
  readonly value?: unknown;
}

const identity = (tenantId: string, generation = "g1"): Identity => ({
  environment: "test",
  tenantId,
  databaseId: "default",
  generation,
});

const post = (path: string, token: string, body: unknown) =>
  exports.default.fetch(`https://host.test${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const provision = async (
  tenantId: string,
  generation = "g1",
  operationId = `create-${tenantId}`,
) => {
  const response = await post("/v1/admin/provision", "test-admin-token", {
    tenantId,
    databaseId: "default",
    generation,
    operationId,
  });
  expect(response.ok).toBe(true);
  return (await response.json()) as RecordResponse;
};

const data = (
  tenantId: string,
  token: string,
  routingRevision: number,
  operation: unknown,
  generation = "g1",
) =>
  post("/v1/data", token, {
    version: 1,
    identity: identity(tenantId, generation),
    routingRevision,
    operation,
  });

const transact = (entityId: string, value: string, commandId: string) => ({
  _tag: "Transact",
  request: {
    operations: [
      {
        op: "assert",
        entityId,
        attribute: ":host/secret",
        value: { type: "string", value },
      },
    ],
    meta: { commandId },
  },
});

const entity = (entityId: string) => ({ _tag: "Entity", entityId });

describe("two-tenant Cloudflare host in workerd", () => {
  it("isolates data, cursors, feeds, and the direct actor boundary", async () => {
    const tenantA = await provision("tenant-a");
    const tenantB = await provision("tenant-b");
    const revisionA = tenantA.record.routingRevision;
    const revisionB = tenantB.record.routingRevision;

    for (const response of [
      await data("tenant-a", "test-token-a", revisionA, transact("secret:a1", "A1", "a-1")),
      await data("tenant-a", "test-token-a", revisionA, transact("secret:a2", "A2", "a-2")),
      await data("tenant-b", "test-token-b", revisionB, transact("secret:b1", "B1", "b-1")),
    ]) {
      expect(response.ok).toBe(true);
      await response.text();
    }

    const aRead = await data("tenant-a", "test-token-a", revisionA, entity("secret:a1"));
    expect(aRead.ok).toBe(true);
    expect(JSON.stringify(await aRead.json<DataResponse>())).toContain("A1");

    const crossTenant = await data("tenant-b", "test-token-a", revisionB, entity("secret:b1"));
    expect(crossTenant.status).toBe(403);
    await crossTenant.text();

    const bCannotReadA = await data("tenant-b", "test-token-b", revisionB, entity("secret:a1"));
    expect(bCannotReadA.ok).toBe(true);
    expect((await bCannotReadA.json<DataResponse>()).value).toEqual([]);

    const firstPage = await data("tenant-a", "test-token-a", revisionA, {
      _tag: "QueryPage",
      query: {
        inner: { find: ["?entity", "?value"], where: [["?entity", ":host/secret", "?value"]] },
        orderBy: [{ variable: "?value" }],
        limit: 1,
      },
    });
    expect(firstPage.ok).toBe(true);
    const firstPageBody = (await firstPage.json()) as {
      readonly value: { readonly nextCursor?: string };
    };
    expect(firstPageBody.value.nextCursor).toBeTypeOf("string");

    const reusedCursor = await data("tenant-b", "test-token-b", revisionB, {
      _tag: "QueryPage",
      query: {
        inner: { find: ["?entity", "?value"], where: [["?entity", ":host/secret", "?value"]] },
        orderBy: [{ variable: "?value" }],
        limit: 1,
        cursor: firstPageBody.value.nextCursor,
      },
    });
    expect(reusedCursor.ok).toBe(false);
    await reusedCursor.text();

    const bFeed = await data("tenant-b", "test-token-b", revisionB, {
      _tag: "Transactions",
      after: 0,
    });
    const bFeedBody = (await bFeed.json()) as {
      readonly value: { readonly transactions: unknown[] };
    };
    expect(bFeedBody.value.transactions).toHaveLength(1);
    expect(JSON.stringify(bFeedBody)).not.toContain("a-1");

    const actor = env.TENANT_DATABASES.getByName(tenantA.record.placement.instanceKey);
    const bypass = await actor.fetch("https://instance/v1/data", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        identity: identity("tenant-a"),
        routingRevision: revisionA,
        operation: entity("secret:a1"),
      }),
    });
    expect(bypass.ok).toBe(false);
    await bypass.text();

    const targetFence = await actor.fetch("https://instance/v1/data", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-triplex-internal": "test-internal-capability",
        "x-triplex-subject": "tenant-b",
      },
      body: JSON.stringify({
        version: 1,
        identity: identity("tenant-b"),
        routingRevision: revisionB,
        operation: entity("secret:a1"),
      }),
    });
    expect(targetFence.ok).toBe(false);
    await targetFence.text();
  });

  it("converges retries and concurrent provisioning", async () => {
    const retryBody = {
      tenantId: "tenant-a",
      databaseId: "default",
      generation: "g1",
      operationId: "create-tenant-a",
    };
    const retry = await post("/v1/admin/provision", "test-admin-token", retryBody);
    expect(retry.ok).toBe(true);
    expect(retry.status).toBe(200);
    await retry.text();

    const responses = await Promise.all([
      post("/v1/admin/provision", "test-admin-token", {
        tenantId: "tenant-c",
        databaseId: "default",
        generation: "g1",
        operationId: "create-tenant-c",
      }),
      post("/v1/admin/provision", "test-admin-token", {
        tenantId: "tenant-c",
        databaseId: "default",
        generation: "g1",
        operationId: "create-tenant-c",
      }),
    ]);
    expect(responses.every((response) => response.ok)).toBe(true);
    const records = (await Promise.all(
      responses.map((response) => response.json()),
    )) as RecordResponse[];
    expect(records.every((response) => response.record.state === "ready")).toBe(true);
    expect(new Set(records.map((response) => response.record.placement.instanceKey)).size).toBe(1);
  });

  it("persists over eviction and fences suspension, deletion, and recreation", async () => {
    const originalA = await provision("tenant-a");
    const originalB = await provision("tenant-b");
    const actorA = env.TENANT_DATABASES.getByName(originalA.record.placement.instanceKey);
    await evictDurableObject(actorA);

    const afterEviction = await data(
      "tenant-a",
      "test-token-a",
      originalA.record.routingRevision,
      entity("secret:a1"),
    );
    expect(afterEviction.ok).toBe(true);
    expect(JSON.stringify(await afterEviction.json<DataResponse>())).toContain("A1");

    const suspendedResponse = await post("/v1/admin/suspend", "test-admin-token", {
      identity: identity("tenant-a"),
      operationId: "suspend-a",
    });
    expect(suspendedResponse.ok).toBe(true);
    const suspended = (await suspendedResponse.json()) as RecordResponse;
    expect(suspended.record.state).toBe("suspended");
    const suspendedRead = await data(
      "tenant-a",
      "test-token-a",
      suspended.record.routingRevision,
      entity("secret:a1"),
    );
    expect(suspendedRead.status).toBe(409);
    await suspendedRead.text();

    const resumedResponse = await post("/v1/admin/resume", "test-admin-token", {
      identity: identity("tenant-a"),
      operationId: "resume-a",
    });
    const resumed = (await resumedResponse.json()) as RecordResponse;
    expect(resumed.record.state).toBe("ready");
    const resumedRead = await data(
      "tenant-a",
      "test-token-a",
      resumed.record.routingRevision,
      entity("secret:a1"),
    );
    expect(resumedRead.ok).toBe(true);
    await resumedRead.text();

    const deletedResponse = await post("/v1/admin/delete", "test-admin-token", {
      identity: identity("tenant-b"),
      operationId: "delete-b",
    });
    const deleted = (await deletedResponse.json()) as RecordResponse;
    expect(deleted.record.state).toBe("deleted");
    const deletedRead = await data(
      "tenant-b",
      "test-token-b",
      deleted.record.routingRevision,
      entity("secret:b1"),
    );
    expect(deletedRead.status).toBe(409);
    await deletedRead.text();

    const recreated = await provision("tenant-b", "g2", "recreate-b");
    expect(recreated.record.placement.instanceKey).not.toBe(originalB.record.placement.instanceKey);
    const recreatedRead = await data(
      "tenant-b",
      "test-token-b",
      recreated.record.routingRevision,
      entity("secret:b1"),
      "g2",
    );
    expect((await recreatedRead.json<DataResponse>()).value).toEqual([]);
  });
});
