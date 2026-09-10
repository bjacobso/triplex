/**
 * The domain: an example onboarding configuration graph.
 *
 * This file is written from the perspective of someone modelling the product -
 * attributes, forms, pages, fields, policies, automations - and it is
 * deliberately free of hashes, stores and releases. Nothing here mentions a
 * content id, because a person declaring what an I-9 form is should not have to
 * know how it is addressed.
 *
 * It was extracted from the scenario test, where it made up 327 of 750 lines.
 * That ratio was the tell: three different authors were sharing one file. The
 * framework author (`CanonicalJson`, `ContentId`, `ConfigNode`, `TypeExpr`,
 * `TypeSubsumption`) cares about determinism and soundness. The vocabulary author
 * (`Entity`, `InMemoryConfigStore`) cares about whether kinds, refs and revisions
 * compose. The domain modeller - this file - cares about none of that, and
 * their tests should read like product questions.
 */

/**
 * End-to-end scenario: a realistic account configuration walked through five
 * releases, versioned as one graph, with its history verified at each step.
 *
 * No database and no browser - "end to end" here means every layer of this
 * package at once: `TypeExpr` values define the shapes, projectors turn them into
 * merkle nodes, the store records revisions and snapshots, and refs deploy and
 * roll back. It is meant to be read top to bottom as the argument for the
 * design, so each release is named for the question it answers.
 *
 * The config is small but has the shape of the real thing, including the cycle:
 * form `i9` scopes automation `i9-reverify`, and that automation's action
 * creates a task from form `i9`.
 *
 *   attribute employee.ssn ─┐
 *   attribute employee.start_date ─┼──< form i9 >──┬── policy new-hire
 *   attribute employee.work_state ─┘       ▲       │
 *                                          └───────┴── automation i9-reverify
 */

import { Effect } from "effect";

import {
  BoolExpr as B,
  Catalog,
  Entity,
  InMemoryConfigStore,
  TypeExpr as T,
  World,
} from "@triplex-build/triplex/config";

// ---------------------------------------------------------------------------
// The graph of schemas. One per node kind; this is the whole type system the
// config is allowed to express, and each shape content-addresses itself.
// ---------------------------------------------------------------------------

export const AttributeAttrs = T.struct({
  entityType: T.required(T.enumOf(["employee", "employer"])),
  path: T.required(T.text),
  label: T.required(T.text),
  scalarType: T.required(T.enumOf(["text", "date", "enum", "number"])),
  enumOptions: T.optional(T.list(T.text)),
  sensitive: T.optional(T.boolean, false),
});

export const FieldAttrs = T.struct({
  path: T.required(T.text),
  type: T.required(T.enumOf(["text", "date", "select", "ssn"])),
  label: T.required(T.text),
  required: T.optional(T.boolean, true),
});

/** Release 4 widens this shape without touching any data. */
export const FieldAttrsV2 = T.struct({
  path: T.required(T.text),
  type: T.required(T.enumOf(["text", "date", "select", "ssn"])),
  label: T.required(T.text),
  required: T.optional(T.boolean, true),
  helpText: T.optional(T.text),
});

export const PageAttrs = T.struct({
  slug: T.required(T.text),
  title: T.required(T.text),
  assignee: T.required(T.enumOf(["employee", "employer"])),
});

export const FormAttrs = T.struct({
  slug: T.required(T.text),
  name: T.required(T.text),
  description: T.optional(T.text),
});

export const PolicyAttrs = T.struct({
  slug: T.required(T.text),
  name: T.required(T.text),
  status: T.required(T.enumOf(["enabled", "disabled"])),
});

export const AutomationAttrs = T.struct({
  slug: T.required(T.text),
  name: T.required(T.text),
  triggerEntity: T.required(T.enumOf(["task", "placement", "employee"])),
});

export const ActionAttrs = T.struct({
  slug: T.required(T.text),
  name: T.required(T.text),
  actionType: T.required(T.enumOf(["create_task", "send_email"])),
});

// ---------------------------------------------------------------------------
// The entities. Each declares its kind once, derives its own key, and names its
// relations - `children` for what nests and hashes into it, `ref` for what it
// merely depends on. Targets are thunks because the graph genuinely cycles.
// ---------------------------------------------------------------------------

// The static shapes authors write. `TypeExpr` above is the runtime truth and
// validates on the way in; these are the compiler's view of the same thing.
// Declaring them beats inferring from a Schema: measured at 300 declarations,
// inference through `Schema.Schema<A, I>` cost 5x what an explicit type does.
export interface AttributeInput {
  readonly entityType: "employee" | "employer";
  readonly path: string;
  readonly label: string;
  readonly scalarType: "text" | "date" | "enum" | "number";
  readonly enumOptions?: ReadonlyArray<string>;
  readonly sensitive?: boolean;
}
export interface FieldInput {
  readonly path: string;
  readonly type: "text" | "date" | "select" | "ssn";
  readonly label: string;
  readonly required?: boolean;
  readonly helpText?: string;
}
export interface PageInput {
  readonly slug: string;
  readonly title: string;
  readonly assignee: "employee" | "employer";
}
export interface FormInput {
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
}
export interface PolicyInput {
  readonly slug: string;
  readonly name: string;
  readonly status: "enabled" | "disabled";
}
export interface AutomationInput {
  readonly slug: string;
  readonly name: string;
  readonly triggerEntity: "task" | "placement" | "employee";
}
export interface ActionInput {
  readonly slug: string;
  readonly name: string;
  readonly actionType: "create_task" | "send_email";
}

const AttributeKind = Entity.kind("attribute");
export const FormKind = Entity.kind("form");
export const PageKind = Entity.kind("form.page");
export const FieldKind = Entity.kind("form.field");
export const PolicyKind = Entity.kind("policy");
export const AutomationKind = Entity.kind("automation");
export const ActionKind = Entity.kind("automation.action");

export const Attribute = Entity.make({
  kind: AttributeKind,
  attrs: AttributeAttrs,
  key: (a: AttributeInput) => `${a.entityType}.${a.path}`,
});

export const FormField = Entity.make({
  kind: FieldKind,
  attrs: FieldAttrs,
  key: (a: FieldInput) => a.path,
  refs: { uses_attribute: Entity.ref(AttributeKind) },
});

export const Page = Entity.make({
  kind: PageKind,
  attrs: PageAttrs,
  key: (a: PageInput) => a.slug,
  children: { field: Entity.children(FieldKind) },
});

export const Form = Entity.make({
  kind: FormKind,
  attrs: FormAttrs,
  key: (a: FormInput) => a.slug,
  children: { page: Entity.children(PageKind) },
  refs: { scopes: Entity.ref(AutomationKind) },
});

export const Policy = Entity.make({
  kind: PolicyKind,
  attrs: PolicyAttrs,
  key: (a: PolicyInput) => a.slug,
  refs: { distributes: Entity.ref(FormKind) },
});

export const Action = Entity.make({
  kind: ActionKind,
  attrs: ActionAttrs,
  key: (a: ActionInput) => a.slug,
  refs: { creates_task: Entity.ref(FormKind) },
});

export const Automation = Entity.make({
  kind: AutomationKind,
  attrs: AutomationAttrs,
  key: (a: AutomationInput) => a.slug,
  children: { action: Entity.children(ActionKind) },
  refs: { uses_attribute: Entity.ref(AttributeKind) },
});

// ---------------------------------------------------------------------------
// The account's configuration, parameterised by the things releases change.
// ---------------------------------------------------------------------------

export interface AccountConfig {
  readonly ssnLabel: string;
  readonly workStates: ReadonlyArray<string>;
  readonly fieldSchema: T.TypeExpr;
  /**
   * Whether an I-9 is required of everyone or only of caregivers. The one
   * knob a compliance edit actually turns, and the reason the rules live in
   * the snapshot rather than in code.
   */
  readonly i9AppliesTo: "caregivers" | "everyone";
}

export const BASELINE: AccountConfig = {
  ssnLabel: "SSN",
  workStates: ["CA", "NY", "TX"],
  fieldSchema: FieldAttrs,
  i9AppliesTo: "caregivers",
};

// ---------------------------------------------------------------------------
// The compliance rules.
//
// These are what the forms and policies above are *for*, and they are config
// like everything else: `Catalog.ruleNode` makes each one a `ConfigNode`, so a
// rule is versioned, diffed, deployed and pinned by the same machinery as a
// form. A decision made under one release therefore names the rule revision
// that produced it, and cannot be re-explained under a later one.
//
// They read facts by the same `entity/attribute` keys the attribute
// declarations above define - `employee.ssn` the attribute is `ee/ssn` the
// fact. Nothing enforces that correspondence yet; see the note in the
// lifecycle test.
// ---------------------------------------------------------------------------

const SELF = World.SUBJECT;

export const ruleSet = (config: AccountConfig): Readonly<Record<string, B.BoolExpr>> => ({
  // Who the I-9 obligation lands on. The knob.
  "i9-applies":
    config.i9AppliesTo === "everyone" ? B.exists(SELF, "role") : B.eq(SELF, "role", "caregiver"),

  // Section 1 is the employee's half: identity plus attestation.
  "i9-section-1-complete": B.all([B.exists(SELF, "ssn"), B.exists(SELF, "work_auth")]),

  // Section 2 is the employer's, and it is late once the start date passes.
  "i9-section-2-complete": B.exists(SELF, "i9_verified_at"),
  "i9-overdue": B.all([
    B.rule("i9-applies"),
    B.not(B.rule("i9-section-2-complete")),
    B.before(SELF, "start_date"),
  ]),

  // The obligation itself: required, and satisfied only when both halves are.
  "i9-satisfied": B.all([B.rule("i9-section-1-complete"), B.rule("i9-section-2-complete")]),
  "i9-required": B.all([B.rule("i9-applies"), B.not(B.rule("i9-satisfied"))]),
});

/** The rules as config nodes, ready to go into a snapshot. */
export const buildRules = (config: AccountConfig) =>
  Effect.all(Object.entries(ruleSet(config)).map(([key, expr]) => Catalog.ruleNode(key, expr)));

export const buildAccount = (config: AccountConfig) =>
  Effect.gen(function* () {
    // A widened field shape is the same entity read under a new schema, not a
    // different entity.
    const FieldOf = Entity.withType(FormField, config.fieldSchema);

    const attributes = yield* Effect.all([
      Attribute.node({
        attrs: {
          entityType: "employee",
          path: "ssn",
          label: "Social Security Number",
          scalarType: "text",
          sensitive: true,
        },
      }),
      Attribute.node({
        attrs: {
          entityType: "employee",
          path: "start_date",
          label: "Start date",
          scalarType: "date",
        },
      }),
      Attribute.node({
        attrs: {
          entityType: "employee",
          path: "work_state",
          label: "Work state",
          scalarType: "enum",
          enumOptions: config.workStates,
        },
      }),
    ]);

    // Ref keys are branded, so `Attribute.key(...)` is the only way to name an
    // attribute here - a form key would not compile.
    const i9 = yield* Form.node({
      attrs: {
        slug: "i9",
        name: "Form I-9",
        description: "Employment eligibility verification",
      },
      children: {
        page: [
          yield* Page.node({
            attrs: {
              slug: "identity",
              title: "Identity",
              assignee: "employee",
            },
            children: {
              field: [
                yield* FieldOf.node({
                  attrs: {
                    path: "employee.ssn",
                    type: "ssn",
                    label: config.ssnLabel,
                    required: true,
                  },
                  refs: {
                    uses_attribute: [Attribute.key("employee.ssn")],
                  },
                }),
              ],
            },
          }),
          yield* Page.node({
            attrs: {
              slug: "employment",
              title: "Employment",
              assignee: "employee",
            },
            children: {
              field: [
                yield* FieldOf.node({
                  attrs: {
                    path: "employee.start_date",
                    type: "date",
                    label: "Start date",
                  },
                  refs: {
                    uses_attribute: [Attribute.key("employee.start_date")],
                  },
                }),
                yield* FieldOf.node({
                  attrs: {
                    path: "employee.work_state",
                    type: "select",
                    label: "Work state",
                  },
                  refs: {
                    uses_attribute: [Attribute.key("employee.work_state")],
                  },
                }),
              ],
            },
          }),
        ],
      },
      // The form scopes its own re-verification automation, whose action
      // creates a task from this same form. The thunk targets in the entity
      // declarations are what let that cycle be written down.
      refs: { scopes: [Automation.key("i9-reverify")] },
    });

    const newHire = yield* Policy.node({
      attrs: {
        slug: "new-hire",
        name: "New hire onboarding",
        status: "enabled",
      },
      refs: { distributes: [Form.key("i9")] },
    });

    const reverify = yield* Automation.node({
      attrs: {
        slug: "i9-reverify",
        name: "I-9 reverification",
        triggerEntity: "placement",
      },
      children: {
        action: [
          yield* Action.node({
            attrs: {
              slug: "create-i9",
              name: "Create I-9",
              actionType: "create_task",
            },
            refs: { creates_task: [Form.key("i9")] },
          }),
        ],
      },
      refs: { uses_attribute: [Attribute.key("employee.start_date")] },
    });

    return [...attributes, i9, newHire, reverify];
  });

export const release = (
  store: InMemoryConfigStore.InMemoryConfigStore,
  label: string,
  config: AccountConfig,
) =>
  Effect.gen(function* () {
    const objects = yield* buildAccount(config);
    return yield* InMemoryConfigStore.commit(store, { label, objects });
  });

/**
 * A release carrying the rules as well, so one snapshot holds everything a
 * decision can depend on. This is what makes a decision reproducible: the
 * forms, the attributes and the rules that read them ship together.
 */
export const releaseWithRules = (
  store: InMemoryConfigStore.InMemoryConfigStore,
  label: string,
  config: AccountConfig,
) =>
  Effect.gen(function* () {
    const objects = [...(yield* buildAccount(config)), ...(yield* buildRules(config))];
    const result = yield* InMemoryConfigStore.commit(store, { label, objects });
    return { ...result, catalog: Catalog.fromNodes(objects) };
  });

export const changeFor = (
  changes: ReadonlyArray<InMemoryConfigStore.ObjectChange>,
  kind: string,
  key: string,
) => changes.find((c) => c.kind === kind && c.key === key);

// ---------------------------------------------------------------------------
