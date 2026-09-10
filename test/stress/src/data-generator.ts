import type { TripleInput, TransactOp } from "@triplex-build/triplex";
import { EntityId, string, number, boolean, datetime, ref } from "@triplex-build/triplex";

/**
 * Generate employee triples for stress testing.
 *
 * Creates a simple but realistic dataset of employee records with:
 * - 10 attributes per employee (name, email, age, salary, department, title, active, hire_date, location, manager)
 * - Realistic distributions (more junior than senior, salary correlates with level)
 * - 20% of employees have manager references (creates graph structure)
 *
 * @param count Number of employees to generate
 * @returns Array of TripleInput objects (count * 10 triples, or count * 11 for employees with managers)
 */
export function generateEmployeeTriples(count: number): TripleInput[] {
  const triples: TripleInput[] = [];

  const departments = [
    "Engineering",
    "Sales",
    "Marketing",
    "HR",
    "Finance",
    "Operations",
    "Legal",
    "Support",
  ];

  const titles = ["Junior", "Mid-Level", "Senior", "Staff", "Lead", "Principal"];

  const locations = ["NYC", "SF", "Austin", "Remote", "London"];

  for (let i = 0; i < count; i++) {
    const empId = EntityId.make(`emp:${i}`);

    // Distribute across departments evenly
    const deptIdx = i % departments.length;

    // More juniors than seniors (realistic distribution)
    // 0-19,999: Junior
    // 20,000-39,999: Mid-Level
    // 40,000-59,999: Senior
    // 60,000-79,999: Staff
    // 80,000-99,999: Lead/Principal
    const titleIdx = Math.min(Math.floor(i / 20000), titles.length - 1);

    // Age: 25-65, cyclic distribution
    const age = 25 + (i % 40);

    // Salary: Base + level bonus + variation
    // Junior: $50k-$100k
    // Mid: $75k-$125k
    // Senior: $100k-$150k
    // Staff: $125k-$175k
    // Lead: $150k-$200k
    // Principal: $175k-$225k
    const baseSalary = 50000 + titleIdx * 25000 + (i % 50000);

    // Core attributes (9 per employee)
    triples.push(
      {
        entityId: empId,
        attribute: ":name",
        value: string(`Employee-${i}`),
        entityType: "Employee",
      },
      {
        entityId: empId,
        attribute: ":email",
        value: string(`emp${i}@company.com`),
      },
      {
        entityId: empId,
        attribute: ":age",
        value: number(age),
      },
      {
        entityId: empId,
        attribute: ":salary",
        value: number(baseSalary),
      },
      {
        entityId: empId,
        attribute: ":department",
        value: string(departments[deptIdx]!),
      },
      {
        entityId: empId,
        attribute: ":title",
        value: string(titles[titleIdx]!),
      },
      {
        entityId: empId,
        attribute: ":active",
        value: boolean(i % 10 !== 0), // 90% active
      },
      {
        entityId: empId,
        attribute: ":hire_date",
        value: datetime(Date.now() - i * 86400000), // Distributed over past days
      },
      {
        entityId: empId,
        attribute: ":location",
        value: string(locations[i % 5]!),
      },
    );

    // 20% have manager references (creates graph structure for relationship queries)
    if (i > 0 && i % 5 === 0) {
      const managerId = Math.max(0, i - 10 - (i % 10));
      triples.push({
        entityId: empId,
        attribute: ":manager",
        value: ref(EntityId.make(`emp:${managerId}`)),
      });
    }
  }

  return triples;
}

// ─── Attributes updated per round ──────────────────────────────────────────

/**
 * Number of attributes updated per employee per round.
 * We update 5 of the 10 attributes each round: salary, age, title, hire_date, active.
 */
export const UPDATED_ATTRIBUTES_PER_ROUND = 5;

/** The 5 attributes that get updated each round. */
export const UPDATED_ATTRIBUTES = [":salary", ":age", ":title", ":hire_date", ":active"] as const;

const TITLES = ["Junior", "Mid-Level", "Senior", "Staff", "Lead", "Principal"];

/**
 * Generate transact operations for a batch of employee updates.
 *
 * Each employee gets 5 attribute updates per round:
 * - :salary   → +5000 per round (raises)
 * - :age      → +1 per round (aging)
 * - :title    → cycle through title levels
 * - :hire_date → shift forward 30 days per round (re-onboarding date)
 * - :active   → toggle every 10th employee per round
 *
 * Each attribute update is a retract-pattern + assert pair within a single
 * transact call, making it atomic.
 *
 * @param startIdx First employee index in this batch (inclusive)
 * @param endIdx Last employee index in this batch (exclusive)
 * @param round Update round number (1-based)
 * @returns Array of TransactOp[] — one inner array per employee (to be passed to store.transact)
 */
export function generateUpdateBatch(
  startIdx: number,
  endIdx: number,
  round: number,
): TransactOp[][] {
  const result: TransactOp[][] = [];

  for (let i = startIdx; i < endIdx; i++) {
    const empId = EntityId.make(`emp:${i}`);
    const ops: TransactOp[] = [];

    // :salary — increment by 5000 per round
    const baseTitleIdx = Math.min(Math.floor(i / 20000), TITLES.length - 1);
    const baseSalary = 50000 + baseTitleIdx * 25000 + (i % 50000);
    const newSalary = baseSalary + 5000 * round;
    ops.push(
      { op: "retract-pattern", pattern: { entityId: empId, attribute: ":salary" } },
      { op: "assert", entityId: empId, attribute: ":salary", value: number(newSalary) },
    );

    // :age — increment by 1 per round
    const baseAge = 25 + (i % 40);
    const newAge = baseAge + round;
    ops.push(
      { op: "retract-pattern", pattern: { entityId: empId, attribute: ":age" } },
      { op: "assert", entityId: empId, attribute: ":age", value: number(newAge) },
    );

    // :title — cycle through title levels
    const newTitleIdx = Math.min(baseTitleIdx + (round % TITLES.length), TITLES.length - 1);
    ops.push(
      { op: "retract-pattern", pattern: { entityId: empId, attribute: ":title" } },
      {
        op: "assert",
        entityId: empId,
        attribute: ":title",
        value: string(TITLES[newTitleIdx]!),
      },
    );

    // :hire_date — shift forward 30 days per round
    const baseHireDate = Date.now() - i * 86400000;
    const newHireDate = baseHireDate + round * 30 * 86400000;
    ops.push(
      { op: "retract-pattern", pattern: { entityId: empId, attribute: ":hire_date" } },
      {
        op: "assert",
        entityId: empId,
        attribute: ":hire_date",
        value: datetime(newHireDate),
      },
    );

    // :active — toggle every 10th employee per round
    const baseActive = i % 10 !== 0;
    const newActive = round % 2 === 0 ? baseActive : !baseActive;
    ops.push(
      { op: "retract-pattern", pattern: { entityId: empId, attribute: ":active" } },
      {
        op: "assert",
        entityId: empId,
        attribute: ":active",
        value: boolean(newActive),
      },
    );

    result.push(ops);
  }

  return result;
}

/**
 * Generate TripleInput[] for the assert side of a bulk update.
 *
 * This is the "fast path" counterpart to generateUpdateBatch — it produces
 * only the new assertion triples, without the retract-pattern ops. The caller
 * is responsible for doing a bulk retract via raw SQL first.
 *
 * @param startIdx First employee index in this batch (inclusive)
 * @param endIdx Last employee index in this batch (exclusive)
 * @param round Update round number (1-based)
 * @returns Array of TripleInput for assertBatch
 */
export function generateUpdateTriples(
  startIdx: number,
  endIdx: number,
  round: number,
): TripleInput[] {
  const triples: TripleInput[] = [];

  for (let i = startIdx; i < endIdx; i++) {
    const empId = EntityId.make(`emp:${i}`);

    // :salary
    const baseTitleIdx = Math.min(Math.floor(i / 20000), TITLES.length - 1);
    const baseSalary = 50000 + baseTitleIdx * 25000 + (i % 50000);
    triples.push({
      entityId: empId,
      attribute: ":salary",
      value: number(baseSalary + 5000 * round),
    });

    // :age
    triples.push({
      entityId: empId,
      attribute: ":age",
      value: number(25 + (i % 40) + round),
    });

    // :title
    const newTitleIdx = Math.min(baseTitleIdx + (round % TITLES.length), TITLES.length - 1);
    triples.push({
      entityId: empId,
      attribute: ":title",
      value: string(TITLES[newTitleIdx]!),
    });

    // :hire_date
    const baseHireDate = Date.now() - i * 86400000;
    triples.push({
      entityId: empId,
      attribute: ":hire_date",
      value: datetime(baseHireDate + round * 30 * 86400000),
    });

    // :active
    const baseActive = i % 10 !== 0;
    const newActive = round % 2 === 0 ? baseActive : !baseActive;
    triples.push({
      entityId: empId,
      attribute: ":active",
      value: boolean(newActive),
    });
  }

  return triples;
}
