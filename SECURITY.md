# Security policy

## Supported versions

Triplex is pre-1.0. Only the newest release on the npm `next` tag and the current `main` branch
receive security fixes. Older canaries may be replaced without a compatibility period.

The Cloudflare and FoundationDB packages are experimental and are not production support claims.
See [docs/current-state.md](docs/current-state.md) for the complete maturity contract.

## Reporting a vulnerability

Please report suspected vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/bjacobso/triplex/security/advisories/new).
Do not open a public issue for an undisclosed vulnerability.

Include the affected package and version, impact, reproduction steps, and any suggested mitigation.
You should receive an acknowledgement within seven days. We will coordinate disclosure after a fix
or mitigation is available.

## Security boundary

Triplex provides storage and query primitives. Applications remain responsible for authentication,
authorization, secret management, network isolation, backups, and safe operational limits. The
allow-all HTTP authorization layer is intended only for local examples.
