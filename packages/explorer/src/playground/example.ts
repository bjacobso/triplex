import type { Bundle } from "./bundle.js";

/** The playground a blank link opens: a small site-safety model with history worth inspecting. */
export const exampleBundle: Bundle = {
  version: 1,
  title: "Site safety",
  description:
    "Workers are placed at sites and need certifications that expire. Dates are relative to today, so the expiring certificate is always about to expire.",
  types: [
    {
      name: "Site",
      attributes: {
        name: { key: ":site/name", type: "text", required: true, unique: true },
        region: { key: ":site/region", type: "enum", values: ["north", "south"], required: true },
      },
    },
    {
      name: "Worker",
      attributes: {
        name: { key: ":worker/name", type: "text", required: true },
        role: {
          key: ":worker/role",
          type: "enum",
          values: ["operator", "electrician", "supervisor"],
          required: true,
        },
        rate: { key: ":worker/hourly-rate", type: "number" },
        manager: { key: ":worker/manager", type: "ref", target: "Worker" },
      },
    },
    {
      name: "Certification",
      attributes: {
        worker: { key: ":certification/worker", type: "ref", target: "Worker", required: true },
        kind: {
          key: ":certification/kind",
          type: "enum",
          values: ["first-aid", "forklift", "working-at-height"],
          required: true,
        },
        number: { key: ":certification/number", type: "text", required: true, unique: true },
      },
    },
    {
      name: "Placement",
      attributes: {
        worker: { key: ":placement/worker", type: "ref", target: "Worker", required: true },
        site: { key: ":placement/site", type: "ref", target: "Site", required: true },
        shift: { key: ":placement/shift", type: "enum", values: ["day", "night"] },
      },
    },
  ],
  seed: [
    {
      actor: "import:erp",
      at: "-400d",
      note: "Sites open",
      create: [
        { type: "Site", id: "site:harbor", values: { name: "Harbor Yard", region: "south" } },
        { type: "Site", id: "site:ridge", values: { name: "Ridge Plant", region: "north" } },
      ],
    },
    {
      actor: "import:hris",
      at: "-300d",
      note: "Workers hired",
      create: [
        {
          type: "Worker",
          id: "worker:ines",
          values: { name: "Ines Okafor", role: "supervisor", rate: 48 },
        },
        {
          type: "Worker",
          id: "worker:maria",
          values: { name: "Maria Chen", role: "operator", rate: 31, manager: "worker:ines" },
        },
        {
          type: "Worker",
          id: "worker:tomas",
          values: { name: "Tomas Reyes", role: "electrician", rate: 39, manager: "worker:ines" },
          validFrom: "-120d",
        },
      ],
    },
    {
      actor: "sync:lms",
      note: "Certificates are valid from issue to expiry",
      create: [
        {
          type: "Certification",
          id: "cert:maria-forklift",
          values: { worker: "worker:maria", kind: "forklift", number: "FL-2201" },
          validFrom: "-290d",
          validTo: "+14d",
        },
        {
          type: "Certification",
          id: "cert:maria-first-aid",
          values: { worker: "worker:maria", kind: "first-aid", number: "FA-1180" },
          validFrom: "-295d",
          validTo: "-20d",
        },
        {
          type: "Certification",
          id: "cert:ines-height",
          values: { worker: "worker:ines", kind: "working-at-height", number: "WH-0042" },
          validFrom: "-280d",
        },
      ],
    },
    {
      actor: "user:dana",
      at: "-110d",
      note: "Placements",
      create: [
        {
          type: "Placement",
          id: "placement:maria-harbor",
          values: { worker: "worker:maria", site: "site:harbor", shift: "day" },
        },
        {
          type: "Placement",
          id: "placement:tomas-harbor",
          values: { worker: "worker:tomas", site: "site:harbor", shift: "night" },
        },
        {
          type: "Placement",
          id: "placement:ines-ridge",
          values: { worker: "worker:ines", site: "site:ridge" },
        },
      ],
    },
    {
      actor: "sync:payroll",
      at: "-30d",
      note: "A raise from a date on keeps the earlier rate true for the past",
      update: [{ type: "Worker", id: "worker:maria", values: { rate: 33.5 } }],
    },
  ],
  queries: [
    {
      name: "Placed without a forklift certificate",
      description: "Negation: placements whose worker has no forklift certificate at this basis.",
      query: {
        find: ["?worker", "?name", "?site"],
        where: [
          ["?placement", ":placement/worker", "?worker"],
          ["?placement", ":placement/site", "?s"],
          ["?s", ":site/name", "?site"],
          ["?worker", ":worker/name", "?name"],
          [
            "not",
            ["?c", ":certification/worker", "?worker"],
            ["?c", ":certification/kind", "forklift"],
          ],
        ],
      },
    },
    {
      name: "Headcount by site",
      description: "Aggregation, grouped by the other projected variables.",
      query: {
        find: ["?site", "?workers"],
        where: [
          ["?placement", ":placement/site", "?s"],
          ["?placement", ":placement/worker", "?worker"],
          ["?s", ":site/name", "?site"],
        ],
        aggregate: [["count", "?worker", "?workers"]],
        orderBy: [{ variable: "?workers", direction: "desc" }],
      },
    },
    {
      name: "Who set each hourly rate",
      description:
        "Joins each fact to the transaction that asserted it. A raise re-asserts the earlier rate for the past, so payroll owns both.",
      query: {
        find: ["?name", "?rate", "?actor"],
        where: [
          ["?worker", ":worker/name", "?name"],
          ["?worker", ":worker/hourly-rate", "?rate", "?tx"],
          ["?tx", ":_tx/actor", "?actor"],
        ],
        orderBy: [{ variable: "?name" }],
      },
    },
  ],
};
