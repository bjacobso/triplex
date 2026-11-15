/** A workforce-safety model for the explorer's demo database: sites, workers, certifications, placements and incidents. */
import { Attribute, EntityType } from "@triplex-internal/core/config";

export const regions = ["north", "south", "east", "west"] as const;
export const roles = ["operator", "electrician", "supervisor", "welder", "inspector"] as const;
export const certificationKinds = [
  "first-aid",
  "forklift",
  "confined-space",
  "working-at-height",
  "hot-work",
] as const;
export const severities = ["low", "medium", "high"] as const;
export const incidentStatuses = ["open", "investigating", "closed"] as const;

export const Site = EntityType.make("Site", {
  name: Attribute.text(":site/name").required().unique(),
  region: Attribute.enumOf(":site/region", regions).required(),
  capacity: Attribute.integer(":site/capacity"),
  opened: Attribute.instant(":site/opened"),
});

/** References name the Worker type, so a release can carry either Worker declaration. */
const WorkerTarget = { entityType: "Worker" } as const;

export const Worker = EntityType.make("Worker", {
  name: Attribute.text(":worker/name").required(),
  email: Attribute.text(":worker/email").unique(),
  role: Attribute.enumOf(":worker/role", roles).required(),
  rate: Attribute.number(":worker/hourly-rate"),
  active: Attribute.boolean(":worker/active"),
  trainedFor: Attribute.ref(":worker/trained-for", Site).many(),
  manager: Attribute.ref(":worker/manager", WorkerTarget),
});

export const Certification = EntityType.make("Certification", {
  worker: Attribute.ref(":certification/worker", WorkerTarget).required(),
  kind: Attribute.enumOf(":certification/kind", certificationKinds).required(),
  number: Attribute.text(":certification/number").required().unique(),
  issuer: Attribute.text(":certification/issuer"),
});

export const Placement = EntityType.make("Placement", {
  worker: Attribute.ref(":placement/worker", WorkerTarget).required(),
  site: Attribute.ref(":placement/site", Site).required(),
  shift: Attribute.enumOf(":placement/shift", ["day", "night"]),
});

export const ModelV1 = { types: [Site, Worker, Certification, Placement] } as const;

/** The second release adds incidents and a worker phone number. */
export const WorkerV2 = EntityType.make("Worker", {
  name: Attribute.text(":worker/name").required(),
  email: Attribute.text(":worker/email").unique(),
  phone: Attribute.text(":worker/phone"),
  role: Attribute.enumOf(":worker/role", roles).required(),
  rate: Attribute.number(":worker/hourly-rate"),
  active: Attribute.boolean(":worker/active"),
  trainedFor: Attribute.ref(":worker/trained-for", Site).many(),
  manager: Attribute.ref(":worker/manager", WorkerTarget),
});

export const Incident = EntityType.make("Incident", {
  site: Attribute.ref(":incident/site", Site).required(),
  summary: Attribute.text(":incident/summary").required(),
  severity: Attribute.enumOf(":incident/severity", severities).required(),
  status: Attribute.enumOf(":incident/status", incidentStatuses).required(),
  reportedBy: Attribute.ref(":incident/reported-by", WorkerTarget),
});

export const ModelV2 = {
  types: [Site, WorkerV2, Certification, Placement, Incident],
} as const;
