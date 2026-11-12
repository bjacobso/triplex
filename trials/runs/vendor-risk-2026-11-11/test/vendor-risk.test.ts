import { describe, it, expect } from 'vitest';
import { Effect } from 'effect';
import { Change, CommitRejectedError, KvTriples, Triples, boolean } from '@triplex-build/triplex';
import { SqliteTriples } from '@triplex-build/triplex-sqlite';
import { answers, at, day, exception, guarded, id, months, op, questionnaire, scalar } from '../src/model.js';
import { chosen, seed } from '../src/fixtures.js';
const expected = {
  needsReview: ['exception-expired','expired','high-missing-dpa','new','no-questionnaire','soc-expired'].map(n => 'vendor:' + n).sort(),
  activeInvalid: ['vendor:expired', 'vendor:high-missing-dpa'], expiring: ['vendor:exception'], invalidExceptions: [],
};
const backends = { KV: KvTriples.layer, SQLite: SqliteTriples.layerMemory };
for (const [name, backend] of Object.entries(backends)) describe(name, () => {
  it('BRIEF Q1/Q2/Q3: review work, invalid active vendors, and exceptions within 30 days', async () => {
    const result = await Effect.runPromise(Effect.gen(function* () { yield* seed; return yield* answers({ validAt: chosen }); }).pipe(Effect.provide(backend)));
    expect(result).toEqual(expected);
  });
  it('BRIEF Q1/Q3/Q5: half-open expiry boundaries, calendar months, and no-write expiry', async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      yield* seed; const t = yield* Triples; const position = yield* t.currentPosition();
      const before = yield* answers({ validAt: at('2026-05-31') });
      const now = yield* answers({ validAt: chosen });
      const expiry = yield* answers({ validAt: at('2026-06-15') });
      return { before, now, expiry, unchanged: position === (yield* t.currentPosition()) };
    }).pipe(Effect.provide(backend)));
    expect(result.before.needsReview).not.toContain('vendor:expired');
    expect(result.now.needsReview).toContain('vendor:expired');
    expect(result.expiry.needsReview).toContain('vendor:exception');
    expect(result.expiry.expiring).toEqual([]); expect(result.unchanged).toBe(true);
    expect(months(at('2024-08-31'), 6)).toBe(at('2025-02-28'));
  });
  it('BRIEF Q3: 30-day horizon includes day 30, excludes day 31 and already expired', async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const t = yield* Triples;
      yield* t.transact(['edge30','edge31','expired'].flatMap(n => [op(n,'name',n), op(n,'customer-data',true)]), {actor:'user:security'});
      yield* t.transact([exception('edge30','reason',at('2025-12-01')), exception('edge31','reason',at('2025-12-02')), exception('expired','reason',at('2025-11-01'))], {actor:'user:ciso'});
      return yield* answers({validAt: at('2026-05-02')});
    }).pipe(Effect.provide(backend)));
    expect(result.expiring).toEqual(['vendor:edge30']);
  });
  it('BRIEF Q4: past state and asserting actor, then later recorded correction', async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const t = yield* Triples;
      const receipt = yield* t.transact([op('audit','name','audit'), op('audit','customer-data',true), questionnaire('audit',at('2026-01-01')), op('audit','soc2-type-ii',true)], {actor:'user:analyst', commandId:'audit:original'});
      const fact = receipt.triples.find(f => f.attribute === ':vendor/questionnaire')!;
      const correction = Change.correct(fact, boolean(false));
      const fixed = yield* t.transact(correction.ops, {actor:'user:reviewer', commandId:'audit:correction', preconditions:correction.preconditions});
      const old = yield* t.entity(id('audit'), {validAt:chosen,recordedPosition:receipt.position});
      const latest = yield* t.entity(id('audit'), {validAt:chosen,recordedPosition:fixed.position});
      const prior = yield* answers({validAt:chosen,recordedPosition:receipt.position});
      const current = yield* answers({validAt:chosen});
      const journal = yield* t.transactionsForEntity(id('audit'));
      return {old:scalar(old.find(f=>f.attribute===':vendor/questionnaire')), latest:scalar(latest.find(f=>f.attribute===':vendor/questionnaire')), prior,current, actors:journal.transactions.map(tx=>tx.actor), original:(yield* t.transaction(receipt.txId))?.actor, history:yield* t.history(id('audit'))};
    }).pipe(Effect.provide(backend)));
    expect(result.old).toBe(true); expect(result.latest).toBe(false);
    expect(result.prior.needsReview).toEqual([]); expect(result.current.needsReview).toEqual(['vendor:audit']);
    expect(result.original).toBe('user:analyst'); expect(result.actors).toEqual(['user:reviewer','user:analyst']);
    expect(result.history.filter(f=>f.attribute===':vendor/questionnaire')).toHaveLength(2);
  });
  it('BRIEF Q5: runtime guards reject unauthorized/missing-reason/overlong exceptions and roll back', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const t = yield* Triples;
      for (const [actor, reason, code] of [['user:buyer','Reason','ciso_only'],['user:ciso','  ','reason_required']] as const) {
        const error = yield* t.transact([exception('bad',reason,chosen)], {actor,commandId:code}).pipe(Effect.flip);
        expect(error).toBeInstanceOf(CommitRejectedError);
        if (error instanceof CommitRejectedError) expect(error.rejections.map(r=>r.code)).toContain(code);
        expect(yield* t.transactionByCommand(code)).toBeNull();
        expect(yield* t.entity(id('bad'),{validAt:chosen})).toEqual([]);
      }
      const error = yield* t.transact([op('bad','exception','reason',chosen,months(chosen,6)+day)],{actor:'user:ciso'}).pipe(Effect.flip);
      expect(error).toBeInstanceOf(CommitRejectedError);
      yield* t.transact([exception('approved','Documented controls',chosen)],{actor:'user:ciso'});
      const longReview = yield* t.transact([op('bad','questionnaire',true,chosen,months(chosen,12)+day)],{actor:'user:security'}).pipe(Effect.flip);
      expect(longReview).toBeInstanceOf(CommitRejectedError);
    }).pipe(Effect.provide(guarded(backend))));
  });
  it('BRIEF Q5: direct signature/activation rejected; complete same-command review accepted; DPA still required with exception', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const t = yield* Triples;
      for (const gated of ['active','signed']) {
        const error = yield* t.transact([op('direct','customer-data',true),op('direct',gated,true)],{actor:'user:procurement'}).pipe(Effect.flip);
        expect(error).toBeInstanceOf(CommitRejectedError);
      }
      const good = [op('good','customer-data',true),questionnaire('good',chosen),op('good','soc2-type-ii',true,chosen,months(chosen,12)),op('good','active',true,chosen)];
      yield* t.transact(good,{actor:'user:security'});
      const error = yield* t.transact([op('high','customer-data',true),op('high','personal-data',true),questionnaire('high',chosen),exception('high','Reason',chosen),op('high','signed',true,chosen)],{actor:'user:ciso'}).pipe(Effect.flip);
      expect(error).toBeInstanceOf(CommitRejectedError);
      if (error instanceof CommitRejectedError) expect(error.rejections.map(r=>r.code)).toContain('review_required_before_signature_or_activation');
      yield* t.transact([op('high-ok','customer-data',true,chosen),op('high-ok','personal-data',true,chosen),questionnaire('high-ok',chosen),exception('high-ok','Reason',chosen),op('high-ok','dpa',true,chosen),op('high-ok','signed',true,chosen)],{actor:'user:ciso'});
      yield* t.transact([op('no-data','customer-data',false),op('no-data','active',true)],{actor:'user:procurement'});
    }).pipe(Effect.provide(guarded(backend))));
  });
  it('BRIEF Q5: raw backend bypass permits direct activation and invalid exceptions; queries detect violations', async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const t = yield* Triples;
      yield* t.transact([op('bypass','name','bypass'),op('bypass','customer-data',true),op('bypass','active',true),questionnaire('bypass',chosen),exception('bypass','Forged approval',chosen)],{actor:'user:buyer'});
      yield* t.transact([op('blank','name','blank'),op('blank','customer-data',true),exception('blank','',chosen)],{actor:'user:ciso'});
      return yield* answers({validAt:chosen});
    }).pipe(Effect.provide(backend)));
    expect(result.invalidExceptions).toEqual(['vendor:blank','vendor:bypass']);
    expect(result.activeInvalid).toEqual(['vendor:bypass']);
  });
  it('BRIEF Q2/Q5: expiry without writes reopens active-review work; expired evidence cannot authorize new activation', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const t = yield* Triples;
      const start = at('2026-01-01');
      yield* t.transact([op('clock','name','clock',start),op('clock','customer-data',true,start),questionnaire('clock',start),op('clock','soc2-type-ii',true,start,months(start,12)),op('clock','active',true,start)],{actor:'user:security'});
      const position = yield* t.currentPosition();
      expect((yield* answers({validAt:at('2026-12-31')})).activeInvalid).toEqual([]);
      expect((yield* answers({validAt:at('2027-01-01')})).activeInvalid).toEqual(['vendor:clock']);
      expect(yield* t.currentPosition()).toBe(position);
      const error = yield* t.transact([op('late','customer-data',true,start),questionnaire('late',start),op('late','soc2-type-ii',true,start,months(start,12)),op('late','active',true,at('2027-01-01'))],{actor:'user:procurement'}).pipe(Effect.flip);
      expect(error).toBeInstanceOf(CommitRejectedError);
      if (error instanceof CommitRejectedError) expect(error.rejections.map(r=>r.code)).toContain('review_required_before_signature_or_activation');
    }).pipe(Effect.provide(guarded(backend))));
  });
});
it('BRIEF Q6: identical portable Q1–Q3 answers on KV and SQLite', async () => {
  const results = [];
  for (const backend of Object.values(backends)) results.push(await Effect.runPromise(Effect.gen(function* () {yield* seed; return yield* answers({validAt:chosen});}).pipe(Effect.provide(backend))));
  expect(results[0]).toEqual(expected); expect(results[1]).toEqual(results[0]);
});
