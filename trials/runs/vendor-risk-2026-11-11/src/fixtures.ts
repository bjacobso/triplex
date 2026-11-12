import { Effect } from 'effect';
import { Triples } from '@triplex-build/triplex';
import { at, exception, op, questionnaire } from './model.js';
export const chosen = at('2026-06-01');
export const seed = Effect.gen(function* () {
  const t = yield* Triples;
  const names = ['clean', 'new', 'expired', 'high-missing-dpa', 'high-complete', 'exception', 'exception-expired', 'no-customer-data', 'no-questionnaire', 'soc-expired'];
  const ops = names.flatMap(name => [op(name, 'name', name), op(name, 'customer-data', name !== 'no-customer-data'), op(name, 'personal-data', name.startsWith('high-'))]);
  for (const name of ['clean', 'high-missing-dpa', 'high-complete', 'exception', 'exception-expired', 'no-questionnaire', 'soc-expired']) {
    if (name !== 'no-questionnaire') ops.push(questionnaire(name, at('2026-01-01')));
    if (!name.startsWith('exception')) ops.push(op(name, 'soc2-type-ii', true, at('2026-01-01'), at(name === 'soc-expired' ? '2026-05-31' : '2027-01-01')));
  }
  ops.push(questionnaire('expired', at('2025-06-01')), op('expired', 'soc2-type-ii', true));
  ops.push(op('high-complete', 'dpa', true));
  // Deliberately imported legacy violations: raw backend, for detection tests.
  for (const name of ['clean', 'expired', 'high-missing-dpa']) ops.push(op(name, 'active', true));
  yield* t.transact(ops, { actor: 'user:security', commandId: 'fixture:vendors' });
  yield* t.transact([exception('exception', 'Compensating controls approved', at('2025-12-15')), exception('exception-expired', 'Prior approval', at('2025-11-01'))], { actor: 'user:ciso', commandId: 'fixture:exceptions' });
});
