import { describe, expect, it } from 'vitest';
import { Effect, Exit } from 'effect';
import { KvTriples, Triples, string } from '@triplex-build/triplex';
import { SqliteTriples } from '@triplex-build/triplex-sqlite';
import * as D from '@triplex-build/triplex/derivation';
import { NOW, EDGE, GAP_END, FAR, DAY, certificates } from '../src/fixtures.js';
import { assertion, definitions, eid, eligibility, episodes, reconcileWork, replaceEvidence, seed } from '../src/model.js';

for (const [backend, layer] of [['KV', KvTriples.layer], ['SQLite', SqliteTriples.layerMemory]] as const) {
  const run = <A,E>(program: Effect.Effect<A,E,Triples>) => Effect.runPromise(program.pipe(Effect.provide(layer)));
  describe(backend, () => {
    it('Q1: exact chosen-instant eligibility and named missing requirements at both sites', () => run(Effect.gen(function* () {
      yield* seed;
      const rows = yield* eligibility({ validAt: NOW });
      expect(rows).toEqual([
        { tech: 'exact', site: 'plant', missing: ['electrical'] },
        { tech: 'seam', site: 'plant', missing: [] },
        { tech: 'gap', site: 'plant', missing: [] },
        { tech: 'late', site: 'plant', missing: [] },
        { tech: 'overlap', site: 'plant', missing: [] },
        { tech: 'missing', site: 'lab', missing: ['chemical'] },
        { tech: 'qualified', site: 'lab', missing: [] },
        { tech: 'horizon', site: 'plant', missing: [] },
        { tech: 'outside', site: 'plant', missing: [] },
        { tech: 'seam', site: 'lab', missing: ['chemical'] },
      ]);
    })));
    it('Q1,Q3: exclusive expiry, inclusive start, seamless future renewal and real gap at ±1ms', () => run(Effect.gen(function* () {
      yield* seed;
      for (const time of [NOW-1, NOW, NOW+1, EDGE-1, EDGE, EDGE+1, GAP_END-1, GAP_END, GAP_END+1]) {
        const rows = yield* eligibility({ validAt: time });
        const eligible = (tech: string) => rows.find(r => r.tech === tech && r.site === 'plant')!.missing.length === 0;
        expect(eligible('exact'), `exact at ${time}`).toBe(time < NOW);
        expect(eligible('seam'), `seam at ${time}`).toBe(true);
        expect(eligible('gap'), `gap at ${time}`).toBe(time < EDGE || time >= GAP_END);
        expect(eligible('late'), `late at ${time}`).toBe(time < EDGE || time >= GAP_END);
      }
    })));
    it('Q2: 30-day inclusive horizon, overlap union and stable deduplicated candidates', () => run(Effect.gen(function* () {
      const t = yield* Triples; yield* seed;
      const { renewal } = yield* definitions;
      const first = yield* D.evaluate(t, renewal, { basis: { validAt: NOW } });
      expect(first.candidates.map(c => c.identity['?tech']).sort()).toEqual(['tech:exact','tech:gap','tech:horizon','tech:late','tech:overlap']);
      const overlap = first.candidates.find(c => c.identity['?tech'] === 'tech:overlap')!;
      expect(overlap.sources.filter(s => s.attribute === ':certificate/evidence')).toHaveLength(2);
      const second = yield* D.evaluate(t, renewal, { basis: { validAt: NOW } });
      expect(D.reconcile(first.candidates, second.candidates).unchanged).toHaveLength(5);
      yield* reconcileWork(first.candidates, 'first');
      const pos = yield* t.currentPosition();
      yield* reconcileWork(second.candidates, 'repeat');
      expect(yield* t.currentPosition()).toBe(pos);
      expect(yield* t.match({ attribute: ':work/status', value: string('open') }, { validAt: 0 })).toHaveLength(5);
      // Overlap must extend coverage to Dec 5; the suppressed Nov 30 endpoint must not create work early.
      const early = yield* D.evaluate(t, renewal, { basis: { validAt: NOW - 10*DAY } });
      expect(early.candidates.some(c => c.identity['?tech'] === 'tech:overlap')).toBe(false);
    })));
    it('Q2,Q3: host 30-day threshold is a temporal edge, even with no source writes', () => run(Effect.gen(function* () {
      const t = yield* Triples; yield* seed;
      const { renewal } = yield* definitions;
      const first = yield* D.Materialization.materialize(t, renewal, { basis: { validAt: NOW } });
      // Outside expires one millisecond after the 30-day horizon.
      expect(first.nextTemporalBoundary).toBe(NOW+1);
      const position = yield* t.currentPosition();
      const stale = yield* D.Materialization.current(t, renewal, { basis: { validAt: NOW+1 } });
      expect(stale.status).toBe('stale');
      expect(yield* t.currentPosition()).toBe(position);
      const next = yield* D.Materialization.materialize(t, renewal, { basis: { validAt: NOW+1 } });
      expect(next.sourcePosition).toBe(first.sourcePosition);
      expect(next.candidates.some(c => c.identity['?tech'] === 'tech:outside')).toBe(true);
    })));
    it('Q3: time-only expiry detection, conservative wakeup and refresh retain real-gap work', () => run(Effect.gen(function* () {
      const t = yield* Triples; yield* seed;
      const { renewal, ineligible } = yield* definitions;
      const before = yield* D.Materialization.materialize(t, ineligible, { basis: { validAt: EDGE-1 } });
      expect(before.nextTemporalBoundary).toBe(EDGE);
      const head = yield* t.currentPosition();
      const afterRead = yield* D.Materialization.current(t, ineligible, { basis: { validAt: EDGE } });
      expect(afterRead.status).toBe('stale');
      expect(yield* t.currentPosition()).toBe(head);
      const after = yield* D.Materialization.materialize(t, ineligible, { basis: { validAt: EDGE } });
      expect(after.reconciliation.added.map(c => c.result['?tech']).sort()).toEqual(['tech:gap','tech:late']);
      const work = yield* D.Materialization.materialize(t, renewal, { basis: { validAt: EDGE } });
      expect(work.candidates.some(c => c.identity['?tech'] === 'tech:gap')).toBe(true);
      expect(work.candidates.some(c => c.identity['?tech'] === 'tech:seam')).toBe(false);
      const later = yield* D.Materialization.materialize(t, renewal, { basis: { validAt: GAP_END } });
      expect(later.reconciliation.removed.map(c => c.identity['?tech']).sort()).toEqual(['tech:gap','tech:late']);
    })));
    it('Q4,Q5: correction staleness, refreshed provenance and past-versus-present belief at one valid instant', () => run(Effect.gen(function* () {
      const t = yield* Triples;
      const initial = yield* seed;
      const { renewal, ineligible } = yield* definitions;
      const instant = EDGE+DAY;
      const old = yield* D.Materialization.materialize(t, ineligible, { basis: { validAt: instant } });
      yield* D.Materialization.materialize(t, renewal, { basis: { validAt: instant } });
      yield* t.transact([assertion('note:1', ':note/text', string('unrelated'))], { actor: 'clerk' });
      expect((yield* D.Materialization.current(t, ineligible, { basis: { validAt: instant } })).status).toBe('current');
      const correction = yield* replaceEvidence(certificates.map(c => c.id === 'late-next' ? { ...c, from: EDGE } : c), 'correct:late', 'auditor:lee');
      for (const def of [ineligible, renewal]) expect((yield* D.Materialization.current(t, def, { basis: { validAt: instant } })).status).toBe('stale');
      const prior = yield* eligibility({ validAt: instant, recordedPosition: initial.position });
      const current = yield* eligibility({ validAt: instant });
      expect(prior.find(r => r.tech === 'late')!.missing).toEqual(['electrical']);
      expect(current.find(r => r.tech === 'late')!.missing).toEqual([]);
      expect(current.find(r => r.tech === 'gap')!.missing).toEqual(['electrical']);
      const refreshed = yield* D.Materialization.materialize(t, ineligible, { basis: { validAt: instant } });
      expect(refreshed.reconciliation.removed.some(c => c.result['?tech'] === 'tech:late')).toBe(true);
      expect(refreshed.sourcePosition).toBe(correction.position);
      expect(refreshed.basis.validAt).toBe(instant);
      expect((yield* D.Materialization.current(t, ineligible, { basis: { validAt: instant } })).status).toBe('current');
      const renewalRun = yield* D.Materialization.materialize(t, renewal, { basis: { validAt: instant } });
      const gap = renewalRun.candidates.find(c => c.result['?tech'] === 'tech:gap')!;
      expect(gap.basis.validAt).toBe(instant);
      expect(gap.sources.some(s => s.attribute === ':certificate/evidence')).toBe(true);
      for (const s of gap.sources) {
        expect(s.transactionPosition).toBe(correction.position);
        expect(s.transactionId).toBe(correction.txId);
        expect(yield* t.get(s.tripleId)).not.toBeNull();
      }
      expect((yield* t.transaction(initial.txId))!.actor).toBe('registrar:initial');
      expect((yield* t.transaction(correction.txId))!.actor).toBe('auditor:lee');
      const audit = yield* t.transactionsForEntity(eid('cert:late-next'));
      expect(audit.transactions.map(tx => tx.actor)).toEqual(['auditor:lee','registrar:initial']);
      const history = yield* t.queryAll(D.Materialization.runsQuery(ineligible.name));
      expect(history.results.length).toBeGreaterThan(0);
      expect(old.candidates.some(c => c.result['?tech'] === 'tech:late')).toBe(true);
      expect(refreshed.candidates.some(c => c.result['?tech'] === 'tech:late')).toBe(false);
    })));
    it('Q6: renewal resolves obsolete work, preserves decisions, and expiry reopens without duplicates', () => run(Effect.gen(function* () {
      const t = yield* Triples; yield* seed;
      const { renewal } = yield* definitions;
      const first = yield* D.Materialization.materialize(t, renewal, { basis: { validAt: NOW } });
      yield* reconcileWork(first.candidates, 'initial');
      const target = first.candidates.find(c => c.result['?tech'] === 'tech:exact')!;
      yield* replaceEvidence([...certificates, { id: 'exact-renewal', tech: 'exact', cert: 'electrical', from: NOW, to: FAR }], 'renew:exact', 'registrar:renewals');
      const second = yield* D.Materialization.materialize(t, renewal, { basis: { validAt: NOW } });
      expect(second.reconciliation.removed.map(c => c.id)).toContain(target.id);
      yield* reconcileWork(second.candidates, 'renewed');
      yield* reconcileWork(second.candidates, 'renewed-retry');
      expect((yield* t.entity(eid(`work:${target.id}`), { validAt: 0 })).map(f => f.value)).toEqual([string('resolved')]);
      const decisions = yield* t.match({ attribute: ':decision/body' }, { validAt: 0 });
      const targetDecisions = decisions.filter(f => f.value.type === 'json' && (f.value.value as {work:string}).work === `work:${target.id}`);
      expect(targetDecisions).toHaveLength(2);
      expect((yield* t.history(eid(`work:${target.id}`)))).toHaveLength(2);
      const atNextDue = yield* D.Materialization.materialize(t, renewal, { basis: { validAt: FAR-30*DAY } });
      yield* reconcileWork(atNextDue.candidates, 'next-cycle');
      expect((yield* t.entity(eid(`work:${target.id}`), { validAt: 0 }))[0].value).toEqual(string('open'));
      const head = yield* t.currentPosition();
      yield* reconcileWork(atNextDue.candidates, 'next-cycle-retry');
      expect(yield* t.currentPosition()).toBe(head);
    })));
    it('Q6: Triplex atomic precondition rejects duplicate host creation and preserves journal', () => run(Effect.gen(function* () {
      const t = yield* Triples;
      const op = assertion('work:guard-demo', ':work/status', string('open'));
      const guard = [{ _tag: 'EntityAbsent' as const, entityId: eid('work:guard-demo') }];
      yield* t.transact([op], { actor: 'worker:a', preconditions: guard });
      const head = yield* t.currentPosition();
      const rejected = yield* Effect.exit(t.transact([op], { actor: 'worker:b', preconditions: guard }));
      expect(Exit.isFailure(rejected)).toBe(true);
      expect(yield* t.currentPosition()).toBe(head);
      expect(yield* t.entity(eid('work:guard-demo'), { validAt: 0 })).toHaveLength(1);
    })));
  });
}
// Brief interval assumptions and host validation are also fixed executable expectations.
it('Q1,Q2: host merges chained overlaps and touching intervals, rejects invalid intervals', () => {
  const base = { tech: 't', cert: 'c' };
  const input = [{ ...base, id:'a', from:0,to:10 },{ ...base,id:'b',from:9,to:20 },{ ...base,id:'c',from:20,to:30 },{ ...base,id:'d',from:31,to:40 }];
  expect(episodes(input).map(e => [e.from,e.to,e.next])).toEqual([[0,30,31],[31,40,undefined]]);
  expect(() => episodes([{ ...base,id:'bad',from:1,to:1 }])).toThrow('Invalid certificate interval');
});
