const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The explorer host can write, so it answers API requests only from its own
 * loopback origin, plus exact origins the operator names, such as an
 * authenticated orb portal that proxies to it. Nothing else is accepted.
 */
export const isAllowedOrigin = (
  origin: string | undefined,
  port: number,
  allowed: readonly string[],
): boolean => {
  if (origin === undefined) return false;
  if (allowed.includes(origin)) return true;
  try {
    const url = new URL(origin);
    return (
      url.protocol === "http:" &&
      LOOPBACK_HOSTS.has(url.hostname) &&
      url.port === String(port) &&
      url.pathname === "/" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
};

/** An allowed origin must be a bare HTTPS (or loopback HTTP) origin with no path. */
export const parseAllowedOrigin = (value: string): string => {
  const url = new URL(value);
  const loopback = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if ((url.protocol !== "https:" && !loopback) || url.origin !== value.replace(/\/$/, "")) {
    throw new Error(
      `--allow-origin needs an exact https origin such as https://example.com, got ${value}`,
    );
  }
  return url.origin;
};
