import { describe, expect, it } from "vitest";

import { isAllowedOrigin, parseAllowedOrigin } from "./security.js";

describe("explorer origin check", () => {
  const portal = "https://t-abc-p24537.onamp.dev";

  it("accepts its own loopback origin and each named origin only", () => {
    expect(isAllowedOrigin("http://localhost:4176", 4176, [])).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:4176", 4176, [])).toBe(true);
    expect(isAllowedOrigin(portal, 4176, [portal])).toBe(true);

    expect(isAllowedOrigin(undefined, 4176, [portal])).toBe(false);
    expect(isAllowedOrigin("http://localhost:4177", 4176, [])).toBe(false);
    expect(isAllowedOrigin("https://localhost:4176", 4176, [])).toBe(false);
    expect(isAllowedOrigin(portal, 4176, [])).toBe(false);
    expect(isAllowedOrigin("https://t-abc-p24537.onamp.dev.evil.example", 4176, [portal])).toBe(
      false,
    );
    expect(isAllowedOrigin("http://t-abc-p24537.onamp.dev", 4176, [portal])).toBe(false);
  });

  it("allows only exact https origins to be named", () => {
    expect(parseAllowedOrigin(`${portal}/`)).toBe(portal);
    expect(() => parseAllowedOrigin("http://example.com")).toThrow();
    expect(() => parseAllowedOrigin("https://example.com/app")).toThrow();
    expect(() => parseAllowedOrigin("*")).toThrow();
  });
});
