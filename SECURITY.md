# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Yggdrasil, please report it responsibly.

**Do NOT open a public issue.**

Instead, email: **<me@chrisdudek.com>** (or use GitHub's private vulnerability reporting feature).

Please include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge receipt within 48 hours and aim to release a fix within 7 days for critical issues.

## Scope

The Yggdrasil CLI (`yg`) is a local-only tool that reads and writes files. It makes no network calls and has no authentication. Security concerns are primarily around:

- Path traversal in graph file parsing
- Arbitrary file read/write via mapping paths
- Denial of service via malformed YAML

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.3.x   | Yes       |
