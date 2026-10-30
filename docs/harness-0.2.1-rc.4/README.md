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

The full tarball-install and ten-scenario runtime matrix on clean rc.2/rc.3/rc.4 profiles is not claimed here unless it is rerun against the final candidate. No host-check bypass or plugin-manager override is used.

## Recovery

Until a release carries this declaration, stay on rc.3 or rc.2 with the published `0.1.27`; do not bypass host compatibility checks.
