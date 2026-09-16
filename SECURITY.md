# Security Policy

## Supported Versions

| Version | Supported |
| --- | --- |
| 0.1.0-beta.1 | Yes |
| < 0.1.0 | No |

## Reporting a Vulnerability

The Loci team takes the security and privacy of research environments seriously. Because Loci is a local-first application handling sensitive scientific data, security and data isolation are fundamental.

If you believe you have discovered a security vulnerability in Loci (including renderer isolation bypass, path containment escape, unexpected network transmission, or arbitrary code execution):

1. **Do not create a public GitHub issue.**
2. Please report the issue via GitHub Private Vulnerability Reporting on the [sidd-bme/loci-app repository](https://github.com/sidd-bme/loci-app/security/advisories/new) or by emailing **siddn.bme@gmail.com**.
3. Include detailed steps to reproduce the issue, the affected platform and version, and any proof-of-concept scripts or files.

### Response timeline

- **Initial acknowledgment:** Within 48 hours.
- **Assessment & reproduction:** Within 5 business days.
- **Fix & advisory:** Handled through coordinated disclosure.

## Security & Privacy Invariants

- **Local-first guarantee:** Loci does not include telemetry, tracking, or remote error reporting.
- **Path containment:** Raw source paths and local host filesystem details are redacted from export payloads and logs.
- **Model safety:** Loci never silently downloads or executes remote untrusted code or weights. Checkpoints require explicit user import and checksum verification.
