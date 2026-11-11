// Exact DTO fixtures from docs/rfcs/why.md; generated fact/transaction IDs are substituted by the case.
export const attributeFixture = {
  version: 1,
  subject: {
    kind: "attribute",
    entityId: "placement:maria-harbor",
    attribute: ":placement/site",
  },
  basis: {
    recordedPosition: 6,
    validAt: 1772496000000,
  },
  facts: [
    {
      tripleId: "01M762QPRVRMSBZ3AHBY7F7E3F",
      entityId: "placement:maria-harbor",
      entityType: "Placement",
      attribute: ":placement/site",
      value: {
        type: "ref",
        value: "site:harbor",
      },
      valid: {
        from: 1772409600000,
        to: null,
      },
      recorded: {
        from: 1794426788633,
        to: null,
      },
      visible: true,
      assertion: "_tx/01M762QPRSDFXDBQSPDJAQP2XF",
      retraction: null,
    },
  ],
  transactions: [
    {
      txId: "_tx/01M762QPRSDFXDBQSPDJAQP2XF",
      position: 4,
      instant: 1794426788633,
      actor: "user:dana",
      commandId: "create:placement:maria-harbor",
      correlationId: "request:7f3a",
      causationId: null,
      release: {
        status: "found",
        id: "sha256-92c859ed4c5ff7b06b57a97b6f4a9774abf6d862a63487135965b9457cde8a3c",
        label: "hr-2026.1",
        rootCid: "sha256-e09adbce90b60e492eb2e8b39a18242be6dd7163c97fe2b2a700fb6c4cfcbe41",
      },
    },
  ],
  derivation: null,
  causation: {
    maxDepth: 0,
    traces: [
      {
        start: "_tx/01M762QPRSDFXDBQSPDJAQP2XF",
        ancestors: [],
        stop: {
          reason: "disabled",
        },
      },
    ],
  },
  gaps: [],
} as const;
export const candidateFixture = {
  version: 1,
  subject: {
    kind: "candidate",
    candidateId: "sha256-d8a4f233ae0e9452c7f0edfa1c415fb9afa32bd6e75f73e72f712336620eb32f",
    revision: "sha256-a7063abe0bb4df2f48b0f3213b54efaa2e807e19aa2d33845c949d433dacfad4",
  },
  basis: {
    recordedPosition: 6,
    validAt: 1772496000000,
  },
  facts: [
    {
      tripleId: "01M762QPRVRMSBZ3AHBY7F7E3F",
      entityId: "placement:maria-harbor",
      entityType: "Placement",
      attribute: ":placement/site",
      value: {
        type: "ref",
        value: "site:harbor",
      },
      valid: {
        from: 1772409600000,
        to: null,
      },
      recorded: {
        from: 1794426788633,
        to: null,
      },
      visible: true,
      assertion: "_tx/01M762QPRSDFXDBQSPDJAQP2XF",
      retraction: null,
    },
    {
      tripleId: "01M762QPRVRMSBZ3AHBY7F7E3E",
      entityId: "placement:maria-harbor",
      entityType: "Placement",
      attribute: ":placement/worker",
      value: {
        type: "ref",
        value: "worker:maria",
      },
      valid: {
        from: 1772409600000,
        to: null,
      },
      recorded: {
        from: 1794426788633,
        to: null,
      },
      visible: true,
      assertion: "_tx/01M762QPRSDFXDBQSPDJAQP2XF",
      retraction: null,
    },
  ],
  transactions: [
    {
      txId: "_tx/01M762QPRSDFXDBQSPDJAQP2XF",
      position: 4,
      instant: 1794426788633,
      actor: "user:dana",
      commandId: "create:placement:maria-harbor",
      correlationId: "request:7f3a",
      causationId: null,
      release: {
        status: "found",
        id: "sha256-92c859ed4c5ff7b06b57a97b6f4a9774abf6d862a63487135965b9457cde8a3c",
        label: "hr-2026.1",
        rootCid: "sha256-e09adbce90b60e492eb2e8b39a18242be6dd7163c97fe2b2a700fb6c4cfcbe41",
      },
    },
  ],
  derivation: {
    name: "task.site-safety-training",
    candidate: {
      id: "sha256-d8a4f233ae0e9452c7f0edfa1c415fb9afa32bd6e75f73e72f712336620eb32f",
      revision: "sha256-a7063abe0bb4df2f48b0f3213b54efaa2e807e19aa2d33845c949d433dacfad4",
      definitionId: "sha256-6d430a3fcdb169282b5dfe77b1d00ea297f32b614f6b5fda40d099e3ff2cb7cb",
      configSnapshot: "sha256-92c859ed4c5ff7b06b57a97b6f4a9774abf6d862a63487135965b9457cde8a3c",
      identity: {
        "?worker": "worker:maria",
        "?site": "site:harbor",
      },
      result: {
        "?worker": "worker:maria",
        "?site": "site:harbor",
      },
      basis: {
        recordedPosition: 6,
        validAt: 1772496000000,
      },
      sources: [
        {
          tripleId: "01M762QPRVRMSBZ3AHBY7F7E3E",
          transactionId: "_tx/01M762QPRSDFXDBQSPDJAQP2XF",
          transactionPosition: 4,
          entityId: "placement:maria-harbor",
          attribute: ":placement/worker",
          validFrom: 1772409600000,
        },
        {
          tripleId: "01M762QPRVRMSBZ3AHBY7F7E3F",
          transactionId: "_tx/01M762QPRSDFXDBQSPDJAQP2XF",
          transactionPosition: 4,
          entityId: "placement:maria-harbor",
          attribute: ":placement/site",
          validFrom: 1772409600000,
        },
      ],
    },
    release: {
      status: "found",
      id: "sha256-92c859ed4c5ff7b06b57a97b6f4a9774abf6d862a63487135965b9457cde8a3c",
      label: "hr-2026.1",
      rootCid: "sha256-e09adbce90b60e492eb2e8b39a18242be6dd7163c97fe2b2a700fb6c4cfcbe41",
    },
    evaluationNextTemporalBoundary: 1772668800000,
  },
  causation: {
    maxDepth: 0,
    traces: [
      {
        start: "_tx/01M762QPRSDFXDBQSPDJAQP2XF",
        ancestors: [],
        stop: {
          reason: "disabled",
        },
      },
    ],
  },
  gaps: [],
} as const;
