# RELEASING — how a shop's app updates itself

**Nothing in this repo publishes anything until you do the three steps in §1.** The placeholders are the
safety net: `electron-builder.yml` points at `PLACEHOLDER-OWNER/PLACEHOLDER-pos-releases`, which does not
exist, and the release workflow refuses to run while that is still true.

This is Phase 11. The code for it shipped in **v0.1.0** — per trap #1, an app shipped without an updater
can never update itself, so the updater has been inside every build from the first one. All that is
missing is a public place to put the installers.

---

## 0. What already works, and what is left

**Proven end-to-end in Phase 0.** An installed v0.1.0 was pointed at a local HTTP folder serving v0.1.1
and updated itself with zero clicks:

```
[updater] Checking for update
[updater] Found version 0.1.1
[updater] Downloading update ...
[updater] 0.1.1 downloaded — it will install silently when the app quits
```

Feed resolution → version compare → download → hand-off to the installer: **all of it works.** GitHub is
just a different URL.

**What is left is administrative, not technical:** a public repo, a token, and two lines of config.

---

## 1. The three things you have to do (once, by hand)

### 1.1 Create a SEPARATE, PUBLIC releases repo

Name it something like **`Engr-Talha/pos-releases`**. It holds installers only — no code.

**It must be PUBLIC even though the code repo is private.** (Trap #4.) The updater inside a shop's app
fetches the feed with **no credentials**. To read a private repo it would need a token, and that token
would have to ship inside the app — to customers. A token you give away is not a secret. A public repo of
installers gives away nothing: it is the same file you hand a customer anyway.

**Seed it with a README commit before anything else.** (Trap #3.) You cannot create a release in an empty
repo — GitHub answers `422 Repository is empty`, which is a baffling error to hit halfway through a
release.

### 1.2 Create the token

A **fine-grained PAT** with **`contents: write`** on the **releases repo only** — not on the code repo,
not on your account.

Add it to the **code** repo (`Engr-Talha/POS`) as an Actions secret named exactly:

```
RELEASES_TOKEN
```

Settings → Secrets and variables → Actions → New repository secret.

**The PAT lives in CI and nowhere else.** Not in the app, not in the code, not in a `.env`. (Trap #4.)

### 1.3 Point the config at it

In **`electron-builder.yml`**, replace the placeholders:

```yaml
publish:
  provider: github
  owner: Engr-Talha              # was PLACEHOLDER-OWNER
  repo: pos-releases             # was PLACEHOLDER-pos-releases
  releaseType: release           # LEAVE THIS ALONE — see below
```

**Do not change `releaseType: release`.** (Trap #2.) electron-builder's GitHub publish defaults to a
**draft** release, and **the updater cannot see drafts**. That is the classic lost afternoon: the release
is right there on the website, and not one installed app notices it.

Commit that change. The release workflow checks for `PLACEHOLDER` and refuses to run while it is there,
so this step cannot be forgotten.

---

## 2. Cutting a release

1. **Bump the version** in `package.json` and commit it. The app shows its version in the header
   (CLAUDE.md §4), so the number in a release and the number a user reads must be the same one.
2. Push to `main`. The normal **Build** workflow runs tests + typecheck and builds an unpublished
   Windows `.exe` as an artifact.
3. Go to **Actions → Release (manual) → Run workflow**. Type the version, and type **`PUBLISH`** to
   confirm.

That workflow will not proceed unless:

- you typed `PUBLISH` (a mistyped run costs seconds, not a release),
- the version you typed **matches `package.json` exactly**,
- the placeholders are gone,
- **the tests and typecheck pass** — a release is not the moment to skip the gate,
- and **the shipped `better-sqlite3` is Electron's ABI, not Node's** (trap #10c — see below).

Only then does it publish, using the CI token.

**It publishes Windows only.** (Trap #7.) macOS auto-update needs a real Apple Developer certificate;
Squirrel.Mac rejects our ad-hoc signature. Windows NSIS does no such check, which is why **Windows is the
real target and the `.dmg` is only the dev loop**.

---

## 3. The trap that nearly shipped a dead app

**Trap #10c.** `npm test` rebuilds `better-sqlite3` for **Node's** ABI. `electron-builder` needs
**Electron's**. If a Node-ABI binary is left lying around, `install-app-deps` looks at it, decides nothing
needs doing, and **ships the Node binary inside the app**. The installer builds cleanly. The tests are
green. The typecheck is green. And the app dies on launch:

```
NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 148.
```

`rebuild:electron` deletes `node_modules/better-sqlite3/build` first, which is what prevents it. The
release workflow **also checks the shipped binary directly**: it tries to load the exact
`app.asar.unpacked/.../better_sqlite3.node` under plain Node, and a release is refused if Node *succeeds*
— because that means it is a Node build. Node **refusing** it with `NODE_MODULE_VERSION 148` is the pass.

This is the same reason CLAUDE.md trap #9 says **launch the packaged build**. Everything else was green
the day this nearly went out.

---

## 4. After the first real release — verify it end to end

The one thing Phase 0 could not prove is the **Windows install step** (it proved everything up to it).
So, once:

1. Install the published `.exe` on a Windows machine.
2. Publish the **next** version.
3. Leave the installed app open. Within the hour it should log
   `[updater] Found version …` → `Downloading` → `downloaded — it will install silently when the app quits`.
4. Quit it. Reopen it. **The header shows the new version.**

If that works, the chain is real and every future release reaches every shop by itself.

**A failed update check must stay silent to the cashier.** No error box, ever — they are mid-sale, they
have no internet, and there is nothing for them to do about it.

---

## 5. Rolling one back

Delete the release (or mark it a draft — the updater cannot see drafts, which is trap #2 used on purpose
for once). Installed apps stop seeing it immediately.

**An app that already downloaded it will still install it on quit.** Downloads are silent and automatic.
So the only real rollback is **forward**: publish a higher version with the fix. Which is the same reason
the gates above are worth the extra thirty seconds.
