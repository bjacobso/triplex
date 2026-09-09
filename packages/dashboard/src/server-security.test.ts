import { describe, expect, it } from "vitest";

import { isAllowedDashboardOrigin } from "./server-security.js";

describe("dashboard server origin policy", () => {
  it.each(["http://localhost:4174", "http://127.0.0.1:4174", "http://[::1]:4174"])(
    "allows its loopback origin %s",
    (origin) => {
      expect(isAllowedDashboardOrigin(origin, 4174)).toBe(true);
    },
  );

  it.each([
    undefined,
    "null",
    "https://localhost:4174",
    "http://localhost:9999",
    "http://evil.test:4174",
    "http://localhost:4174/path",
  ])("rejects non-matching origin %s", (origin) => {
    expect(isAllowedDashboardOrigin(origin, 4174)).toBe(false);
  });
});
