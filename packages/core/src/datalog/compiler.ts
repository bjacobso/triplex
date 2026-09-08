/**
 * SQL Compiler for Datalog Queries
 *
 * Compiles Datalog queries directly to SQL for efficient execution.
 * This replaces the in-memory engine for production use.
 */

import { Data } from "effect";
import {
  isVariable,
  isRuleApplication,
  isTypedConstant,
  isPredicateClause,
  isNotClause,
  normalizeOrAlternatives,
} from "./schema.js";
import type { SqlDialect } from "../dialects/index.js";
import { SqliteDialect } from "../dialects/sqlite.js";
import { createParamCollector, type ParamCollector } from "../params.js";
import { assertDatalogQuery } from "./validation.js";
import type {
  Constant,
  Term,
  PatternClause,
  PredicateClause,
  NotClause,
  OrClause,
  RuleApplication,
  Rule,
  Clause,
  DatalogQuery,
  OrderBySpec,
  HavingClause,
} from "./types.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Tracks where a variable is bound in the SQL query
 */
type TripleBindingPosition = "entity" | "attribute" | "value" | "tx";
type RuleBindingPosition = "arg1" | "arg2";

type VariableBinding =
  | {
      readonly _tag: "Triple";
      readonly alias: string;
      readonly position: TripleBindingPosition;
    }
  | {
      readonly _tag: "Rule";
      readonly alias: string;
      readonly position: RuleBindingPosition;
    };

const tripleBinding = (alias: string, position: TripleBindingPosition): VariableBinding => ({
  _tag: "Triple",
  alias,
  position,
});

const ruleBinding = (alias: string, position: RuleBindingPosition): VariableBinding => ({
  _tag: "Rule",
  alias,
  position,
});

type InternalClause = Data.TaggedEnum<{
  Pattern: { readonly pattern: PatternClause };
  Predicate: { readonly predicate: PredicateClause };
  Not: { readonly notClause: NotClause };
  Or: { readonly orClause: OrClause };
  RuleCall: { readonly ruleApplication: RuleApplication };
}>;

const InternalClause = Data.taggedEnum<InternalClause>();

interface ClassifiedClauses {
  patterns: PatternClause[];
  predicates: PredicateClause[];
  notClauses: NotClause[];
  orClauses: OrClause[];
  ruleApplications: RuleApplication[];
}

/**
 * Context for SQL compilation
 */
interface CompilerContext {
  /** Maps variable names to their first binding */
  bindings: Map<string, VariableBinding>;
  /** Counter for table aliases */
  aliasCounter: number;
  /** Generated JOIN clauses */
  joins: string[];
  /** Generated WHERE conditions */
  conditions: string[];
  /** Table alias for each pattern clause */
  patternAliases: Map<number, string>;
  /** Maps aggregate target variables to their SQL expressions (for HAVING/ORDER BY) */
  aggregateExpressions: Map<string, string>;
  /** Parameter collector for parameterized queries */
  collector: ParamCollector;
}

/**
 * Query compilation and execution metrics
 */
export interface QueryMetrics {
  // SQL Complexity
  joinCount: number;
  whereConditionCount: number;
  subqueryCount: number; // NOT EXISTS clauses
  cteCount: number; // Common Table Expressions (recursive queries)
  sqlLength: number;
  paramCount: number;

  // Clause Breakdown
  patternCount: number;
  predicateCount: number;
  notClauseCount: number;
  orClauseCount: number;

  // Features Used
  hasAggregation: boolean;
  isRecursive: boolean;
  aggregateOps: string[]; // e.g., ["count", "sum"]

  // Compilation Timing
  compilationTimeMs: number;
}

/**
 * Result of compiling a Datalog query
 */
export interface CompiledQuery {
  sql: string;
  /** Parameters for the parameterized query */
  params: unknown[];
  /** Maps result column names to variable names */
  columnMap: Map<string, string>;
  /** Canonical scalar-family columns used to decode a projected triple value. */
  valueColumnMap: Map<string, CompiledValueColumns>;
  /** Result columns whose SQL representation must be decoded as a number. */
  numericColumns: Set<string>;
  /** Parameterized constant projections and their backend-independent public values. */
  constantColumns: Map<string, string | number | boolean>;
  /** Optional metrics - only included when debug=true */
  metrics?: QueryMetrics;
}

export interface CompiledValueColumns {
  readonly category: string;
  readonly orderNumber: string;
  readonly orderText: string;
  readonly type: string;
  readonly string: string;
  readonly number: string;
  readonly boolean: string;
}

export interface CompileOptions {
  /** Evaluate every triple alias against this bitemporal basis. */
  readonly basis?: {
    readonly recordedAt?: number;
    readonly recordedPosition?: number;
    readonly validAt: number;
  };
}

const applyTemporalBasis = (sql: string, basis: CompileOptions["basis"]): string => {
  if (basis === undefined) return sql;
  const validAt = String(basis.validAt);
  return sql.replace(
    /\b([A-Za-z_][A-Za-z0-9_]*)\.retracted_at IS NULL/g,
    (_condition, alias: string) => {
      const recorded =
        basis.recordedPosition !== undefined
          ? `${alias}.recorded_position <= ${basis.recordedPosition}${basis.recordedAt === undefined ? "" : ` AND ${alias}.recorded_at <= ${basis.recordedAt}`} AND (${alias}.retracted_position IS NULL OR ${alias}.retracted_position > ${basis.recordedPosition}${basis.recordedAt === undefined ? "" : ` OR ${alias}.retracted_at > ${basis.recordedAt}`})`
          : basis.recordedAt === undefined
            ? `${alias}.retracted_at IS NULL`
            : `${alias}.recorded_at <= ${basis.recordedAt} AND (${alias}.retracted_at IS NULL OR ${alias}.retracted_at > ${basis.recordedAt})`;
      return `${recorded} AND ${alias}.valid_from <= ${validAt} AND (${alias}.valid_to IS NULL OR ${alias}.valid_to > ${validAt})`;
    },
  );
};

// =============================================================================
// Helpers
// =============================================================================

const ruleNamePattern = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

/** Rule names are SQL identifiers, so validate and quote them rather than treating them as values. */
const ruleIdentifier = (name: string): string => {
  if (!ruleNamePattern.test(name) || name === "not" || name === "or") {
    throw new Error(`Invalid Datalog rule name: ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
};

/**
 * Format a constant value for SQL using parameterized queries.
 * Uses the ParamCollector to add the value and return a placeholder.
 */
const formatValue = (value: Constant, ctx: CompilerContext): string => {
  if (isTypedConstant(value)) return ctx.collector.add(value.value);
  return ctx.collector.add(value);
};

/** Format a constant for one of the physical value_* storage columns. */
const formatStoredValue = (value: Constant, ctx: CompilerContext): string =>
  typeof value === "boolean" ? ctx.collector.add(value ? 1 : 0) : formatValue(value, ctx);

/**
 * Get the column expression for a term in a given alias
 */
const getColumnForPosition = (
  alias: string,
  position: TripleBindingPosition,
  valueColumn?: "value_string" | "value_number" | "value_boolean",
): string => {
  switch (position) {
    case "entity":
      return `${alias}.entity_id`;
    case "attribute":
      return `${alias}.attribute`;
    case "value":
      return valueColumn ? `${alias}.${valueColumn}` : `${alias}.value_string`;
    case "tx":
      return `${alias}.tx_id`;
  }
};

type BindingValueMode = "raw" | "string" | "number" | "boolean" | "coalesce";

const resolveBinding = (
  binding: VariableBinding,
  options: { valueMode?: BindingValueMode } = {},
): string => {
  const valueMode = options.valueMode ?? "raw";

  if (binding._tag === "Rule") {
    if (valueMode === "number") {
      return `CAST(${binding.alias}.${binding.position} AS REAL)`;
    }
    return `${binding.alias}.${binding.position}`;
  }

  if (binding.position === "value") {
    if (valueMode === "coalesce") {
      return `COALESCE(${binding.alias}.value_string, CAST(${binding.alias}.value_number AS TEXT), CAST(${binding.alias}.value_boolean AS TEXT), CAST(${binding.alias}.value_datetime AS TEXT), ${binding.alias}.value_json)`;
    }
    if (valueMode === "number") {
      return `COALESCE(${binding.alias}.value_number, ${binding.alias}.value_datetime)`;
    }
    if (valueMode === "boolean") {
      return `${binding.alias}.value_boolean`;
    }
    return `${binding.alias}.value_string`;
  }

  return getColumnForPosition(binding.alias, binding.position);
};

const isTripleValueBinding = (
  binding: VariableBinding,
): binding is Extract<VariableBinding, { readonly _tag: "Triple" }> =>
  binding._tag === "Triple" && binding.position === "value";

const textScalarExpression = (alias: string): string =>
  `COALESCE(${alias}.value_string, ${alias}.value_json)`;

const numberScalarExpression = (alias: string): string =>
  `COALESCE(${alias}.value_number, ${alias}.value_datetime)`;

const textScalarTypeCondition = (alias: string): string =>
  `${alias}.value_type IN ('string', 'ref', 'blob', 'json')`;

const numberScalarTypeCondition = (alias: string): string =>
  `${alias}.value_type IN ('number', 'datetime')`;

/** Match a pattern constant using the flattened scalar identity exposed by Datalog. */
const compilePatternValueCondition = (
  alias: string,
  value: Constant,
  ctx: CompilerContext,
): string => {
  if (isTypedConstant(value)) {
    return `(${alias}.value_type = ${ctx.collector.add(value.type)} AND ${alias}.value_string = ${ctx.collector.add(value.value)})`;
  }
  if (typeof value === "number") {
    return `((${numberScalarTypeCondition(alias)}) AND ${numberScalarExpression(alias)} = ${formatValue(value, ctx)})`;
  }
  if (typeof value === "boolean") {
    return `(${alias}.value_type = 'boolean' AND ${alias}.value_boolean = ${formatStoredValue(value, ctx)})`;
  }
  return `((${textScalarTypeCondition(alias)}) AND ${textScalarExpression(alias)} = ${formatValue(value, ctx)})`;
};

/** Compare bindings using the flattened scalar semantics exposed by the KV executor. */
const compileBindingEquality = (left: VariableBinding, right: VariableBinding): string => {
  if (isTripleValueBinding(left) && isTripleValueBinding(right)) {
    return `(((${textScalarTypeCondition(left.alias)}) AND (${textScalarTypeCondition(right.alias)}) AND ${textScalarExpression(left.alias)} = ${textScalarExpression(right.alias)}) OR ((${numberScalarTypeCondition(left.alias)}) AND (${numberScalarTypeCondition(right.alias)}) AND ${numberScalarExpression(left.alias)} = ${numberScalarExpression(right.alias)}) OR (${left.alias}.value_type = 'boolean' AND ${right.alias}.value_type = 'boolean' AND ${left.alias}.value_boolean = ${right.alias}.value_boolean))`;
  }

  if (isTripleValueBinding(left)) {
    return `((${textScalarTypeCondition(left.alias)}) AND ${textScalarExpression(left.alias)} = ${resolveBinding(right)})`;
  }

  if (isTripleValueBinding(right)) {
    return `((${textScalarTypeCondition(right.alias)}) AND ${resolveBinding(left)} = ${textScalarExpression(right.alias)})`;
  }

  return `${resolveBinding(left)} = ${resolveBinding(right)}`;
};

const compileBindingConstantEquality = (
  binding: VariableBinding,
  value: Constant,
  ctx: CompilerContext,
): string => {
  if (!isTripleValueBinding(binding)) {
    const scalar = constantScalar(value);
    return typeof scalar === "string"
      ? `${resolveBinding(binding)} = ${formatValue(scalar, ctx)}`
      : "1 = 0";
  }

  if (typeof value === "number") {
    return `((${numberScalarTypeCondition(binding.alias)}) AND ${numberScalarExpression(binding.alias)} = ${formatValue(value, ctx)})`;
  }
  if (typeof value === "boolean") {
    return `(${binding.alias}.value_type = 'boolean' AND ${binding.alias}.value_boolean = ${formatStoredValue(value, ctx)})`;
  }

  const scalar = isTypedConstant(value) ? value.value : value;
  return `((${textScalarTypeCondition(binding.alias)}) AND ${textScalarExpression(binding.alias)} = ${formatValue(scalar, ctx)})`;
};

const constantScalar = (value: Constant): string | number | boolean =>
  isTypedConstant(value) ? value.value : value;

const compileEqualityCondition = (left: Term, right: Term, ctx: CompilerContext): string => {
  if (isVariable(left) && isVariable(right)) {
    const leftBinding = ctx.bindings.get(left);
    const rightBinding = ctx.bindings.get(right);
    if (!leftBinding) throw new Error(`Unbound variable in predicate: ${left}`);
    if (!rightBinding) throw new Error(`Unbound variable in predicate: ${right}`);
    return compileBindingEquality(leftBinding, rightBinding);
  }

  if (isVariable(left)) {
    const binding = ctx.bindings.get(left);
    if (!binding) throw new Error(`Unbound variable in predicate: ${left}`);
    return compileBindingConstantEquality(binding, right as Constant, ctx);
  }

  if (isVariable(right)) {
    const binding = ctx.bindings.get(right);
    if (!binding) throw new Error(`Unbound variable in predicate: ${right}`);
    return compileBindingConstantEquality(binding, left as Constant, ctx);
  }

  return constantScalar(left as Constant) === constantScalar(right as Constant) ? "1 = 1" : "1 = 0";
};

interface OrderedTermExpression {
  readonly expression: string;
  readonly typeCondition?: string;
}

/** Resolve the numeric-only scalar contract used by ordered Datalog predicates. */
const orderedTermExpression = (term: Term, ctx: CompilerContext): OrderedTermExpression | null => {
  if (!isVariable(term)) {
    const value = constantScalar(term as Constant);
    return typeof value === "number" ? { expression: formatValue(value, ctx) } : null;
  }

  const aggregate = ctx.aggregateExpressions.get(term);
  if (aggregate !== undefined) return { expression: aggregate };

  const binding = ctx.bindings.get(term);
  if (!binding || !isTripleValueBinding(binding)) return null;
  return {
    expression: numberScalarExpression(binding.alias),
    typeCondition: numberScalarTypeCondition(binding.alias),
  };
};

const compileOrderedPredicateCondition = (
  op: ">" | ">=" | "<" | "<=",
  left: Term,
  right: Term,
  ctx: CompilerContext,
): string => {
  const leftTerm = orderedTermExpression(left, ctx);
  const rightTerm = orderedTermExpression(right, ctx);
  if (leftTerm === null || rightTerm === null) return "1 = 0";

  const conditions = [leftTerm.typeCondition, rightTerm.typeCondition].filter(
    (condition): condition is string => condition !== undefined,
  );
  conditions.push(`${leftTerm.expression} ${op} ${rightTerm.expression}`);
  return `(${conditions.join(" AND ")})`;
};

const isValueLikeBinding = (binding: VariableBinding): boolean => {
  return (
    (binding._tag === "Triple" && binding.position === "value") ||
    (binding._tag === "Rule" && binding.position === "arg2")
  );
};

const predicateOperators = new Set<PredicateClause[0]>([">", ">=", "<", "<=", "=", "!="]);

const parseClause = (
  clause: Clause,
  options: { allowRuleApplications: boolean },
): InternalClause => {
  const head = clause[0];

  if (typeof head === "string" && predicateOperators.has(head as PredicateClause[0])) {
    if (clause.length !== 3) {
      throw new Error(`Invalid predicate clause arity: ${JSON.stringify(clause)}`);
    }
    return InternalClause.Predicate({ predicate: clause as PredicateClause });
  }

  if (head === "not") {
    if (clause.length < 2) {
      throw new Error(`Invalid not clause arity: ${JSON.stringify(clause)}`);
    }
    return InternalClause.Not({ notClause: clause as NotClause });
  }

  if (head === "or") {
    const alternatives = normalizeOrAlternatives(clause as OrClause | readonly ["or", ...Clause[]]);
    return InternalClause.Or({ orClause: ["or", alternatives] as OrClause });
  }

  if (clause.length < 3 || clause.length > 4) {
    throw new Error(`Invalid clause arity: ${JSON.stringify(clause)}`);
  }

  if (clause.length === 3 && isRuleApplication(clause as Clause)) {
    if (!options.allowRuleApplications) {
      throw new Error(
        `Rule application "${clause[0]}" requires compileWithRules() and rule definitions`,
      );
    }
    return InternalClause.RuleCall({ ruleApplication: clause as RuleApplication });
  }

  return InternalClause.Pattern({ pattern: clause as PatternClause });
};

const classifyClauses = (
  where: readonly Clause[],
  options: { allowRuleApplications: boolean },
): ClassifiedClauses => {
  const classified: ClassifiedClauses = {
    patterns: [],
    predicates: [],
    notClauses: [],
    orClauses: [],
    ruleApplications: [],
  };

  for (const clause of where) {
    const parsed = parseClause(clause, options);
    switch (parsed._tag) {
      case "Pattern":
        classified.patterns.push(parsed.pattern);
        break;
      case "Predicate":
        classified.predicates.push(parsed.predicate);
        break;
      case "Not":
        classified.notClauses.push(parsed.notClause);
        break;
      case "Or":
        classified.orClauses.push(parsed.orClause);
        break;
      case "RuleCall":
        classified.ruleApplications.push(parsed.ruleApplication);
        break;
    }
  }

  return classified;
};

/**
 * Create a new compiler context
 */
const createContext = (dialect: SqlDialect): CompilerContext => ({
  bindings: new Map(),
  aliasCounter: 0,
  joins: [],
  conditions: [],
  patternAliases: new Map(),
  aggregateExpressions: new Map(),
  collector: createParamCollector(dialect),
});

/**
 * Get the next table alias
 */
const nextAlias = (ctx: CompilerContext): string => {
  const alias = `t${ctx.aliasCounter}`;
  ctx.aliasCounter++;
  return alias;
};

// =============================================================================
// Pattern Compilation
// =============================================================================

/**
 * Compile a single pattern clause to SQL
 * Returns the table alias used for this pattern
 *
 * Supports both 3-tuple [entity, attribute, value] and
 * 4-tuple [entity, attribute, value, tx] patterns
 */
const compilePattern = (
  pattern: PatternClause,
  ctx: CompilerContext,
  isFirstPattern: boolean,
): string => {
  const [entity, attribute, value] = pattern;
  // Optional 4th element is the transaction binding
  const tx = pattern.length === 4 ? pattern[3] : undefined;
  const alias = nextAlias(ctx);

  // Build JOIN or FROM clause
  if (isFirstPattern) {
    // First pattern goes in FROM (no JOIN needed)
    ctx.conditions.push(`${alias}.retracted_at IS NULL`);
  } else {
    // Subsequent patterns are JOINed
    // Find the join condition based on shared variables
    let joinCondition = `${alias}.retracted_at IS NULL`;

    // Check if entity is a bound variable
    if (isVariable(entity) && ctx.bindings.has(entity)) {
      const binding = ctx.bindings.get(entity)!;
      joinCondition = `${compileBindingEquality(tripleBinding(alias, "entity"), binding)} AND ${joinCondition}`;
    }

    ctx.joins.push(`JOIN triples ${alias} ON ${joinCondition}`);
  }

  // Process entity term
  if (isVariable(entity)) {
    if (!ctx.bindings.has(entity)) {
      ctx.bindings.set(entity, tripleBinding(alias, "entity"));
    } else {
      // Already bound - add equality condition for join
      // (supplements the JOIN condition from lines above for robustness)
      const binding = ctx.bindings.get(entity)!;
      ctx.conditions.push(compileBindingEquality(tripleBinding(alias, "entity"), binding));
    }
  } else {
    ctx.conditions.push(`${alias}.entity_id = ${formatValue(entity, ctx)}`);
  }

  // Process attribute term
  if (isVariable(attribute)) {
    if (!ctx.bindings.has(attribute)) {
      ctx.bindings.set(attribute, tripleBinding(alias, "attribute"));
    } else {
      // Already bound - add equality condition for join
      const binding = ctx.bindings.get(attribute)!;
      ctx.conditions.push(compileBindingEquality(tripleBinding(alias, "attribute"), binding));
    }
  } else {
    ctx.conditions.push(`${alias}.attribute = ${formatValue(attribute, ctx)}`);
  }

  // Process value term
  if (isVariable(value)) {
    if (!ctx.bindings.has(value)) {
      ctx.bindings.set(value, tripleBinding(alias, "value"));
    } else {
      // Already bound - add equality condition for join
      const binding = ctx.bindings.get(value)!;
      ctx.conditions.push(compileBindingEquality(tripleBinding(alias, "value"), binding));
    }
  } else {
    ctx.conditions.push(compilePatternValueCondition(alias, value, ctx));
  }

  // Process tx term (optional 4th element)
  if (tx !== undefined) {
    if (isVariable(tx)) {
      if (!ctx.bindings.has(tx)) {
        // First occurrence - bind to tx_id column
        ctx.bindings.set(tx, tripleBinding(alias, "tx"));
      } else {
        // Already bound - add equality condition for join
        const binding = ctx.bindings.get(tx)!;
        ctx.conditions.push(compileBindingEquality(tripleBinding(alias, "tx"), binding));
      }
    } else {
      // tx is a constant - filter by specific transaction ID
      ctx.conditions.push(`${alias}.tx_id = ${formatValue(tx, ctx)}`);
    }
  }

  return alias;
};

// =============================================================================
// Predicate Compilation
// =============================================================================

/**
 * Compile a predicate clause to SQL WHERE condition
 */
const compilePredicateCondition = (predicate: PredicateClause, ctx: CompilerContext): string => {
  const [op, left, right] = predicate;

  if (op === "=" || op === "!=") {
    const equality = compileEqualityCondition(left, right, ctx);
    return op === "=" ? equality : `NOT (${equality})`;
  }
  return compileOrderedPredicateCondition(op, left, right, ctx);
};

const compilePredicate = (predicate: PredicateClause, ctx: CompilerContext): void => {
  ctx.conditions.push(compilePredicateCondition(predicate, ctx));
};

// =============================================================================
// Not Clause Compilation
// =============================================================================

/**
 * Compile a NOT clause to SQL NOT EXISTS subquery
 */
/**
 * Build conditions for a single pattern within a NOT EXISTS subquery.
 * Returns conditions that constrain the given alias.
 */
const compileNotPattern = (
  pattern: PatternClause,
  alias: string,
  ctx: CompilerContext,
  localBindings: Map<string, VariableBinding>,
): string[] => {
  const [entity, attribute, value] = pattern;
  const tx = pattern.length === 4 ? pattern[3] : undefined;
  const conditions: string[] = [`${alias}.retracted_at IS NULL`];

  // Handle entity
  if (isVariable(entity)) {
    const outerBinding = ctx.bindings.get(entity);
    const localBinding = localBindings.get(entity);
    if (localBinding) {
      // Variable already bound in a prior pattern within this not — join
      conditions.push(compileBindingEquality(tripleBinding(alias, "entity"), localBinding));
    } else if (outerBinding) {
      // Variable bound in outer query — correlate
      conditions.push(compileBindingEquality(tripleBinding(alias, "entity"), outerBinding));
    }
    // Record local binding for subsequent patterns
    localBindings.set(entity, tripleBinding(alias, "entity"));
  } else {
    conditions.push(`${alias}.entity_id = ${formatValue(entity, ctx)}`);
  }

  // Handle attribute
  if (isVariable(attribute)) {
    const outerBinding = ctx.bindings.get(attribute);
    const localBinding = localBindings.get(attribute);
    if (localBinding) {
      conditions.push(compileBindingEquality(tripleBinding(alias, "attribute"), localBinding));
    } else if (outerBinding) {
      conditions.push(compileBindingEquality(tripleBinding(alias, "attribute"), outerBinding));
    }
    localBindings.set(attribute, tripleBinding(alias, "attribute"));
  } else {
    conditions.push(`${alias}.attribute = ${formatValue(attribute, ctx)}`);
  }

  // Handle value
  if (isVariable(value)) {
    const outerBinding = ctx.bindings.get(value);
    const localBinding = localBindings.get(value);
    if (localBinding) {
      conditions.push(compileBindingEquality(tripleBinding(alias, "value"), localBinding));
    } else if (outerBinding) {
      conditions.push(compileBindingEquality(tripleBinding(alias, "value"), outerBinding));
    }
    localBindings.set(value, tripleBinding(alias, "value"));
  } else {
    conditions.push(compilePatternValueCondition(alias, value, ctx));
  }

  if (tx !== undefined) {
    if (isVariable(tx)) {
      const outerBinding = ctx.bindings.get(tx);
      const localBinding = localBindings.get(tx);
      if (localBinding) {
        conditions.push(compileBindingEquality(tripleBinding(alias, "tx"), localBinding));
      } else if (outerBinding) {
        conditions.push(compileBindingEquality(tripleBinding(alias, "tx"), outerBinding));
      }
      localBindings.set(tx, tripleBinding(alias, "tx"));
    } else {
      conditions.push(`${alias}.tx_id = ${formatValue(tx, ctx)}`);
    }
  }

  return conditions;
};

/**
 * Compile a predicate clause within a NOT EXISTS subquery.
 * Predicates reference local bindings (from patterns within the same not).
 */
const compileNotPredicate = (
  clause: PredicateClause,
  ctx: CompilerContext,
  localBindings: Map<string, VariableBinding>,
): string => {
  const bindings = new Map(ctx.bindings);
  for (const [variable, binding] of localBindings) bindings.set(variable, binding);
  const localContext: CompilerContext = { ...ctx, bindings };
  return compilePredicateCondition(clause, localContext);
};

const compileNotCondition = (notClause: NotClause, ctx: CompilerContext): string => {
  // Extract inner clauses: ["not", c1] or ["not", c1, c2, ...]
  const innerClauses = notClause.slice(1) as (PatternClause | PredicateClause)[];

  // Separate patterns from predicates
  const patterns: PatternClause[] = [];
  const predicates: PredicateClause[] = [];
  for (const clause of innerClauses) {
    if (isPredicateClause(clause as Clause)) {
      predicates.push(clause as PredicateClause);
    } else {
      patterns.push(clause as PatternClause);
    }
  }

  const localBindings = new Map<string, VariableBinding>();
  const allConditions: string[] = [];
  const fromParts: string[] = [];

  for (const pattern of patterns) {
    const alias = nextAlias(ctx);
    fromParts.push(`triples ${alias}`);
    const conditions = compileNotPattern(pattern, alias, ctx, localBindings);
    allConditions.push(...conditions);
  }

  // Compile predicates using local bindings
  for (const pred of predicates) {
    allConditions.push(compileNotPredicate(pred, ctx, localBindings));
  }

  if (patterns.length === 0) {
    if (allConditions.length === 0) {
      throw new Error(`Invalid not clause arity: ${JSON.stringify(notClause)}`);
    }
    return `NOT (${allConditions.join(" AND ")})`;
  }

  const fromClause = fromParts.join(", ");
  return `NOT EXISTS (SELECT 1 FROM ${fromClause} WHERE ${allConditions.join(" AND ")})`;
};

const compileNot = (notClause: NotClause, ctx: CompilerContext): void => {
  ctx.conditions.push(compileNotCondition(notClause, ctx));
};

// =============================================================================
// Or Clause Compilation
// =============================================================================

/**
 * Compile an OR clause to SQL OR conditions.
 * Or alternatives are filter/existence checks and do not bind variables outward.
 */
const compileOr = (orClause: OrClause, ctx: CompilerContext): void => {
  const alternatives = normalizeOrAlternatives(orClause);
  if (alternatives.length === 0) return;

  const orConditions = alternatives.map((alternative) => {
    if (isPredicateClause(alternative as Clause)) {
      return `(${compilePredicateCondition(alternative as PredicateClause, ctx)})`;
    }
    if (isNotClause(alternative as Clause)) {
      return `(${compileNotCondition(alternative as NotClause, ctx)})`;
    }

    const alias = nextAlias(ctx);
    const localBindings = new Map<string, VariableBinding>();
    const conditions = compileNotPattern(alternative as PatternClause, alias, ctx, localBindings);
    return `(EXISTS (SELECT 1 FROM triples ${alias} WHERE ${conditions.join(" AND ")}))`;
  });

  if (orConditions.length > 0) {
    ctx.conditions.push(`(${orConditions.join(" OR ")})`);
  }
};

// =============================================================================
// HAVING, ORDER BY, LIMIT/OFFSET Helpers
// =============================================================================

/**
 * Get a column expression for a variable binding (handles value coalesce and tx)
 */
const getColumnExpression = (binding: VariableBinding): string => {
  return resolveBinding(binding, { valueMode: "coalesce" });
};

/** Encode a flattened binding with its scalar family for portable COUNT DISTINCT semantics. */
const distinctCountExpression = (binding: VariableBinding): string => {
  if (!isTripleValueBinding(binding)) return resolveBinding(binding);
  const { alias } = binding;
  return `CASE
    WHEN ${numberScalarTypeCondition(alias)} THEN 'number:' || CAST(${numberScalarExpression(alias)} AS TEXT)
    WHEN ${alias}.value_type = 'boolean' THEN 'boolean:' || CAST(${alias}.value_boolean AS TEXT)
    WHEN ${textScalarTypeCondition(alias)} THEN 'text:' || ${textScalarExpression(alias)}
    ELSE NULL
  END`;
};

interface OptionalProjectionExpressions {
  readonly scalar: string;
  readonly category: string;
  readonly orderNumber: string;
  readonly orderText: string;
  readonly type: string;
  readonly string: string;
  readonly number: string;
  readonly boolean: string;
}

/**
 * SQL projections use the same flattened scalar families as the public
 * Datalog context. Canonicalizing here lets SELECT DISTINCT and GROUP BY
 * collapse storage-level aliases such as number/datetime and string/ref.
 */
const valueProjectionExpressions = (alias: string): OptionalProjectionExpressions => ({
  // SqlQueryExecutor decodes from the hidden canonical columns. Keeping the
  // public carrier constant prevents its SQL affinity from affecting DISTINCT.
  scalar: "NULL",
  category: `CASE WHEN ${numberScalarTypeCondition(alias)} THEN 0 WHEN ${alias}.value_type = 'boolean' THEN 1 ELSE 2 END`,
  orderNumber: numberScalarExpression(alias),
  orderText: textScalarExpression(alias),
  type: `CASE WHEN ${numberScalarTypeCondition(alias)} THEN 'number' WHEN ${alias}.value_type = 'boolean' THEN 'boolean' WHEN ${textScalarTypeCondition(alias)} THEN 'string' ELSE NULL END`,
  string: `CASE WHEN ${textScalarTypeCondition(alias)} THEN ${textScalarExpression(alias)} ELSE NULL END`,
  number: `CASE WHEN ${numberScalarTypeCondition(alias)} THEN ${numberScalarExpression(alias)} ELSE NULL END`,
  boolean: `CASE WHEN ${alias}.value_type = 'boolean' THEN ${alias}.value_boolean ELSE NULL END`,
});

const valueProjectionGroupExpressions = (
  projection: OptionalProjectionExpressions,
): readonly string[] => [
  projection.category,
  projection.orderNumber,
  projection.orderText,
  projection.type,
  projection.string,
  projection.number,
  projection.boolean,
];

const optionalProjectionExpressions = (
  variable: string,
  optionalProjection: OptionalProjectionSpec | undefined,
  ctx: CompilerContext,
): OptionalProjectionExpressions | null => {
  if (!optionalProjection) return null;

  const projection = optionalProjection.fields.find((field) => field.variable === variable);
  if (!projection) return null;

  const rowBinding = ctx.bindings.get(optionalProjection.rowBinding);
  if (!rowBinding) return null;

  const entityExpr = resolveBinding(rowBinding, { valueMode: "string" });
  const attributeExpr = formatValue(projection.attribute, ctx);

  const select = (expression: string): string => {
    return `(
    SELECT ${expression}
    FROM triples opt
    WHERE opt.entity_id = ${entityExpr}
      AND opt.attribute = ${attributeExpr}
      AND opt.retracted_at IS NULL
    LIMIT 1
  )`;
  };

  return {
    scalar: "NULL",
    category: `COALESCE(${select(
      "CASE WHEN opt.value_type IN ('number', 'datetime') THEN 0 WHEN opt.value_type = 'boolean' THEN 1 ELSE 2 END",
    )}, 3)`,
    orderNumber: select("COALESCE(opt.value_number, opt.value_datetime)"),
    orderText: select("COALESCE(opt.value_string, opt.value_json)"),
    type: select(
      "CASE WHEN opt.value_type IN ('number', 'datetime') THEN 'number' WHEN opt.value_type = 'boolean' THEN 'boolean' WHEN opt.value_type IN ('string', 'ref', 'blob', 'json') THEN 'string' ELSE NULL END",
    ),
    string: select(
      "CASE WHEN opt.value_type IN ('string', 'ref', 'blob', 'json') THEN COALESCE(opt.value_string, opt.value_json) ELSE NULL END",
    ),
    number: select(
      "CASE WHEN opt.value_type IN ('number', 'datetime') THEN COALESCE(opt.value_number, opt.value_datetime) ELSE NULL END",
    ),
    boolean: select("CASE WHEN opt.value_type = 'boolean' THEN opt.value_boolean ELSE NULL END"),
  };
};

/** Equality over a grouped binding must reference the exact canonical
 * expressions present in GROUP BY so PostgreSQL accepts it. */
const compileGroupedBindingEquality = (left: VariableBinding, right: VariableBinding): string => {
  if (isTripleValueBinding(left) && isTripleValueBinding(right)) {
    const leftProjection = valueProjectionExpressions(left.alias);
    const rightProjection = valueProjectionExpressions(right.alias);
    return `((${leftProjection.type} = 'number' AND ${rightProjection.type} = 'number' AND ${leftProjection.number} = ${rightProjection.number}) OR (${leftProjection.type} = 'boolean' AND ${rightProjection.type} = 'boolean' AND ${leftProjection.boolean} = ${rightProjection.boolean}) OR (${leftProjection.type} = 'string' AND ${rightProjection.type} = 'string' AND ${leftProjection.string} = ${rightProjection.string}))`;
  }

  if (isTripleValueBinding(left)) {
    const projection = valueProjectionExpressions(left.alias);
    return `(${projection.type} = 'string' AND ${projection.string} = ${resolveBinding(right)})`;
  }
  if (isTripleValueBinding(right)) {
    const projection = valueProjectionExpressions(right.alias);
    return `(${projection.type} = 'string' AND ${resolveBinding(left)} = ${projection.string})`;
  }
  return `${resolveBinding(left)} = ${resolveBinding(right)}`;
};

const compileGroupedBindingConstantEquality = (
  binding: VariableBinding,
  value: Constant,
  ctx: CompilerContext,
): string => {
  if (!isTripleValueBinding(binding)) {
    const scalar = constantScalar(value);
    return typeof scalar === "string"
      ? `${resolveBinding(binding)} = ${formatValue(scalar, ctx)}`
      : "1 = 0";
  }

  const projection = valueProjectionExpressions(binding.alias);
  const scalar = constantScalar(value);
  if (typeof scalar === "number") {
    return `(${projection.type} = 'number' AND ${projection.number} = ${formatValue(scalar, ctx)})`;
  }
  if (typeof scalar === "boolean") {
    return `(${projection.type} = 'boolean' AND ${projection.boolean} = ${formatStoredValue(scalar, ctx)})`;
  }
  return `(${projection.type} = 'string' AND ${projection.string} = ${formatValue(scalar, ctx)})`;
};

const compileGroupedEqualityCondition = (left: Term, right: Term, ctx: CompilerContext): string => {
  if (isVariable(left) && isVariable(right)) {
    const leftBinding = ctx.bindings.get(left);
    const rightBinding = ctx.bindings.get(right);
    if (!leftBinding) throw new Error(`Unbound variable in HAVING: ${left}`);
    if (!rightBinding) throw new Error(`Unbound variable in HAVING: ${right}`);
    return compileGroupedBindingEquality(leftBinding, rightBinding);
  }
  if (isVariable(left)) {
    const binding = ctx.bindings.get(left);
    if (!binding) throw new Error(`Unbound variable in HAVING: ${left}`);
    return compileGroupedBindingConstantEquality(binding, right as Constant, ctx);
  }
  if (isVariable(right)) {
    const binding = ctx.bindings.get(right);
    if (!binding) throw new Error(`Unbound variable in HAVING: ${right}`);
    return compileGroupedBindingConstantEquality(binding, left as Constant, ctx);
  }
  return constantScalar(left as Constant) === constantScalar(right as Constant) ? "1 = 1" : "1 = 0";
};

const groupedNumericTermExpression = (
  term: Term,
  ctx: CompilerContext,
): OrderedTermExpression | null => {
  if (!isVariable(term)) {
    const value = constantScalar(term as Constant);
    return typeof value === "number" ? { expression: formatValue(value, ctx) } : null;
  }
  const aggregate = ctx.aggregateExpressions.get(term);
  if (aggregate !== undefined) return { expression: aggregate };

  const binding = ctx.bindings.get(term);
  if (!binding || !isTripleValueBinding(binding)) return null;
  const projection = valueProjectionExpressions(binding.alias);
  return { expression: projection.number, typeCondition: `${projection.type} = 'number'` };
};

const compileGroupedOrderedCondition = (
  op: ">" | ">=" | "<" | "<=",
  left: Term,
  right: Term,
  ctx: CompilerContext,
): string => {
  const leftTerm = groupedNumericTermExpression(left, ctx);
  const rightTerm = groupedNumericTermExpression(right, ctx);
  if (leftTerm === null || rightTerm === null) return "1 = 0";
  const conditions = [leftTerm.typeCondition, rightTerm.typeCondition].filter(
    (condition): condition is string => condition !== undefined,
  );
  conditions.push(`${leftTerm.expression} ${op} ${rightTerm.expression}`);
  return `(${conditions.join(" AND ")})`;
};

/**
 * HAVING equality involving an aggregate is numeric: aggregate targets are
 * numbers (or null for an empty input), and a grouped fact value must belong
 * to the same numeric scalar family. Equality between group keys keeps the
 * ordinary typed Datalog equality contract.
 */
const compileHavingEqualityCondition = (left: Term, right: Term, ctx: CompilerContext): string => {
  const hasAggregate =
    (isVariable(left) && ctx.aggregateExpressions.has(left)) ||
    (isVariable(right) && ctx.aggregateExpressions.has(right));
  if (!hasAggregate) return compileGroupedEqualityCondition(left, right, ctx);

  const leftTerm = groupedNumericTermExpression(left, ctx);
  const rightTerm = groupedNumericTermExpression(right, ctx);
  if (leftTerm === null || rightTerm === null) return "1 = 0";

  const conditions = [leftTerm.typeCondition, rightTerm.typeCondition].filter(
    (condition): condition is string => condition !== undefined,
  );
  conditions.push(`${leftTerm.expression} = ${rightTerm.expression}`);
  return `(${conditions.join(" AND ")})`;
};

/**
 * Build the HAVING clause from having specs
 */
const buildHavingClause = (
  having: readonly HavingClause[] | undefined,
  ctx: CompilerContext,
): string => {
  if (!having || having.length === 0) {
    return "";
  }

  const conditions = having.map(([op, left, right]) => {
    if (op === ">" || op === ">=" || op === "<" || op === "<=") {
      return compileGroupedOrderedCondition(op, left, right, ctx);
    }
    const equality = compileHavingEqualityCondition(left, right, ctx);
    return op === "=" ? equality : `NOT (${equality})`;
  });

  return `HAVING ${conditions.join(" AND ")}`;
};

/**
 * Build the ORDER BY clause
 */
const buildOrderByClause = (
  orderBy: readonly OrderBySpec[] | undefined,
  valueColumnMap: ReadonlyMap<string, CompiledValueColumns>,
): string => {
  if (!orderBy || orderBy.length === 0) {
    return "";
  }

  const parts = orderBy.flatMap(({ variable, direction = "asc" }) => {
    const columns = valueColumnMap.get(variable);
    if (columns === undefined) return [`"${variable}" ${direction.toUpperCase()}`];
    return [
      `"${columns.category}" ASC`,
      `"${columns.orderNumber}" ${direction.toUpperCase()}`,
      `"${columns.boolean}" ${direction.toUpperCase()}`,
      `"${columns.orderText}" ${direction.toUpperCase()}`,
    ];
  });

  return `ORDER BY ${parts.join(", ")}`;
};

/**
 * Build the LIMIT/OFFSET clause
 */
const buildLimitClause = (
  limit: number | undefined,
  offset: number | undefined,
  dialect: SqlDialect = SqliteDialect,
): string => {
  return dialect.limitOffset(limit, offset);
};

interface SelectAndGroupByResult {
  columnMap: Map<string, string>;
  valueColumnMap: Map<string, CompiledValueColumns>;
  numericColumns: Set<string>;
  constantColumns: Map<string, string | number | boolean>;
  selectParts: string[];
  groupByClause: string;
  hasAggregates: boolean;
  aggregateOps: string[];
}

type OptionalProjectionSpec = NonNullable<DatalogQuery["optionalProjection"]>;

const buildSelectAndGroupBy = (
  find: readonly Term[],
  aggregate: readonly (readonly [string, string, string])[] | undefined,
  optionalProjection: OptionalProjectionSpec | undefined,
  ctx: CompilerContext,
): SelectAndGroupByResult => {
  const columnMap = new Map<string, string>();
  const valueColumnMap = new Map<string, CompiledValueColumns>();
  const numericColumns = new Set<string>();
  const constantColumns = new Map<string, string | number | boolean>();
  const selectParts: string[] = [];
  const hasAggregates = Boolean(aggregate && aggregate.length > 0);
  const aggregateTargets = new Set<string>();
  const aggregateOps: string[] = [];

  if (hasAggregates) {
    for (const [op, sourceVar, targetVar] of aggregate!) {
      aggregateTargets.add(targetVar);
      aggregateOps.push(op);

      const sourceBinding = ctx.bindings.get(sourceVar);
      if (!sourceBinding) {
        throw new Error(`Unbound variable in aggregate: ${sourceVar}`);
      }

      const colName = `"${targetVar}"`;
      const numericCol = resolveBinding(sourceBinding, { valueMode: "number" });

      let aggExpr: string;
      switch (op) {
        case "count":
          aggExpr = `COUNT(DISTINCT ${distinctCountExpression(sourceBinding)})`;
          break;
        case "sum":
          aggExpr = `SUM(${numericCol})`;
          break;
        case "avg":
          aggExpr = `AVG(${numericCol})`;
          break;
        case "min":
          aggExpr = `MIN(${numericCol})`;
          break;
        case "max":
          aggExpr = `MAX(${numericCol})`;
          break;
        default:
          throw new Error(`Unknown aggregate operator: ${op}`);
      }

      ctx.aggregateExpressions.set(targetVar, aggExpr);
      selectParts.push(`${aggExpr} AS ${colName}`);
      columnMap.set(targetVar, targetVar);
      numericColumns.add(targetVar);
    }
  }

  for (const term of find) {
    if (isVariable(term)) {
      if (aggregateTargets.has(term)) continue;

      const binding = ctx.bindings.get(term);
      if (!binding) {
        const projection = optionalProjectionExpressions(term, optionalProjection, ctx);
        if (projection) {
          const colName = `"${term}"`;
          const index = valueColumnMap.size;
          const columns: CompiledValueColumns = {
            category: `_triplex_value_${index}_category`,
            orderNumber: `_triplex_value_${index}_order_number`,
            orderText: `_triplex_value_${index}_order_text`,
            type: `_triplex_value_${index}_type`,
            string: `_triplex_value_${index}_string`,
            number: `_triplex_value_${index}_number`,
            boolean: `_triplex_value_${index}_boolean`,
          };
          selectParts.push(`${projection.scalar} AS ${colName}`);
          selectParts.push(`${projection.category} AS "${columns.category}"`);
          selectParts.push(`${projection.orderNumber} AS "${columns.orderNumber}"`);
          selectParts.push(`${projection.orderText} AS "${columns.orderText}"`);
          selectParts.push(`${projection.type} AS "${columns.type}"`);
          selectParts.push(`${projection.string} AS "${columns.string}"`);
          selectParts.push(`${projection.number} AS "${columns.number}"`);
          selectParts.push(`${projection.boolean} AS "${columns.boolean}"`);
          columnMap.set(term, term);
          valueColumnMap.set(term, columns);
        }
        continue;
      }

      const colName = `"${term}"`;
      if (isTripleValueBinding(binding)) {
        const projection = valueProjectionExpressions(binding.alias);
        const index = valueColumnMap.size;
        const columns: CompiledValueColumns = {
          category: `_triplex_value_${index}_category`,
          orderNumber: `_triplex_value_${index}_order_number`,
          orderText: `_triplex_value_${index}_order_text`,
          type: `_triplex_value_${index}_type`,
          string: `_triplex_value_${index}_string`,
          number: `_triplex_value_${index}_number`,
          boolean: `_triplex_value_${index}_boolean`,
        };
        selectParts.push(`${projection.scalar} AS ${colName}`);
        selectParts.push(`${projection.category} AS "${columns.category}"`);
        selectParts.push(`${projection.orderNumber} AS "${columns.orderNumber}"`);
        selectParts.push(`${projection.orderText} AS "${columns.orderText}"`);
        selectParts.push(`${projection.type} AS "${columns.type}"`);
        selectParts.push(`${projection.string} AS "${columns.string}"`);
        selectParts.push(`${projection.number} AS "${columns.number}"`);
        selectParts.push(`${projection.boolean} AS "${columns.boolean}"`);
        valueColumnMap.set(term, columns);
      } else {
        selectParts.push(`${getColumnExpression(binding)} AS ${colName}`);
      }
      columnMap.set(term, term);
      continue;
    }

    // Constants are allowed in `find`, including arbitrary strings. Never use
    // their value as a SQL identifier; keep it parameterized and give the
    // projected column an internal alias.
    const colName = `_constant_${selectParts.length}`;
    selectParts.push(`${formatValue(term, ctx)} AS ${colName}`);
    columnMap.set(colName, String(term));
    constantColumns.set(colName, constantScalar(term));
  }

  let groupByClause = "";
  if (hasAggregates) {
    const groupByParts: string[] = [];
    for (const term of find) {
      if (isVariable(term) && !aggregateTargets.has(term)) {
        const binding = ctx.bindings.get(term);
        if (binding) {
          if (isTripleValueBinding(binding)) {
            groupByParts.push(
              ...valueProjectionGroupExpressions(valueProjectionExpressions(binding.alias)),
            );
          } else {
            groupByParts.push(getColumnExpression(binding));
          }
        }
      }
    }
    if (groupByParts.length > 0) {
      groupByClause = `GROUP BY ${groupByParts.join(", ")}`;
    }
  }

  if (selectParts.length === 0) {
    selectParts.push(`1 AS "_dummy"`);
  }

  return {
    columnMap,
    valueColumnMap,
    numericColumns,
    constantColumns,
    selectParts,
    groupByClause,
    hasAggregates,
    aggregateOps,
  };
};

// =============================================================================
// Main Compilation
// =============================================================================

/**
 * Compile a Datalog query to SQL
 *
 * @param query - The Datalog query to compile
 * @param dialect - SQL dialect to use (defaults to SQLite)
 * @param includeMetrics - Whether to include compilation metrics (for debugging)
 */
export const compile = (
  input: DatalogQuery,
  dialect: SqlDialect = SqliteDialect,
  includeMetrics = false,
  options: CompileOptions = {},
): CompiledQuery => {
  const query = assertDatalogQuery(input);
  const startTime = includeMetrics ? performance.now() : 0;
  const ctx = createContext(dialect);
  const { find, where, aggregate, having, orderBy, limit, offset, optionalProjection } = query;
  const { patterns, predicates, notClauses, orClauses } = classifyClauses(where, {
    allowRuleApplications: false,
  });

  if (patterns.length === 0) {
    throw new Error("Datalog query must have at least one pattern clause");
  }

  // Compile patterns first (establishes bindings)
  patterns.forEach((pattern, idx) => {
    const alias = compilePattern(pattern, ctx, idx === 0);
    ctx.patternAliases.set(idx, alias);
  });

  // Compile predicates (uses bindings)
  for (const predicate of predicates) {
    compilePredicate(predicate, ctx);
  }

  // Compile NOT clauses
  for (const notClause of notClauses) {
    compileNot(notClause, ctx);
  }

  // Compile OR clauses
  for (const orClause of orClauses) {
    compileOr(orClause, ctx);
  }

  const {
    columnMap,
    valueColumnMap,
    numericColumns,
    constantColumns,
    selectParts,
    groupByClause,
    hasAggregates,
    aggregateOps,
  } = buildSelectAndGroupBy(find, aggregate, optionalProjection, ctx);

  // Build HAVING, ORDER BY, LIMIT clauses
  const havingClause = buildHavingClause(having, ctx);
  const orderByClause = buildOrderByClause(orderBy, valueColumnMap);
  const limitClause = buildLimitClause(limit, offset, dialect);

  // Build final SQL
  const fromTable = `triples t0`;
  const joinClause = ctx.joins.length > 0 ? ctx.joins.join("\n") : "";
  const whereClause = ctx.conditions.length > 0 ? `WHERE ${ctx.conditions.join(" AND ")}` : "";

  const currentSql = [
    `SELECT DISTINCT`,
    `  ${selectParts.join(",\n  ")}`,
    `FROM ${fromTable}`,
    joinClause,
    whereClause,
    groupByClause,
    havingClause,
    orderByClause,
    limitClause,
  ]
    .filter(Boolean)
    .join("\n");
  const sql = applyTemporalBasis(currentSql, options.basis);

  const result: CompiledQuery = {
    sql,
    params: [...ctx.collector.params],
    columnMap,
    valueColumnMap,
    numericColumns,
    constantColumns,
  };

  if (includeMetrics) {
    result.metrics = {
      joinCount: ctx.joins.length,
      whereConditionCount: ctx.conditions.length,
      subqueryCount: notClauses.length,
      cteCount: 0, // Will be set in compileWithRules
      sqlLength: sql.length,
      paramCount: ctx.collector.params.length,

      patternCount: patterns.length,
      predicateCount: predicates.length,
      notClauseCount: notClauses.length,
      orClauseCount: orClauses.length,

      hasAggregation: Boolean(hasAggregates),
      isRecursive: false, // Will be set in compileWithRules
      aggregateOps,

      compilationTimeMs: performance.now() - startTime,
    };
  }

  return result;
};

/**
 * Compile and return just the SQL string (convenience function)
 */
export const compileToSql = (query: DatalogQuery, dialect: SqlDialect = SqliteDialect): string => {
  return compile(query, dialect).sql;
};

// =============================================================================
// Recursive Query Compilation
// =============================================================================

/**
 * Group rules by name for generating CTEs
 * Multiple rules with the same name are combined with UNION (like OR semantics)
 */
const groupRulesByName = (rules: readonly Rule[]): Map<string, Rule[]> => {
  const grouped = new Map<string, Rule[]>();
  for (const rule of rules) {
    const existing = grouped.get(rule.name) ?? [];
    existing.push(rule);
    grouped.set(rule.name, existing);
  }
  return grouped;
};

/**
 * Compile a single rule definition to SQL for a CTE
 * Returns SQL that selects (arg1, arg2) based on the rule body
 */
const compileRuleDefinition = (rule: Rule, ctx: CompilerContext): string => {
  const { body } = rule;

  if (body.length === 0) {
    throw new Error(`Rule "${rule.name}" has no body clauses`);
  }

  // Find the variables that map to arg1 and arg2
  // We infer from the first pattern's entity/value positions
  // Convention: arg1 = first entity, arg2 = last value in chain
  let arg1Var: string | null = null;
  let arg2Var: string | null = null;

  // Scan body to identify arg1 and arg2 variables
  // For patterns like [?x, :parent, ?y], ?x is arg1, ?y is arg2
  for (const clause of body) {
    if (!isRuleApplication(clause)) {
      const [entity, , value] = clause as PatternClause;
      if (isVariable(entity) && !arg1Var) {
        arg1Var = entity;
      }
      if (isVariable(value)) {
        arg2Var = value;
      }
    }
  }

  if (!arg1Var || !arg2Var) {
    throw new Error(`Rule "${rule.name}" must have variables for both arg1 and arg2`);
  }

  // Build the SQL query for this rule definition
  const paramMap = new Map<string, string>();
  const aliasCounter = { value: 0 };
  const fromParts: string[] = [];
  const allConditions: string[] = [];
  const allJoins: string[] = [];
  const bindRuleVariable = (variable: string, expression: string, conditions: string[]): void => {
    const existing = paramMap.get(variable);
    if (existing === undefined) {
      paramMap.set(variable, expression);
    } else {
      conditions.push(`${expression} = ${existing}`);
    }
  };

  // Process each clause in the body
  for (let i = 0; i < body.length; i++) {
    const clause = body[i]!;
    const alias = `t${i}`;

    if (isRuleApplication(clause)) {
      // Handle recursive rule application
      const [ruleName, clauseArg1, clauseArg2] = clause;

      // Add JOIN to the recursive CTE
      if (fromParts.length === 0) {
        fromParts.push(`${ruleIdentifier(ruleName)} r0`);
        aliasCounter.value++;

        // Map the rule application arguments
        if (isVariable(clauseArg1)) {
          bindRuleVariable(clauseArg1, "r0.arg1", allConditions);
        }
        if (isVariable(clauseArg2)) {
          bindRuleVariable(clauseArg2, "r0.arg2", allConditions);
        }
      } else {
        // Join condition - link to previously bound variables
        const joinConditions: string[] = [];

        if (isVariable(clauseArg1)) {
          bindRuleVariable(clauseArg1, `r${aliasCounter.value}.arg1`, joinConditions);
        } else {
          joinConditions.push(`r${aliasCounter.value}.arg1 = ${formatValue(clauseArg1, ctx)}`);
        }

        if (isVariable(clauseArg2)) {
          bindRuleVariable(clauseArg2, `r${aliasCounter.value}.arg2`, joinConditions);
        } else {
          joinConditions.push(`r${aliasCounter.value}.arg2 = ${formatValue(clauseArg2, ctx)}`);
        }

        allJoins.push(
          `JOIN ${ruleIdentifier(ruleName)} r${aliasCounter.value} ON ${joinConditions.join(" AND ")}`,
        );
        aliasCounter.value++;
      }
    } else {
      // Pattern clause
      const [entity, attribute, value] = clause as PatternClause;

      if (fromParts.length === 0) {
        fromParts.push(`triples ${alias}`);
        allConditions.push(`${alias}.retracted_at IS NULL`);

        // Handle entity
        if (isVariable(entity)) {
          bindRuleVariable(entity, `${alias}.entity_id`, allConditions);
        } else {
          allConditions.push(`${alias}.entity_id = ${formatValue(entity, ctx)}`);
        }

        // Handle attribute
        if (isVariable(attribute)) {
          bindRuleVariable(attribute, `${alias}.attribute`, allConditions);
        } else {
          allConditions.push(`${alias}.attribute = ${formatValue(attribute, ctx)}`);
        }

        // Handle value
        if (isVariable(value)) {
          allConditions.push(textScalarTypeCondition(alias));
          bindRuleVariable(value, textScalarExpression(alias), allConditions);
        } else {
          allConditions.push(compilePatternValueCondition(alias, value, ctx));
        }
      } else {
        // JOIN to the triples table
        const joinConditions: string[] = [`${alias}.retracted_at IS NULL`];

        // Handle entity - check if it should join to a previous binding
        if (isVariable(entity)) {
          bindRuleVariable(entity, `${alias}.entity_id`, joinConditions);
        } else {
          joinConditions.push(`${alias}.entity_id = ${formatValue(entity, ctx)}`);
        }

        // Handle attribute
        if (isVariable(attribute)) {
          bindRuleVariable(attribute, `${alias}.attribute`, joinConditions);
        } else {
          joinConditions.push(`${alias}.attribute = ${formatValue(attribute, ctx)}`);
        }

        // Handle value
        if (isVariable(value)) {
          joinConditions.push(textScalarTypeCondition(alias));
          bindRuleVariable(value, textScalarExpression(alias), joinConditions);
        } else {
          joinConditions.push(compilePatternValueCondition(alias, value, ctx));
        }

        allJoins.push(`JOIN triples ${alias} ON ${joinConditions.join(" AND ")}`);
      }
    }
  }

  // Build SELECT with arg1 and arg2
  const arg1Col = paramMap.get(arg1Var) ?? "NULL";
  const arg2Col = paramMap.get(arg2Var) ?? "NULL";

  const selectClause = `SELECT DISTINCT ${arg1Col} AS arg1, ${arg2Col} AS arg2`;
  const fromClause = `FROM ${fromParts[0]}`;
  const joinClause = allJoins.length > 0 ? allJoins.join("\n") : "";
  const whereClause = allConditions.length > 0 ? `WHERE ${allConditions.join(" AND ")}` : "";

  return [selectClause, fromClause, joinClause, whereClause].filter(Boolean).join("\n");
};

/**
 * Compile a recursive CTE for a rule
 * Combines base case and recursive case with UNION
 *
 * For ancestor rules like:
 *   ancestor(X, Y) :- X :parent Y.          (base case)
 *   ancestor(X, Y) :- X :parent Z, ancestor(Z, Y).  (recursive case)
 *
 * The CTE structure is:
 *   WITH RECURSIVE ancestor(arg1, arg2, depth) AS (
 *     -- Base: direct parent relationship
 *     SELECT entity_id, COALESCE(value_string, value_json), 0 FROM triples
 *     WHERE attribute = ':parent' AND value_type IN ('string', 'ref', 'blob', 'json')
 *     UNION ALL
 *     -- Recursive: extend through another parent edge
 *     SELECT t.entity_id, a.arg2, a.depth + 1
 *     FROM triples t
 *     JOIN ancestor a ON COALESCE(t.value_string, t.value_json) = a.arg1
 *     WHERE t.attribute = ':parent' AND a.depth < maxDepth
 *   )
 */
const compileRecursiveCTE = (ruleName: string, rules: Rule[], ctx: CompilerContext): string => {
  // Separate base cases (no recursive calls) from recursive cases
  const baseCases: Rule[] = [];
  const recursiveCases: Rule[] = [];

  for (const rule of rules) {
    const hasRecursion = rule.body.some(
      (clause) => isRuleApplication(clause) && clause[0] === ruleName,
    );
    if (hasRecursion) {
      recursiveCases.push(rule);
    } else {
      baseCases.push(rule);
    }
  }

  if (baseCases.length === 0) {
    throw new Error(`Rule "${ruleName}" has no base case (non-recursive definition)`);
  }

  for (const rule of rules) {
    if (
      rule.maxDepth !== undefined &&
      (!Number.isSafeInteger(rule.maxDepth) || rule.maxDepth < 1)
    ) {
      throw new Error(`Rule "${ruleName}" maxDepth must be a positive safe integer`);
    }
  }

  // Get max depth from any rule (default 100)
  const maxDepth = Math.max(...rules.map((r) => r.maxDepth ?? 100));

  // Build base case SQL (UNION ALL of all base cases)
  const baseSqls = baseCases.map((rule) => compileRuleDefinition(rule, ctx));
  const baseUnion = baseSqls.join("\nUNION ALL\n");

  // Build recursive case SQL
  if (recursiveCases.length === 0) {
    // Non-recursive rule - just use base case
    return `${ruleIdentifier(ruleName)} AS (\n${baseUnion}\n)`;
  }

  // For recursive rules, we need to build a proper SQLite-compatible recursive CTE
  // SQLite requires the recursive reference to be a simple join, not in a subquery

  // Compile the recursive member directly (pattern + join to CTE)
  // The typical recursive rule is: [pattern, rule_application]
  // e.g., ancestor(X,Y) :- X :parent Z, ancestor(Z,Y)
  // This means: find X's parent Z, then find Z's ancestors Y
  const recursiveMembers: string[] = [];

  for (const rule of recursiveCases) {
    // Find the pattern clause and recursive application
    const patternClauses = rule.body.filter((c) => !isRuleApplication(c)) as PatternClause[];
    const ruleApps = rule.body.filter((c) => isRuleApplication(c)) as RuleApplication[];

    if (patternClauses.length === 0 || ruleApps.length === 0) {
      throw new Error(`Recursive rule "${ruleName}" must have both pattern and recursive call`);
    }

    // For now, handle the simple case: one pattern + one recursive call
    const pattern = patternClauses[0]!;
    const [, ruleArg1] = ruleApps[0]!;
    const [entity, attribute, value] = pattern;

    // Build the recursive SELECT
    // SELECT t.entity_id AS arg1, r.arg2 AS arg2, r.depth + 1 AS depth
    // FROM triples t JOIN ruleName r ON join_condition
    // WHERE t.attribute = ':attr' AND t.retracted_at IS NULL AND r.depth < maxDepth

    const conditions: string[] = [
      `t.retracted_at IS NULL`,
      textScalarTypeCondition("t"),
      `r.depth < ${ctx.collector.add(maxDepth)}`,
    ];

    // Handle attribute
    if (!isVariable(attribute)) {
      conditions.push(`t.attribute = ${formatValue(attribute, ctx)}`);
    }

    // Handle value - this is usually the link to the recursive call
    // e.g., in [?x, :parent, ?z] followed by [ancestor, ?z, ?y]
    // value (?z) links to the rule application's first arg

    // Determine the join condition based on how variables are linked
    let joinCondition = "1=1";
    if (isVariable(value) && isVariable(ruleArg1) && value === ruleArg1) {
      // The pattern's value links to the rule's arg1
      // SELECT entity_id, r.arg2 FROM triples t JOIN rule r ON the flattened text identity
      joinCondition = `${textScalarExpression("t")} = r.arg1`;
    } else if (isVariable(entity) && isVariable(ruleArg1) && entity === ruleArg1) {
      // The pattern's entity links to the rule's arg1
      joinCondition = "t.entity_id = r.arg1";
    }

    // Determine what to select for arg1 and arg2
    const selectArg1 = "t.entity_id";
    const selectArg2 = "r.arg2";

    // If the pattern entity is the first variable and value is linked to rule arg1
    // then entity -> arg1, rule.arg2 -> arg2
    // This gives us: for each X, find its parent Z, get ancestor of Z which is Y
    // Result: (X, Y) = (entity_id, r.arg2)

    const recursiveSql = `SELECT ${selectArg1} AS arg1, ${selectArg2} AS arg2, r.depth + 1 AS depth
FROM triples t
JOIN ${ruleIdentifier(ruleName)} r ON ${joinCondition}
WHERE ${conditions.join(" AND ")}`;

    recursiveMembers.push(recursiveSql);
  }

  // SQLite recursive CTE format
  return `${ruleIdentifier(ruleName)}(arg1, arg2, depth) AS (
  -- Base case
  SELECT arg1, arg2, 0 AS depth FROM (
    ${baseUnion.split("\n").join("\n    ")}
  )
  UNION ALL
  -- Recursive case
  ${recursiveMembers.join("\n  UNION ALL\n  ")}
)`;
};

/**
 * Compile a rule application in the main query's WHERE clause
 */
interface CompiledRuleApplication {
  readonly ruleName: string;
  readonly alias: string;
  readonly joinCondition: string;
}

const resolveRuleIdentityBinding = (
  binding: VariableBinding,
): { readonly expression: string; readonly condition?: string } =>
  isTripleValueBinding(binding)
    ? {
        expression: textScalarExpression(binding.alias),
        condition: textScalarTypeCondition(binding.alias),
      }
    : { expression: resolveBinding(binding) };

const compileRuleApplicationInWhere = (
  ruleApp: RuleApplication,
  ctx: CompilerContext,
): CompiledRuleApplication => {
  const [ruleName, arg1, arg2] = ruleApp;
  const ruleAlias = `rule_ref_${ctx.aliasCounter++}`;

  // Build join conditions
  const joinConditions: string[] = [];

  // Handle arg1
  if (isVariable(arg1)) {
    const binding = ctx.bindings.get(arg1);
    if (binding) {
      const resolved = resolveRuleIdentityBinding(binding);
      if (resolved.condition) joinConditions.push(resolved.condition);
      joinConditions.push(`${ruleAlias}.arg1 = ${resolved.expression}`);
    } else {
      // New variable - we'll bind it from the rule result
      ctx.bindings.set(arg1, ruleBinding(ruleAlias, "arg1"));
    }
  } else {
    joinConditions.push(`${ruleAlias}.arg1 = ${formatValue(arg1, ctx)}`);
  }

  // Handle arg2
  if (isVariable(arg2)) {
    const binding = ctx.bindings.get(arg2);
    if (binding) {
      const resolved = resolveRuleIdentityBinding(binding);
      if (resolved.condition) joinConditions.push(resolved.condition);
      joinConditions.push(`${ruleAlias}.arg2 = ${resolved.expression}`);
    } else {
      // New variable - bind it from rule result
      ctx.bindings.set(arg2, ruleBinding(ruleAlias, "arg2"));
    }
  } else {
    joinConditions.push(`${ruleAlias}.arg2 = ${formatValue(arg2, ctx)}`);
  }

  // Add the JOIN
  const joinCondition = joinConditions.length > 0 ? joinConditions.join(" AND ") : "1=1";
  ctx.joins.push(`JOIN ${ruleIdentifier(ruleName)} ${ruleAlias} ON ${joinCondition}`);
  return { ruleName, alias: ruleAlias, joinCondition };
};

/**
 * Compile a Datalog query with recursive rules to SQL using CTEs
 */
export const compileWithRules = (
  input: DatalogQuery,
  dialect: SqlDialect = SqliteDialect,
  includeMetrics = false,
  options: CompileOptions = {},
): CompiledQuery => {
  const query = assertDatalogQuery(input);
  const { rules } = query;

  // If no rules, use the standard compiler
  if (!rules || rules.length === 0) {
    return compile(query as DatalogQuery, dialect, includeMetrics, options);
  }

  const startTime = includeMetrics ? performance.now() : 0;

  const ctx = createContext(dialect);
  const { find, where, aggregate, having, orderBy, limit, offset } = query as DatalogQuery & {
    having?: readonly HavingClause[];
    orderBy?: readonly OrderBySpec[];
    limit?: number;
    offset?: number;
  };

  // Group rules by name
  const groupedRules = groupRulesByName(rules);

  // Generate CTEs for each rule
  const ctes: string[] = [];
  for (const [ruleName, ruleList] of groupedRules) {
    ctes.push(compileRecursiveCTE(ruleName, ruleList, ctx));
  }

  const { patterns, predicates, notClauses, orClauses, ruleApplications } = classifyClauses(where, {
    allowRuleApplications: true,
  });

  if (patterns.length === 0 && ruleApplications.length === 0) {
    throw new Error("Datalog query must have at least one pattern clause or rule application");
  }

  // Compile patterns first (establishes bindings)
  patterns.forEach((pattern, idx) => {
    const alias = compilePattern(pattern, ctx, idx === 0);
    ctx.patternAliases.set(idx, alias);
  });

  // Compile rule applications
  const compiledRuleApplications = ruleApplications.map((ruleApp) =>
    compileRuleApplicationInWhere(ruleApp, ctx),
  );

  // Compile predicates (uses bindings)
  for (const predicate of predicates) {
    compilePredicate(predicate, ctx);
  }

  // Compile NOT clauses
  for (const notClause of notClauses) {
    compileNot(notClause, ctx);
  }

  // Compile OR clauses
  for (const orClause of orClauses) {
    compileOr(orClause, ctx);
  }

  const {
    columnMap,
    valueColumnMap,
    numericColumns,
    constantColumns,
    selectParts,
    groupByClause,
    hasAggregates,
    aggregateOps,
  } = buildSelectAndGroupBy(find, aggregate, query.optionalProjection, ctx);

  // Build HAVING, ORDER BY, LIMIT clauses
  const havingClause = buildHavingClause(having, ctx);
  const orderByClause = buildOrderByClause(orderBy, valueColumnMap);
  const limitClause = buildLimitClause(limit, offset, dialect);

  // Build final SQL with CTEs
  const cteClause = ctes.length > 0 ? `WITH RECURSIVE\n${ctes.join(",\n")}\n` : "";

  // Handle case where only rule applications exist (no patterns)
  let fromTable: string;
  if (patterns.length === 0 && ruleApplications.length > 0) {
    // First rule application becomes the FROM
    const firstRule = compiledRuleApplications[0]!;
    fromTable = `${ruleIdentifier(firstRule.ruleName)} ${firstRule.alias}`;

    // Remove the first rule's JOIN since it's now in FROM
    // The JOIN conditions (including constant arguments) are already embedded in the JOIN string
    // and params were already added during compileRuleApplicationInWhere
    if (ctx.joins.length > 0) {
      ctx.joins.shift();
      if (firstRule.joinCondition !== "1=1") ctx.conditions.push(firstRule.joinCondition);
    }
  } else {
    fromTable = `triples t0`;
  }

  const joinClause = ctx.joins.length > 0 ? ctx.joins.join("\n") : "";
  const whereClause = ctx.conditions.length > 0 ? `WHERE ${ctx.conditions.join(" AND ")}` : "";

  const currentSql = [
    cteClause + `SELECT DISTINCT`,
    `  ${selectParts.join(",\n  ")}`,
    `FROM ${fromTable}`,
    joinClause,
    whereClause,
    groupByClause,
    havingClause,
    orderByClause,
    limitClause,
  ]
    .filter(Boolean)
    .join("\n");
  const sql = applyTemporalBasis(currentSql, options.basis);

  const result: CompiledQuery = {
    sql,
    params: [...ctx.collector.params],
    columnMap,
    valueColumnMap,
    numericColumns,
    constantColumns,
  };

  if (includeMetrics) {
    result.metrics = {
      joinCount: ctx.joins.length,
      whereConditionCount: ctx.conditions.length,
      subqueryCount: notClauses.length,
      cteCount: ctes.length,
      sqlLength: sql.length,
      paramCount: ctx.collector.params.length,

      patternCount: patterns.length,
      predicateCount: predicates.length,
      notClauseCount: notClauses.length,
      orClauseCount: orClauses.length,

      hasAggregation: Boolean(hasAggregates),
      isRecursive: true, // This function is only called for recursive queries
      aggregateOps,

      compilationTimeMs: performance.now() - startTime,
    };
  }

  return result;
};

/**
 * Compile a query with rules and return just the SQL string
 */
export const compileWithRulesToSql = (
  query: DatalogQuery,
  dialect: SqlDialect = SqliteDialect,
): string => {
  return compileWithRules(query, dialect).sql;
};

/** @internal Exported for testing only */
export {
  tripleBinding,
  ruleBinding,
  resolveBinding,
  isValueLikeBinding,
  parseClause,
  classifyClauses,
};
export type { VariableBinding, BindingValueMode, ClassifiedClauses };
