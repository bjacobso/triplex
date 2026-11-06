/**
 * Vendor risk review — schema.
 * Source: the trial brief (synthetic; illustrative, not compliance advice).
 *
 * Modeling decisions (each is a guess an outside author had to make; see REPORT.md):
 * - Expiry is business (valid) time: a review is asserted with validFrom=completedAt,
 *   validTo=completedAt+12 months; an exception with validTo=approvedAt+6 months.
 *   (docs/agents.md: "Store a date attribute when the date says when the fact holds" is an anti-pattern.)
 * - Dates that are *values* use `Attribute.instant` (epoch ms) because `Attribute.date` is typed
 *   as a string and Datalog ordered predicates are numeric-only (docs/datalog.md).
 */
import { Attribute, EntityType } from "@triplex-build/triplex/config";

export const DAY = 86_400_000;
export const addMonths = (t: number, months: number) => {
  const d = new Date(t);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.getTime();
};

// People ------------------------------------------------------------------
export const Person = EntityType.make("Person", {
  attributes: {
    name: Attribute.use(Attribute.text(":person/name"), { required: true }),
    role: Attribute.use(Attribute.enumOf(":person/role", ["ciso", "security-analyst", "procurement"]), {
      required: true,
    }),
  },
});

// Vendors -----------------------------------------------------------------
export const Vendor = EntityType.make("Vendor", {
  attributes: {
    name: Attribute.use(Attribute.text(":vendor/name"), { required: true, unique: true }),
    // Brief: "Every vendor that touches customer data needs a security review"
    touchesCustomerData: Attribute.use(Attribute.boolean(":vendor/touches-customer-data"), { required: true }),
    // Brief: "High-risk vendors (those processing customer personal data)"
    processesPersonalData: Attribute.use(Attribute.boolean(":vendor/processes-personal-data"), {
      required: true,
    }),
    status: Attribute.use(Attribute.enumOf(":vendor/status", ["prospect", "active", "offboarded"]), {
      required: true,
    }),
  },
});

// Reviews (one per review cycle). Valid interval = [completedAt, completedAt + 12 months).
export const Review = EntityType.make("Review", {
  attributes: {
    vendor: Attribute.use(Attribute.ref(":review/vendor", Vendor), { required: true }),
    questionnaireComplete: Attribute.use(Attribute.boolean(":review/questionnaire-complete"), {}),
    reviewer: Attribute.use(Attribute.ref(":review/reviewer", Person), {}),
  },
});

// Evidence: SOC 2 Type II reports and DPAs. Valid interval = period the document is current.
export const Evidence = EntityType.make("Evidence", {
  attributes: {
    vendor: Attribute.use(Attribute.ref(":evidence/vendor", Vendor), { required: true }),
    kind: Attribute.use(Attribute.enumOf(":evidence/kind", ["soc2-type2", "dpa"]), { required: true }),
  },
});

// Exceptions: approved only by the CISO, must give a reason, expire after 6 months.
export const Exception = EntityType.make("Exception", {
  attributes: {
    vendor: Attribute.use(Attribute.ref(":exception/vendor", Vendor), { required: true }),
    approvedBy: Attribute.use(Attribute.ref(":exception/approved-by", Person), { required: true }),
    reason: Attribute.use(Attribute.text(":exception/reason"), { required: true }),
  },
});

export const AllTypes = [Person, Vendor, Review, Evidence, Exception] as const;

export const K = {
  personRole: Person.attributes.role.key,
  vendorName: Vendor.attributes.name.key,
  touches: Vendor.attributes.touchesCustomerData.key,
  personal: Vendor.attributes.processesPersonalData.key,
  status: Vendor.attributes.status.key,
  reviewVendor: Review.attributes.vendor.key,
  questionnaire: Review.attributes.questionnaireComplete.key,
  evidenceVendor: Evidence.attributes.vendor.key,
  evidenceKind: Evidence.attributes.kind.key,
  exceptionVendor: Exception.attributes.vendor.key,
  exceptionApprover: Exception.attributes.approvedBy.key,
  exceptionReason: Exception.attributes.reason.key,
} as const;
