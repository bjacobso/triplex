import { Effect, Layer, Option } from 'effect';
import { CommitValidation, EntityId, Triples, boolean, string, type Triple, type TransactOp, type TemporalBasis } from '@triplex-build/triplex';

export const day = 86_400_000;
export const at = (s: string) => Date.parse(s + 'T00:00:00Z');
// UTC calendar months, clamped at month end (not 365/180-day approximations).
export function months(t: number, n: number) {
  const d = new Date(t); const date = d.getUTCDate(); d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(date, last)); return d.getTime();
}
export const id = (name: string) => EntityId.make('vendor:' + name);
export const op = (name: string, key: string, value: string | boolean, from = at('2025-01-01'), to?: number): TransactOp => ({
  op: 'assert', entityId: id(name), entityType: 'Vendor', attribute: ':vendor/' + key,
  value: typeof value === 'boolean' ? boolean(value) : string(value), validFrom: from, ...(to === undefined ? {} : { validTo: to }),
});
export const questionnaire = (name: string, from: number) => op(name, 'questionnaire', true, from, months(from, 12));
export const exception = (name: string, reason: string, from: number) => op(name, 'exception', reason, from, months(from, 6));
const key = (f: Triple) => String(f.attribute).replace(':vendor/', '');
export const scalar = (f: Triple | undefined) => f && 'value' in f.value ? f.value.value : undefined;
const end = (f: Triple) => Option.getOrUndefined(f.validTo);
export type Actors = Map<string, string>;
export function issues(facts: readonly Triple[], actors: Actors) {
  const has = (k: string, v: string | boolean = true) => facts.some(f => key(f) === k && scalar(f) === v);
  const problems: string[] = [];
  if (!has('customer-data')) return problems;
  if (!has('questionnaire')) problems.push('questionnaire_missing_or_expired');
  const approved = facts.some(f => key(f) === 'exception' && f.value.type === 'string' && f.value.value.trim().length > 0
    && actors.get(Option.getOrUndefined(f.txId) ?? '') === 'user:ciso'
    && end(f) !== undefined && end(f)! <= months(f.validFrom, 6));
  if (!has('soc2-type-ii') && !approved) problems.push('soc2_or_exception_missing_or_expired');
  if (has('personal-data') && !has('dpa')) problems.push('dpa_missing');
  return problems;
}
const actorQuery = { find: ['?tx', '?actor'], where: [['?tx', ':_tx/actor', '?actor']] } as const;
export const answers = (basis: TemporalBasis & { validAt: number }) => Effect.gen(function* () {
  const t = yield* Triples;
  // Separate provenance read: historical validAt would hide the later transaction envelope.
  const provenance = yield* t.queryAll(actorQuery, { basis: { recordedAt: basis.recordedAt, recordedPosition: basis.recordedPosition } });
  const actors: Actors = new Map(provenance.results.map(r => [String(r['?tx']), String(r['?actor'])]));
  const vendors = yield* t.queryAll({ find: ['?v'], where: [['?v', ':vendor/name', '?name']] }, { basis });
  const needsReview: string[] = [], activeInvalid: string[] = [], expiring: string[] = [], invalidExceptions: string[] = [];
  for (const row of vendors.results) {
    const entity = EntityId.make(String(row['?v']));
    const facts = yield* t.entity(entity, basis);
    if (issues(facts, actors).length) {
      needsReview.push(entity);
      if (facts.some(f => key(f) === 'active' && scalar(f) === true)) activeInvalid.push(entity);
    }
    for (const f of facts.filter(f => key(f) === 'exception')) {
      const valid = f.value.type === 'string' && f.value.value.trim().length > 0 && actors.get(Option.getOrUndefined(f.txId) ?? '') === 'user:ciso'
        && end(f) !== undefined && end(f)! <= months(f.validFrom, 6);
      if (!valid) invalidExceptions.push(entity);
      else if (end(f)! > basis.validAt && end(f)! <= basis.validAt + 30 * day) expiring.push(entity);
    }
  }
  return Object.fromEntries(Object.entries({ needsReview, activeInvalid, expiring, invalidExceptions }).map(([k,v]) => [k, [...new Set(v)].sort()])) as {
    needsReview: string[]; activeInvalid: string[]; expiring: string[]; invalidExceptions: string[];
  };
});

export const policy = CommitValidation.make('vendor-risk.v1', c => Effect.gen(function* () {
  const rejects: CommitValidation.Rejection[] = [];
  const reject = (entityId: EntityId, code: string) => rejects.push({ entityId, code, message: code });
  for (const change of c.changes) {
    if (change.op !== 'assert') continue;
    if (change.attribute === ':vendor/exception') {
      if (c.transaction.actor !== 'user:ciso') reject(change.entityId, 'ciso_only');
      if (change.value?.type !== 'string' || !change.value.value.trim()) reject(change.entityId, 'reason_required');
      if (change.validFrom === undefined || change.validTo === undefined || change.validTo > months(change.validFrom, 6)) reject(change.entityId, 'exception_max_six_months');
    }
    if (change.attribute === ':vendor/questionnaire' && (change.validFrom === undefined || change.validTo === undefined || change.validTo > months(change.validFrom, 12))) reject(change.entityId, 'review_max_twelve_months');
  }
  const provenance = yield* c.after.query(actorQuery, { validAt: c.transaction.instant });
  const actors: Actors = new Map(provenance.map(r => [String(r['?tx']), String(r['?actor'])]));
  // Check every affected entity at changed interval starts and now. Natural expiry after
  // the command is an observation/scheduling concern, not a transaction to reject.
  for (const entityId of new Set(c.changes.map(ch => ch.entityId))) {
    if (!String(entityId).startsWith('vendor:')) continue;
    const times = new Set([c.transaction.instant, ...c.changes.filter(ch => ch.entityId === entityId).map(ch => ch.validFrom ?? c.transaction.instant)]);
    for (const validAt of times) {
      const facts = yield* c.after.entity(entityId, { validAt });
      const gated = facts.some(f => (key(f) === 'active' || key(f) === 'signed') && scalar(f) === true);
      if (gated && issues(facts, actors).length) reject(entityId, 'review_required_before_signature_or_activation');
    }
  }
  return rejects;
}));
export const guarded = <E>(backend: Layer.Layer<Triples, E>) => CommitValidation.layer({ validators: [policy] }).pipe(Layer.provide(backend));
