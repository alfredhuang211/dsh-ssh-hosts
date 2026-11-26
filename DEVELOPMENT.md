# Development, release and publishing

How to change this plugin, verify it, and ship a version.

> Every command here was run on this repository. If one stops working, fix the
> document — a runbook that lies is worse than none.

---

## 1. What this package is

A **DSH bundle**: an npm package whose `package.json` declares `dsh.bundle`, so
installing it adds a configuration layer to a DSH profile.

```
package.json       name, exports, dsh.bundle / dsh.client, engines.dsh
cordis.patch.yml   the layer: which rows the bundle inserts into a profile
lib/               host half (hand-written, no build step)
client/bundle.js   browser half (hand-written classic script, no build step)
locale/{en,zh}.json  display title/description for the Plugins page
icon.svg           Plugins-page artwork
```

**There is no build step.** `lib/` and `client/bundle.js` are the source of
truth and are committed as-is. The consumer's pnpm blocks dependency build
scripts, so a Git install has to carry runnable output; here that output is
authored, not generated.

---

## 2. Everyday development

```bash
npm ci        # install exactly what the lockfile pins
npm test      # node --test test/*.test.mjs
```

`.npmrc` pins `omit=peer`: this package declares DSH and its own runtime as
**peer** dependencies, supplied by the consuming Harness. Installing them
locally would pull the whole harness (600+ packages, ~500 MB) and pin a stale
DSH version into the lockfile. `npm install --include=peer` overrides it if you
ever need to resolve against a real harness.

`.npmrc` also pins `minimumReleaseAge=0`, so a version is installable the moment
it is published. That setting is npm-only; DSH itself installs with pnpm, which
has its own fresh-release hold (see §8).

### Editing the host half

`lib/*.js` is plain ESM. Keep the module's exported plugin shape intact:
`export const name`, optional `export const inject`, `export function apply`.

### Editing the browser half

`client/bundle.js` must keep the exact shape the Harness module table expects:
`window.__ModuleLoader__.load({ id, factory })`, where **`id` must equal the
package name**. A test asserts this, and it fails loudly if the two drift.

The browser half also registers a config card on the Plugins page through the
`plugins.bundle.config` slot, whose **`key` is the bundle's package name**. A
rename has to move both the bundle `id` and that key.

### Editing the bundle patch

`cordis.patch.yml` inserts one row. Only one of its identifiers follows the
package name:

| Field | Follows the package name? | Why |
|---|---|---|
| `name` | **yes** | Node resolves the module by package name |
| `id` | **no** | it is the profile override key; renaming orphans user overrides |

`name:` must be **quoted** when it starts with `@`: `@` is a YAML reserved
indicator and an unquoted value fails to parse, which silently disables the
whole bundle.

### Editing display metadata

`locale/en.json` and `locale/zh.json` carry `meta.title` and
`meta.description`, read by the Plugins page **without activating the plugin**.
English titles use sentence case. Both files plus the icon must be exported:

```json
"exports": {
  "./locale/*.json": "./locale/*.json",
  "./icon": "./icon.svg"
}
```

Without those export entries the page cannot resolve the text or artwork and
falls back to the bare package name — which is exactly what happened here before
they were added. Icons: SVG/PNG/JPEG/WebP, under 256 KiB, inside the package.

---

## 3. What must stay consistent

**Module identifiers follow the package name. On-disk and on-wire state does
not.**

| Identifier | Scope | Why |
|---|---|---|
| package `name` | scoped | consumed by npm and Node |
| row `name` in the patch | scoped | resolved as a module |
| client bundle `id` | scoped | must equal the package name |
| `plugins.bundle.config` slot key | scoped | the page keys the config card by package name |
| row `id` in the patch | unscoped | profile override key |
| the settings namespace | unscoped | existing user settings are filed under it |
| `~/.dsh/ssh-hosts.yaml`, the host list | unscoped | user data; renaming orphans it |

---

## 4. Versioning and `engines.dsh`

`engines.dsh` declares which Harness versions this package accepts. The trap:

**Prereleases need an explicit branch.** node-semver only lets a prerelease
satisfy a range when a comparator on the *same* `major.minor.patch` tuple
carries a prerelease tag:

```
>=0.2.0-rc.1 <0.3.0                            ✗ rejects 0.2.3-alpha.2
>=0.2.0-rc.1 <0.3.0 || >=0.2.3-alpha.2 <0.3.0  ✓
```

This package uses the second form. DSH's own check runs with
`includePrerelease`, but a user's plain `npm install` does not, so the first form
fails outside DSH while passing inside it.

---

## 5. Release checklist

```bash
npm ci
npm test
npm pack --dry-run
```

Confirm the pack list contains `lib/`, `client/bundle.js`,
`cordis.patch.yml`, `locale/*.json`, the icon, `README.md` and `LICENSE`, and
contains no tests or credentials.

Then bump, commit, tag:

```bash
npm version patch --no-git-tag-version
git add -A && git commit -m "release: v0.5.1"
git tag v0.5.1
git push origin main --tags
```

**The tag must equal `package.json` `version`**; the workflow refuses to publish
on a mismatch.

---

## 6. Automated publishing (OIDC)

`.github/workflows/publish.yml` publishes on a `v*` tag using npm **trusted
publishing**: GitHub signs a short-lived OIDC token, npm exchanges it for a
publish token. **No `NPM_TOKEN` secret exists, and none should be added.**

Pipeline: `install → test → pack → verify tag/version → publish --provenance →
poll until the tarball is downloadable`.

A manual `workflow_dispatch` run publishes nothing (it stops after `pack`) and is
the safe way to check the pipeline.

### Requirements that are not in this repository

The trusted publisher is registered on npmjs.com, per package:

| Field | Value |
|---|---|
| Publisher | GitHub Actions |
| Organization or user | `alfredhuang211` |
| Repository | `dsh-ssh-hosts` |
| Workflow filename | `publish.yml` (filename only, case-sensitive, with `.yml`) |
| Environment name | empty |
| Allowed actions | **must include "Allow npm publish"** |

### Two workflow settings that are load-bearing

**No `registry-url` on `setup-node`.** Setting it writes
`_authToken=${NODE_AUTH_TOKEN}` into the runner's `.npmrc` and exports
`GITHUB_TOKEN` in its place; npm then prefers that credential and never performs
the OIDC exchange.

**Node 24, not 22.** OIDC needs npm ≥ 11.5.1; Node 22 ships npm 10.x.

The workflow asserts that no static credential is present, so this cannot
regress quietly.

---

## 7. When publishing fails

| Symptom | Cause |
|---|---|
| `E404 Not Found - PUT ...` **and** provenance signed fine | a static credential suppressed OIDC (§6). Check `registry-url` and the Node version. |
| `ENEEDAUTH` / `Unable to authenticate` | trusted-publisher config mismatch: wrong repo, workflow filename, or package |
| `You cannot publish over the previously published versions` | **authentication worked**; the version already exists. Bump it. |
| Workflow stopped after `pack`, nothing published | that was a `workflow_dispatch` run, which publishes nothing by design |

Publishing is only proven when the tarball downloads:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  https://registry.npmjs.org/@alfredhuang211/dsh-ssh-hosts/-/dsh-ssh-hosts-<version>.tgz
```

`npm publish` prints success *before* the tarball is servable — measured 1.5 to 6
minutes on first releases. That is why the workflow polls.

---

## 8. Installing the result

```bash
dsh plugin --profile desktop add @alfredhuang211/dsh-ssh-hosts
```

**A fresh release is not installed by default.** pnpm holds back recently
published versions; naming the version explicitly makes DSH add a
`minimumReleaseAgeExclude` entry to the profile and proceed. Without a version
you get the previous release, not an error.

**Verify with `--dump-config`**, which proves the layer loaded:

```bash
dsh --profile desktop --dump-config | grep '== @alfredhuang211/'
```

---

## 9. Testing against a real server

`test/remote.test.mjs` is skipped by default. To run it:

```bash
DSH_SSH_HOSTS_REMOTE=1 npm run test:remote
```

It needs a reachable machine and is intentionally out of CI. `npm run smoke` and
`npm run smoke:ui` are manual probes for a live session; they are not part of the
release gate.
