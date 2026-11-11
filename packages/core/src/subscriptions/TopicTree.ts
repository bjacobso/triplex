import type { QueryDependencies, TripleChange } from "./types.js";
import { checkInvalidation } from "./invalidation.js";
import { extractEntityType } from "./extract-dependencies.js";

const WILDCARD_TOPIC = "*";

interface RegisteredQuery {
  readonly connectionId: string;
  readonly dependencies: QueryDependencies;
}

/**
 * Topic-tree index for live-query subscriptions.
 *
 * The tree narrows candidate subscriptions by entity type and attribute before
 * running the full invalidation check for exact matching.
 */
export class TopicTree {
  private readonly tree = new Map<string, Map<string, Set<string>>>();
  private readonly connections = new Map<string, Set<string>>();
  private readonly queries = new Map<string, RegisteredQuery>();

  register(connectionId: string, queryId: string, dependencies: QueryDependencies): void {
    this.unregister(connectionId, queryId);

    const subscriptionId = this.subscriptionId(connectionId, queryId);
    this.queries.set(subscriptionId, { connectionId, dependencies });

    const connectionQueries = this.connections.get(connectionId) ?? new Set<string>();
    connectionQueries.add(queryId);
    this.connections.set(connectionId, connectionQueries);

    const topics = this.topicsFor(dependencies);
    for (const [entityType, attribute] of topics) {
      const byAttribute = this.tree.get(entityType) ?? new Map<string, Set<string>>();
      const queryIds = byAttribute.get(attribute) ?? new Set<string>();
      queryIds.add(subscriptionId);
      byAttribute.set(attribute, queryIds);
      this.tree.set(entityType, byAttribute);
    }
  }

  unregister(connectionId: string, queryId: string): void {
    const subscriptionId = this.subscriptionId(connectionId, queryId);
    const existing = this.queries.get(subscriptionId);
    if (!existing) return;

    this.queries.delete(subscriptionId);

    const connectionQueries = this.connections.get(connectionId);
    if (connectionQueries) {
      connectionQueries.delete(queryId);
      if (connectionQueries.size === 0) {
        this.connections.delete(connectionId);
      }
    }

    const topics = this.topicsFor(existing.dependencies);
    for (const [entityType, attribute] of topics) {
      const byAttribute = this.tree.get(entityType);
      const queryIds = byAttribute?.get(attribute);
      if (!byAttribute || !queryIds) continue;

      queryIds.delete(subscriptionId);
      if (queryIds.size === 0) {
        byAttribute.delete(attribute);
      }
      if (byAttribute.size === 0) {
        this.tree.delete(entityType);
      }
    }
  }

  removeConnection(connectionId: string): void {
    const queryIds = Array.from(this.connections.get(connectionId) ?? []);
    for (const queryId of queryIds) {
      this.unregister(connectionId, queryId);
    }
  }

  hasSubscriptions(connectionId: string): boolean {
    return (this.connections.get(connectionId)?.size ?? 0) > 0;
  }

  findAffected(changes: readonly TripleChange[]): Map<string, TripleChange[]> {
    const byConnection = new Map<string, TripleChange[]>();
    const seenByConnection = new Map<string, Set<string>>();

    for (const change of changes) {
      const candidateIds = this.findCandidateSubscriptions(change);
      for (const subscriptionId of candidateIds) {
        const query = this.queries.get(subscriptionId);
        if (!query) continue;

        if (!checkInvalidation(query.dependencies, [change]).affected) {
          continue;
        }

        const changeKey = this.changeKey(change);
        const seenChanges = seenByConnection.get(query.connectionId) ?? new Set<string>();
        if (seenChanges.has(changeKey)) continue;

        seenChanges.add(changeKey);
        seenByConnection.set(query.connectionId, seenChanges);

        const connectionChanges = byConnection.get(query.connectionId) ?? [];
        connectionChanges.push(change);
        byConnection.set(query.connectionId, connectionChanges);
      }
    }

    return byConnection;
  }

  private findCandidateSubscriptions(change: TripleChange): Set<string> {
    const candidates = new Set<string>();
    const entityType = extractEntityType(change.attribute) ?? WILDCARD_TOPIC;

    this.collectCandidates(candidates, entityType, change.attribute);
    this.collectCandidates(candidates, entityType, WILDCARD_TOPIC);
    this.collectCandidates(candidates, WILDCARD_TOPIC, WILDCARD_TOPIC);

    return candidates;
  }

  private collectCandidates(target: Set<string>, entityType: string, attribute: string): void {
    const byAttribute = this.tree.get(entityType);
    const queryIds = byAttribute?.get(attribute);
    if (!queryIds) return;

    for (const queryId of queryIds) {
      target.add(queryId);
    }
  }

  private topicsFor(dependencies: QueryDependencies): ReadonlyArray<readonly [string, string]> {
    const topics = new Map<string, Set<string>>();

    for (const attribute of dependencies.attributes) {
      const entityType = extractEntityType(attribute) ?? WILDCARD_TOPIC;
      const attributes = topics.get(entityType) ?? new Set<string>();
      attributes.add(attribute);
      topics.set(entityType, attributes);
    }

    if (dependencies.hasDynamicAttributes) {
      topics.set(WILDCARD_TOPIC, new Set([WILDCARD_TOPIC]));
    }

    if (topics.size === 0) {
      topics.set(WILDCARD_TOPIC, new Set([WILDCARD_TOPIC]));
    }

    return Array.from(topics.entries()).flatMap(([entityType, attributes]) =>
      Array.from(attributes, (attribute) => [entityType, attribute] as const),
    );
  }

  private subscriptionId(connectionId: string, queryId: string): string {
    return `${connectionId}:${queryId}`;
  }
  private changeKey(change: TripleChange): string {
    return `${change.operation}:${change.entityId}:${change.attribute}`;
  }
}
