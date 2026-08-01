# Releasing

Releases are cut by GitHub Actions on any pushed `v*` tag (`.github/workflows/release.yml`).
The job:

1. `npm ci` → `npm run build` — bundles `bin/cli.mjs` into a single self-contained
   `dist/ccb.mjs` via esbuild (`--bundle --platform=node --format=esm --target=node18`).
   All the `await import("../src/*.mjs")` calls get inlined, and `import.meta.url` stays
   native so the scheduler bakes in the installed binary's own path — no checkout dependency.
2. Verifies the bundle runs standalone.
3. Creates a GitHub Release and attaches `dist/ccb.mjs` (what `install.sh` downloads).
4. `npm publish --access public --provenance` to
   [`@paputechxyz/claude-code-backup`](https://www.npmjs.com/package/@paputechxyz/claude-code-backup).

## Cut a release

```bash
# 1. Bump the version in package.json, commit, and merge to main.
# 2. Tag it (reads the version from package.json) and push — this triggers the workflow:
just tag                 # tags vX.Y.Z from package.json and pushes it
just tag 0.3.1           # or pass an explicit version → v0.3.1
```

`just tag` refuses if the tag already exists (bump `package.json` first), creates an
annotated tag, pushes it, and prints a `gh run watch` command to follow the run.
A normal `git push` does **not** push tags — the `git push origin <tag>` is what triggers CI.

## npm publish setup & gotchas

The workflow reads an `NPM_TOKEN` repo secret (`gh secret set NPM_TOKEN --repo <owner/repo>`).
If you fork this or hit `E404`/`E403` on publish, check these — each one bit us on the first
publish:

- **The scope must be an npm org (or user) you own.** `@paputechxyz` is an npm
  **organization**; the package won't publish until that org exists. A first publish to a
  scope you don't own returns a misleading `404 Not Found - PUT .../@scope%2fname` (npm masks
  the permission denial as a 404), *not* a clear "create the org first".
- **The token must not have an IP allowlist.** A granular token with **Allowed IP ranges**
  set is rejected from GitHub Actions runners (dynamic IPs) with
  `403 ... You may not perform that action from your current IP` — which again can surface on
  the runner as a `404` on the create-package write. Use a **Classic → Automation** token
  (no IP restriction, bypasses 2FA) or a granular token with the IP allowlist left empty.
- **Granular token scope.** If you do use a granular token, give it **Read and write** on
  packages and explicitly add the **`paputechxyz`** organization; a token minted before the
  org existed won't include it.
- Provenance (`--provenance`) needs `permissions: id-token: write` in the workflow (already set).

Quick local sanity check of a token without exposing it on the command line:

```bash
umask 077; printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" > /tmp/nrc
npm whoami --userconfig /tmp/nrc     # prints your npm username on a good token
rm -f /tmp/nrc
```
