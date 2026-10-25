# Security policy

## Reporting a vulnerability

Please report security problems privately, never in a public issue, pull
request or discussion.

Use GitHub's private vulnerability reporting: on this repository's
**Security** tab, press **Report a vulnerability**
(https://github.com/Delta-Robotics-Inc/uhd-viewer/security/advisories/new).
Only the maintainers see the report.

Say what is affected (the library, the components, the standalone app, or
the `uhd-viewer serve` server), the version (`npm ls @deltarobotics/uhd-viewer`),
how to reproduce it (a small UHD bundle helps), and what an attacker could do
with it.

We acknowledge a report within five working days, keep you informed while we
fix it, and credit you in the advisory unless you would rather we did not.
Please give us a reasonable time to release a fix before you disclose it.

## Supported versions

Fixes go into the newest release on npmjs. Update to it with
`npm install @deltarobotics/uhd-viewer@latest`.

## Scope

This repository: the `@deltarobotics/uhd-viewer` npm package, its standalone
app and `uhd-viewer serve`. Worth reporting here: a bundle or an artifact that
runs script in the viewer's page, a host message accepted from an origin that
was not allowed, or `uhd-viewer serve` answering with a file the bundle does
not reference. UHD itself (https://github.com/Delta-Robotics-Inc/OpenUHD) and
the Protoboard stack (https://github.com/Delta-Robotics-Inc/protoboard-stack)
have their own repositories and policies.
