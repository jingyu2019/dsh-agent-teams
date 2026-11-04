# Issue 331/324 integration artifact smoke

- Host: `@deepseek-ai/dsh@0.2.1-rc.5`
- Plugin artifact: `@nanmicoder/dsh-agent-teams@0.1.29`
- Artifact SHA-256: `d1044d5104e0a4a382a37300e77ed2c170529d42360b7eba64c71b33a4ea8bd7`
- Runtime cohort: 296 exact DSH packages
- Node: `v26.8.1`, macOS arm64
- Command: `node scripts/harness-runtime-verify.mjs --host-version 0.2.1-rc.5 --artifact <packed-artifact.tgz> --report-dir <fresh-temp-dir> --scenario progressive-entry`
- Result: the `progressive-entry` packaged product-entry scenario passed; the real DSH plugin-manager install accepted the artifact and installed the expected version.
- Host startup follow-up: the installed isolated `web` profile produced the DSH web URL and the anonymous root request returned HTTP 401, as expected for its token-protected endpoint. The host was stopped after this check.

This is package-install and product-entry smoke evidence. It does **not** exercise #331's fork lineage against a real host, render or interact with the new `plugins.bundle.config` page in a browser, or prove a live desktop UI flow. Browser interaction and other operating systems remain unverified. The machine's active desktop profile was not changed.
