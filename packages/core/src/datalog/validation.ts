import { Effect, Result, Schema } from "effect";
import { DatalogValidationError, UnboundVariableError } from "../errors/index.js";
import {
  DatalogQuery as DatalogQuerySchema,
  WrappedQuery as WrappedQuerySchema,
  isNotClause,
  isOrClause,
  isPatternClause,
  isPredicateClause,
  isRuleApplication,
  isTypedConstant,
  isVariable,
  normalizeOrAlternatives,
  type Clause,
  type DatalogQuery,
  type NotClause,
  type PatternClause,
  type PredicateClause,
  type Rule,
  type WrappedQuery,
} from "./schema.js";

export type DatalogQueryValidationError = DatalogValidationError | UnboundVariableError;

const invalid = (query: unknown, message: string, cause?: unknown): never => {
  throw new DatalogValidationError({ message, query, ...(cause === undefined ? {} : { cause }) });
};

const unbound = (variable: string, clause: unknown): never => {
  throw new UnboundVariableError({
    variable,
    clause,
    message: `Datalog variable ${variable} is not bound by a positive relation`,
  });
};

const isAndClause = (value: unknown): boolean => Array.isArray(value) && value[0] === "and";

/**
 * Explain common grouping mistakes in `not` and `or` before the generic schema
 * failure, which otherwise lists every union member that did not match.
 */
const groupingHint = (input: unknown): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const where = (input as { readonly where?: unknown }).where;
  if (!Array.isArray(where)) return undefined;
  for (const [index, clause] of where.entries()) {
    if (!Array.isArray(clause)) continue;
    const at = `where[${index}]`;
    if (isAndClause(clause)) {
      return `${at}: Datalog has no "and" clause. Top-level where clauses are already a conjunction; inside negation write ["not", clause1, clause2, ...]`;
    }
    if (clause[0] === "not" && clause.slice(1).some(isAndClause)) {
      return `${at}: write conjunctive negation as ["not", clause1, clause2, ...], not ["not", ["and", ...]]`;
    }
    if (clause[0] === "or") {
      const alternatives: readonly unknown[] =
        clause.length === 2 && Array.isArray(clause[1]) ? clause[1] : clause.slice(1);
      for (const [branch, alternative] of alternatives.entries()) {
        if (
          isAndClause(alternative) ||
          (Array.isArray(alternative) && Array.isArray(alternative[0]))
        ) {
          return `${at} alternative ${branch}: each "or" alternative must be a single pattern, predicate, or "not" clause; conjunctive alternatives are not supported. Use a conjunctive ["not", ...] alternative or one query per alternative`;
        }
      }
    }
  }
  return undefined;
};

const decodeQuery = (input: unknown): DatalogQuery => {
  const decoded = Schema.decodeUnknownResult(DatalogQuerySchema)(input);
  if (Result.isFailure(decoded)) {
    const hint = groupingHint(input);
    return invalid(
      input,
      `Invalid Datalog query shape: ${hint ?? decoded.failure.message}`,
      decoded.failure,
    );
  }
  return decoded.success;
};

const variablesInPattern = (pattern: PatternClause): readonly string[] =>
  pattern.filter(isVariable);

const requireBoundTerms = (clause: PredicateClause, bindings: ReadonlySet<string>): void => {
  for (const term of clause.slice(1)) {
    if (isVariable(term) && !bindings.has(term)) unbound(term, clause);
  }
};

const orderedPredicateOps = new Set<PredicateClause[0]>([">", ">=", "<", "<="]);

const validatePredicate = (
  clause: PredicateClause,
  bindings: ReadonlySet<string>,
  numericBindings: ReadonlySet<string>,
  query: unknown,
): void => {
  requireBoundTerms(clause, bindings);
  if (!orderedPredicateOps.has(clause[0])) return;

  for (const term of clause.slice(1)) {
    if (isVariable(term)) {
      if (!numericBindings.has(term)) {
        invalid(query, `Ordered Datalog predicate variable ${term} must be bound from a value`);
      }
      continue;
    }
    const value = isTypedConstant(term) ? term.value : term;
    if (typeof value !== "number") {
      invalid(query, "Ordered Datalog predicate constants must be numeric");
    }
  }
};

const validateAggregateEquality = (
  clause: PredicateClause,
  aggregateTargets: ReadonlySet<string>,
  numericBindings: ReadonlySet<string>,
  query: unknown,
): void => {
  if (orderedPredicateOps.has(clause[0])) return;

  const [, left, right] = clause;
  const leftIsAggregate = isVariable(left) && aggregateTargets.has(left);
  const rightIsAggregate = isVariable(right) && aggregateTargets.has(right);
  if (!leftIsAggregate && !rightIsAggregate) return;

  const requireNumeric = (term: PredicateClause[1]): void => {
    if (isVariable(term)) {
      if (!numericBindings.has(term)) {
        invalid(query, `Datalog aggregate equality operand ${term} must be numeric`);
      }
      return;
    }
    const value = isTypedConstant(term) ? term.value : term;
    if (typeof value !== "number") {
      invalid(query, "Datalog aggregate equality constants must be numeric");
    }
  };

  if (leftIsAggregate) requireNumeric(right);
  if (rightIsAggregate) requireNumeric(left);
};

const validateNot = (
  clause: NotClause,
  outerBindings: ReadonlySet<string>,
  outerNumericBindings: ReadonlySet<string>,
  query: unknown,
): void => {
  const localBindings = new Set(outerBindings);
  const localNumericBindings = new Set(outerNumericBindings);
  const inner = clause.slice(1) as readonly (PatternClause | PredicateClause)[];
  for (const candidate of inner) {
    if (isPatternClause(candidate as Clause)) {
      for (const variable of variablesInPattern(candidate as PatternClause)) {
        localBindings.add(variable);
      }
      const value = (candidate as PatternClause)[2];
      if (isVariable(value)) localNumericBindings.add(value);
    }
  }
  for (const candidate of inner) {
    if (isPredicateClause(candidate as Clause)) {
      validatePredicate(candidate as PredicateClause, localBindings, localNumericBindings, query);
    }
  }
};

const validateRules = (query: DatalogQuery): ReadonlySet<string> => {
  const definitions = new Map<string, Rule[]>();
  for (const rule of query.rules ?? []) {
    const group = definitions.get(rule.name) ?? [];
    group.push(rule);
    definitions.set(rule.name, group);
  }

  for (const [name, rules] of definitions) {
    if (rules.some((rule) => rule.body.length === 0)) {
      invalid(query, `Datalog rule ${name} must have a non-empty body`);
    }
    if (!rules.some((rule) => !rule.body.some(isRuleApplication))) {
      invalid(query, `Datalog rule ${name} must have a non-recursive base definition`);
    }
    for (const rule of rules) {
      const patterns = rule.body.filter((clause) => !isRuleApplication(clause)) as PatternClause[];
      const applications = rule.body.filter(isRuleApplication);
      if (patterns.some((pattern) => pattern.length !== 3)) {
        invalid(query, `Datalog rule ${name} cannot bind transaction ids in rule bodies`);
      }
      const firstPattern = patterns[0];
      const lastPattern = patterns.at(-1);
      if (
        firstPattern === undefined ||
        lastPattern === undefined ||
        !isVariable(firstPattern[0]) ||
        !isVariable(lastPattern[2])
      ) {
        invalid(
          query,
          `Datalog rule ${name} must derive its two outputs from the first entity and last value variables`,
        );
      }
      for (const clause of rule.body) {
        if (isRuleApplication(clause) && clause[0] !== name) {
          invalid(
            query,
            `Datalog rule ${name} calls ${clause[0]}; cross-rule composition is not supported`,
          );
        }
      }
      if (applications.length > 0) {
        const pattern = patterns[0]!;
        const application = applications[0]!;
        if (
          rule.body.length !== 2 ||
          patterns.length !== 1 ||
          applications.length !== 1 ||
          rule.body[0] !== pattern ||
          rule.body[1] !== application ||
          !isVariable(pattern[0]) ||
          !isVariable(pattern[2]) ||
          !isVariable(application[1]) ||
          !isVariable(application[2]) ||
          pattern[2] !== application[1]
        ) {
          invalid(
            query,
            `Recursive Datalog rule ${name} must be [head, attribute, next] followed by [${name}, next, tail]`,
          );
        }
      }
    }
  }

  return new Set(definitions.keys());
};

const validateSemantics = (query: DatalogQuery): void => {
  const ruleNames = validateRules(query);
  const positiveBindings = new Set<string>();
  const numericBindings = new Set<string>();
  let hasPositiveRelation = false;

  for (const clause of query.where) {
    if (isPatternClause(clause)) {
      hasPositiveRelation = true;
      for (const variable of variablesInPattern(clause)) positiveBindings.add(variable);
      if (isVariable(clause[2])) numericBindings.add(clause[2]);
    } else if (isRuleApplication(clause)) {
      hasPositiveRelation = true;
      if (!ruleNames.has(clause[0])) {
        invalid(query, `Datalog rule application ${clause[0]} has no definition`);
      }
      if (isVariable(clause[1])) positiveBindings.add(clause[1]);
      if (isVariable(clause[2])) positiveBindings.add(clause[2]);
    }
  }

  if (!hasPositiveRelation) {
    invalid(query, "Datalog query must contain a positive pattern or rule application");
  }

  for (const clause of query.where) {
    if (isPredicateClause(clause)) {
      validatePredicate(clause, positiveBindings, numericBindings, query);
    } else if (isNotClause(clause)) {
      validateNot(clause, positiveBindings, numericBindings, query);
    } else if (isOrClause(clause)) {
      const alternatives = normalizeOrAlternatives(clause);
      if (alternatives.length === 0) {
        invalid(query, "Datalog or clauses must contain at least one alternative");
      }
      for (const alternative of alternatives) {
        if (isPredicateClause(alternative as Clause)) {
          validatePredicate(
            alternative as PredicateClause,
            positiveBindings,
            numericBindings,
            query,
          );
        } else if (isNotClause(alternative as Clause)) {
          validateNot(alternative as NotClause, positiveBindings, numericBindings, query);
        }
      }
    }
  }

  const aggregateSources = new Set<string>();
  const aggregateTargets = new Set<string>();
  for (const aggregate of query.aggregate ?? []) {
    const [, source, target] = aggregate;
    if (!positiveBindings.has(source)) unbound(source, aggregate);
    if (aggregateTargets.has(target)) {
      invalid(query, `Datalog aggregate target ${target} is declared more than once`);
    }
    if (positiveBindings.has(target)) {
      invalid(query, `Datalog aggregate target ${target} shadows a positive binding`);
    }
    if (!query.find.includes(target)) {
      invalid(query, `Datalog aggregate target ${target} must appear in find`);
    }
    aggregateSources.add(source);
    aggregateTargets.add(target);
  }

  const optionalTargets = new Set<string>();
  if (query.optionalProjection) {
    const { rowBinding, fields } = query.optionalProjection;
    if (!positiveBindings.has(rowBinding)) unbound(rowBinding, query.optionalProjection);
    for (const field of fields) {
      if (optionalTargets.has(field.variable)) {
        invalid(query, `Optional projection target ${field.variable} is declared more than once`);
      }
      if (positiveBindings.has(field.variable) || aggregateTargets.has(field.variable)) {
        invalid(query, `Optional projection target ${field.variable} shadows another binding`);
      }
      if (!query.find.includes(field.variable)) {
        invalid(query, `Optional projection target ${field.variable} must appear in find`);
      }
      optionalTargets.add(field.variable);
      numericBindings.add(field.variable);
    }
  }

  const resultBindings = new Set<string>();
  for (const term of query.find) {
    if (!isVariable(term)) continue;
    if (resultBindings.has(term)) {
      invalid(query, `Datalog find variable ${term} is projected more than once`);
    }
    if (aggregateSources.has(term)) {
      invalid(query, `Datalog aggregate source ${term} cannot also appear in find`);
    }
    if (!positiveBindings.has(term) && !aggregateTargets.has(term) && !optionalTargets.has(term)) {
      unbound(term, { find: query.find });
    }
    resultBindings.add(term);
  }

  if ((query.having?.length ?? 0) > 0 && aggregateTargets.size === 0) {
    invalid(query, "Datalog having requires at least one aggregate");
  }
  const numericResults = new Set(
    [...resultBindings].filter(
      (binding) => numericBindings.has(binding) || aggregateTargets.has(binding),
    ),
  );
  for (const clause of query.having ?? []) {
    for (const term of clause.slice(1)) {
      if (isVariable(term) && optionalTargets.has(term)) {
        invalid(query, `Datalog having cannot reference optional projection target ${term}`);
      }
    }
    validatePredicate(clause, resultBindings, numericResults, query);
    validateAggregateEquality(clause, aggregateTargets, numericResults, query);
  }

  for (const order of query.orderBy ?? []) {
    if (!resultBindings.has(order.variable)) unbound(order.variable, order);
  }
};

/** Decode and validate a query before selecting a backend execution strategy. */
export const assertDatalogQuery = (input: unknown): DatalogQuery => {
  const query = decodeQuery(input);
  validateSemantics(query);
  return query;
};

/** Effect form of {@link assertDatalogQuery} for public service boundaries. */
export const validateDatalogQuery = (
  input: unknown,
): Effect.Effect<DatalogQuery, DatalogQueryValidationError> =>
  Effect.try({
    try: () => assertDatalogQuery(input),
    catch: (cause) =>
      cause instanceof DatalogValidationError || cause instanceof UnboundVariableError
        ? cause
        : new DatalogValidationError({
            message: `Datalog query validation failed: ${String(cause)}`,
            query: input,
            cause,
          }),
  });

/** Validate wrapper shape and ensure filters/order reference projected inner columns. */
export const assertWrappedQuery = (input: unknown): WrappedQuery => {
  const decoded = Schema.decodeUnknownResult(WrappedQuerySchema)(input);
  if (Result.isFailure(decoded)) {
    return invalid(
      input,
      `Invalid wrapped Datalog query shape: ${decoded.failure.message}`,
      decoded.failure,
    );
  }
  const wrapped = decoded.success;
  const inner = assertDatalogQuery(wrapped.inner);
  const projected = new Set(inner.find.filter(isVariable));
  const numericResults = new Set(inner.aggregate?.map(([, , target]) => target) ?? []);
  for (const filter of wrapped.filters ?? []) {
    if (!projected.has(filter.column)) unbound(filter.column, filter);
    const isNullCheck = filter.op === "is-null" || filter.op === "is-not-null";
    const value = isTypedConstant(filter.value) ? filter.value.value : filter.value;
    if (isNullCheck && filter.value !== undefined) {
      invalid(input, `Wrapper filter ${filter.op} must not include a value`);
    }
    if (!isNullCheck && filter.value === undefined) {
      invalid(input, `Wrapper filter ${filter.op} requires a value`);
    }
    if (
      (filter.op === "like" ||
        filter.op === "not-like" ||
        filter.op === "ilike" ||
        filter.op === "not-ilike") &&
      typeof value !== "string"
    ) {
      invalid(input, `Wrapper filter ${filter.op} requires a string value`);
    }
    if (
      (filter.op === ">" || filter.op === ">=" || filter.op === "<" || filter.op === "<=") &&
      typeof value !== "number" &&
      typeof value !== "string"
    ) {
      invalid(input, `Wrapper filter ${filter.op} requires a number or string value`);
    }
    if (numericResults.has(filter.column) && !isNullCheck && typeof value !== "number") {
      invalid(input, `Wrapper filter on aggregate ${filter.column} requires a numeric value`);
    }
  }
  for (const order of wrapped.orderBy ?? []) {
    if (!projected.has(order.variable)) unbound(order.variable, order);
  }
  return { ...wrapped, inner };
};

export const validateWrappedQuery = (
  input: unknown,
): Effect.Effect<WrappedQuery, DatalogQueryValidationError> =>
  Effect.try({
    try: () => assertWrappedQuery(input),
    catch: (cause) =>
      cause instanceof DatalogValidationError || cause instanceof UnboundVariableError
        ? cause
        : new DatalogValidationError({
            message: `Wrapped Datalog query validation failed: ${String(cause)}`,
            query: input,
            cause,
          }),
  });
