import { Effect, Option } from 'effect';
import { EntityId, Triples, json, ref, string, type TransactOp, type TemporalBasis, type TripleValue } from '@triplex-build/triplex';
import * as D from '@triplex-build/triplex/derivation';
import { assignments, requirements, certificates, DAY, type Certificate } from './fixtures.js';
export const eid = EntityId.make;
const techId = (t: string) => eid(`tech:${t}`);
export const assertion = (entity: string, attribute: string, value: TripleValue, validFrom = 0, validTo?: number): TransactOp => ({
  op: 'assert', entityId: eid(entity), attribute, value, validFrom, ...(validTo === undefined ? {} : { validTo }),
});

// Host domain rule: connected union of [from,to) intervals. Touching edges are seamless.
export function episodes(input: readonly Certificate[]) {
  const groups = new Map<string, Certificate[]>();
  for (const c of input) {
    if (!Number.isFinite(c.from) || !Number.isFinite(c.to) || c.from >= c.to) throw new Error('Invalid certificate interval');
    const key = `${c.tech}/${c.cert}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const result: { tech: string; cert: string; from: number; to: number; evidence: string[]; next?: number }[] = [];
  for (const group of groups.values()) {
    const merged: typeof result = [];
    for (const c of [...group].sort((a,b) => a.from - b.from || a.to - b.to)) {
      const last = merged.at(-1);
      if (last && c.from <= last.to) { last.to = Math.max(last.to, c.to); last.evidence.push(c.id); }
      else merged.push({ tech: c.tech, cert: c.cert, from: c.from, to: c.to, evidence: [c.id] });
    }
    merged.forEach((e,i) => { e.next = merged[i+1]?.from; });
    result.push(...merged);
  }
  return result;
}
function projectionOps(input: readonly Certificate[]): TransactOp[] {
  return episodes(input).flatMap((e,i) => {
    const window = `window:${e.tech}:${e.cert}:${i}`;
    return [
      assertion(`tech:${e.tech}`, ':coverage/current', string(e.cert), e.from, e.to),
      assertion(window, ':window/tech', ref(techId(e.tech))),
      // Past expiry remains overdue until the next coverage episode begins.
      assertion(window, ':window/due', string(e.cert), Math.max(e.from, e.to - 30 * DAY), e.next),
      ...e.evidence.map(id => assertion(window, ':window/evidence', ref(eid(`cert:${id}`)))),
    ];
  });
}
export const seed = Effect.gen(function* () {
  const t = yield* Triples;
  return yield* t.transact([
    ...requirements.map(([s,c]) => assertion(`site:${s}`, ':site/requires', string(c))),
    ...assignments.flatMap(([tech,site],i) => [assertion(`assignment:${i}`, ':assignment/tech', ref(techId(tech))), assertion(`assignment:${i}`, ':assignment/site', ref(eid(`site:${site}`)))]),
    ...certificates.map(c => assertion(`cert:${c.id}`, ':certificate/evidence', json(c))),
    ...projectionOps(certificates),
  ], { actor: 'registrar:initial', commandId: 'seed', configSnapshot: 'cert-policy/v1' });
});
export const definitions = Effect.gen(function* () {
  const renewal = yield* D.make({ name: 'cert-renewal', configSnapshot: 'cert-policy/v1', identity: ['?tech','?cert'], query: {
    find: ['?tech','?cert'], where: [
      ['?w', ':window/tech', '?tech'], ['?w', ':window/due', '?cert'],
      ['?w', ':window/evidence', '?e'], ['?e', ':certificate/evidence', '?body'],
    ],
  }});
  const ineligible = yield* D.make({ name: 'ineligible-assignment', configSnapshot: 'cert-policy/v1', identity: ['?a','?cert'], query: {
    find: ['?a','?tech','?site','?cert'], where: [
      ['?a', ':assignment/tech', '?tech'], ['?a', ':assignment/site', '?site'],
      ['?site', ':site/requires', '?cert'], ['not', ['?tech', ':coverage/current', '?cert']],
    ],
  }});
  return { renewal, ineligible };
});
export const eligibility = (basis: TemporalBasis) => Effect.gen(function* () {
  const t = yield* Triples;
  const { ineligible } = yield* definitions;
  const missing = yield* D.evaluate(t, ineligible, { basis: { ...basis, validAt: basis.validAt! } });
  return assignments.map(([tech,site],i) => ({ tech, site, missing: missing.candidates
    .filter(c => c.result['?a'] === `assignment:${i}`).map(c => c.result['?cert']).sort() }));
});
// Corrections are atomic with host-normalized projections. Full rebuild is deliberately small-fixture scope.
export const replaceEvidence = (next: readonly Certificate[], commandId: string, actor: string) => Effect.gen(function* () {
  const t = yield* Triples;
  const history = yield* t.transactions({ limit: 1000 });
  // Enumerate all live assertions across valid times, including future windows.
  const ids = new Set(history.transactions.flatMap(tx => tx.changes.filter(c => c.attribute.startsWith(':window/') || c.attribute === ':coverage/current' || c.attribute === ':certificate/evidence').map(c => c.entityId)));
  const ops: TransactOp[] = [];
  for (const id of ids) {
    for (const fact of yield* t.history(id)) {
      if (Option.isNone(fact.retractedAt) && (fact.attribute.startsWith(':window/') || fact.attribute === ':coverage/current' || fact.attribute === ':certificate/evidence')) ops.push({ op: 'retract', id: fact.id });
    }
  }
  return yield* t.transact([...ops, ...next.map(c => assertion(`cert:${c.id}`, ':certificate/evidence', json(c))), ...projectionOps(next)], {
    actor, commandId, causationId: 'seed', configSnapshot: 'cert-policy/v1',
    preconditions: ops.flatMap(op => op.op === 'retract' ? [{ _tag: 'TripleLive' as const, id: op.id }] : []),
  });
});

// Application lifecycle, durably stored separately from immutable derived candidates.
// One stable work entity per pair, append-only decision events, CAS-protected status updates.
export const reconcileWork = (candidates: readonly D.Candidate[], evaluationId: string) => Effect.gen(function* () {
  const t = yield* Triples;
  const desired = new Map(candidates.map(c => [String(c.id), c]));
  const existing = yield* t.match({ attribute: ':work/status' }, { validAt: 0 });
  const keys = new Set([...desired.keys(), ...existing.map(f => f.entityId.slice('work:'.length))]);
  for (const key of keys) {
    const id = `work:${key}`;
    const status = existing.find(f => f.entityId === id);
    const next = desired.has(key) ? 'open' : 'resolved';
    if (status?.value.type === 'string' && status.value.value === next) continue;
    if (!status && next === 'resolved') continue;
    yield* t.transact([
      ...(status ? [{ op: 'retract' as const, id: status.id }] : []),
      assertion(id, ':work/status', string(next)),
      assertion(`decision:${evaluationId}:${key}`, ':decision/body', json({ work: id, status: next, revision: desired.get(key)?.revision, evaluationId })),
    ], { actor: 'worker:reconciler', commandId: `work:${evaluationId}:${key}`, preconditions: status
      ? [{ _tag: 'TripleLive', id: status.id }]
      : [{ _tag: 'EntityAbsent', entityId: eid(id) }] });
  }
});
