# Harness 0.2.1-rc.4 compatibility

Published `0.1.27` enumerated exact peer versions through rc.3, so an rc.4 host rejected installation before activation ([#316](https://github.com/NanmiCoder/dsh-agent-teams/issues/316)). This change declares rc.4 as an exact `preview` target and regenerates all 21 `@deepseek-ai/dsh-*` peer ranges from `compatibility.json`. The recommended host and development cohort remain on rc.2; promoting rc.4 is a separate release decision.

## Source audit

The upstream rc.3/rc.4 comparison in [PR #318](https://github.com/NanmiCoder/dsh-agent-teams/pull/318) records:

- rc.3: `1f81c047fc48fa190a683e469daa699857e9afe8` (`dsh-v0.2.1-rc.3`).
- rc.4: `504a01a9578abc2c6f1fb896b1dc322c9fe24f66` (`dsh-v0.2.1-rc.4`).
- The rc.4 delta is limited to MCP resource-listing/catalog diagnostics moving off ACP stdout and a View-tab tooltip fix in `dsh-client-ui-conversation`.
- AgentTeams does not import the affected MCP packages or the removed `session.moreViewsCurrent` locale key. Its `dsh-client-ui-conversation/client` card-definition/type-only use is unaffected.

## Local verification

- `node --test scripts/compatibility.test.mjs`: 14 passed, 0 failed.
- `pnpm verify:compatibility`: passed, including the rc.4 policy assertion and the local 295-package rc.2 identity check.
- `pnpm typecheck`: passed.
- `pnpm build`: passed.
- `pnpm verify:issue-regressions`: 70 passed, 0 failed.
- `pnpm verify:manifest`: 4 passed, 0 failed; the dry-run package inventory contains `dsh-plugin.json`.
- Candidate tarball: `/tmp/w0-artifact/nanmicoder-dsh-agent-teams-0.1.27.tgz`; SHA-256 `ac8fa4f01a96ead8cb285982cf5ca1a8c6e498fc4b1945a41e9bc78020c72462`.
- `node scripts/harness-runtime-verify.mjs` passed all 11 runs (ten runtime scenarios plus `plugin-manager-install`) from that same tarball on clean 0.2.1-rc.4, rc.3 and rc.2 cohorts. Each result has `passed=true` with no failed scenario.

No host-check bypass or plugin-manager override is used. The runtime matrix uses a fixture model and isolated profiles; it does not replace a manual desktop/provider-credential acceptance test.

## Recovery

Until a release carries this declaration, stay on rc.3 or rc.2 with the published `0.1.27`; do not bypass host compatibility checks.
