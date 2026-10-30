# Harness 0.2.1-rc.5 compatibility

Date: 2026-10-31 (Asia/Shanghai)

## Result

- Host: `0.2.1-rc.5`
- Plugin: `@nanmicoder/dsh-agent-teams@0.1.28`
- Artifact SHA-256: `1b9dd37f25b998c1a3b9d51f93a2953f374a0a27c0ba6908921cff43f819d0fe`
- Runner: `scripts/harness-runtime-verify.mjs`
- Scenario: `progressive-entry`
- Node: `v26.12.1`, darwin arm64
- Cohort: 296 exact DSH packages
- Result: **passed**

Both required runs passed from the packed artifact:

1. `progressive-entry` — natural, natural-zh, raw-slash, command, profile-command and profile-raw entry cases; all six passed with stable system/tool prefixes.
2. `plugin-manager-install` — the real `dsh plugin add` path installed the exact plugin version.

This directly addresses the rc.5 installation rejection reported in #327/#328. The runtime report is checked in as [`result.json`](./result.json). Only the model is a deterministic fixture; real provider APIs and browser interaction remain outside this check.

## Stability and memory audit

The real DSH `stability` scenario also passes on rc.5 with all 13 checks. The fixture records `process.memoryUsage()` at the start, after each scripted transition and at the end. Over 108 model requests and 15 samples:

- `heapUsed`: 105,416,832 → 106,369,712 bytes (+0.95 MiB, +0.9%)
- `heapTotal`: 149,716,992 → 168,624,128 bytes
- `RSS`: 235,388,928 → 259,899,392 bytes (+24.5 MiB)
- `maxHeapUsed`: 116,684,656 bytes

The heap was bounded in this repeated team lifecycle run; RSS growth is consistent with V8/runtime page retention. This does not reproduce a long-running real-model OOM, so #117 still needs a user-side RSS/heapUsed series for the failing workload. The machine-readable summary is [`memory-audit.json`](./memory-audit.json).
