const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Only the loopback page served by this process may call its mutating API. */
export const isAllowedDashboardOrigin = (origin: string | undefined, port: number): boolean => {
  if (origin === undefined) return false;
  try {
    const url = new URL(origin);
    return (
      url.protocol === "http:" &&
      LOOPBACK_HOSTS.has(url.hostname) &&
      url.port === String(port) &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
};
