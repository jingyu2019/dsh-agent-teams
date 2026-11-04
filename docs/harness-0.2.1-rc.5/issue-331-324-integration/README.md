# Issue 331/324 integration artifact smoke

- Host: `@deepseek-ai/dsh@0.2.1-rc.5`
- Plugin artifact: `@nanmicoder/dsh-agent-teams@0.1.29`
- Initial product-entry smoke artifact SHA-256: `d1044d5104e0a4a382a37300e77ed2c170529d42360b7eba64c71b33a4ea8bd7`
- Runtime cohort: 296 exact DSH packages
- Node: `v26.8.1`, macOS arm64
- Command: `node scripts/harness-runtime-verify.mjs --host-version 0.2.1-rc.5 --artifact <packed-artifact.tgz> --report-dir <fresh-temp-dir> --scenario progressive-entry`
- Result: the `progressive-entry` packaged product-entry scenario passed; the real DSH plugin-manager install accepted the artifact and installed the expected version.
- Browser-verified rebuild SHA-256: `6569916739d0c16c628f97c334059cd127b3f4ac64c6916ae78c60fb2a406984`.
- Browser finding and fix: rc.5 Settings projects only `.volatile()` Config fields into `configForms`. `maxMembers` was missing that marker, so the page was not registered. It now uses `.volatile()` and the runtime reads the live reference rather than a startup snapshot.
- Browser result: installed the rebuilt artifact into an isolated `web` profile, opened Plugins → AgentTeams, observed the default value `8`, saved `13` and confirmed the profile patch contained `maxMembers: 13`, then reset and saved. The override disappeared and the effective value returned to `8`. The browser console had no errors.
- #331 real-host result: `node scripts/harness-runtime-verify.mjs --host-version 0.2.1-rc.5 --artifact <rebuilt-artifact.tgz> --runtime-dir <exact-rc5-runtime> --report-dir <fresh-temp-dir> --scenario fork-owned-team` passed against the same rebuilt artifact. The actual DSH `fork` provider created a child session; the parent and child each persisted a team with their own captain session id, and the child's `agent_teams_status` resolved its own team. The fixture replaced only the model adapter. Detailed machine output: `/tmp/agentteams-331324-smoke/rc5/fork-owned-team-retry/result.json`.
- The isolated profile was restored to its pre-test configuration and the host was stopped. The machine's active desktop profile was not changed.

The initial artifact has the package-install/product-entry smoke. The rebuilt artifact has plugin-manager install, live Web UI, and real fork-provider scenario evidence. The browser run used an isolated Web profile, not the user's live desktop. Other operating systems remain unverified.
