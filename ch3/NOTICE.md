# Provenance

CH3 is a fork of [T3 Code](https://github.com/pingdotgg/t3code) by T3 Tools
Inc., MIT-licensed. Folded into cheese.money on 2026-08-06 and fully rebranded
T3 → CH3 across the source: icon/wordmark, env var prefixes (`T3CODE_` →
`CH3CODE_`), the npm scope (`@t3tools/*` → `@ch3tools/*`), the project-config
filename (`t3.json` → `ch3.json`, see below), UI strings, class/type/function
names in every language in the tree (TS, Swift, Kotlin, C++/JNI), and bundle
identifiers.

This fork already carried real uncommitted work on top of upstream before the
fold-in — a Claude multi-account manager with automatic failover, native
text-to-speech read-aloud, an output-style selector, and a dedicated Accounts
settings tab. See `FORK-SETUP.md` for the build/install runbook.

## LICENSE — kept, deliberately

`LICENSE` is unmodified MIT with T3 Tools Inc.'s original copyright notice.
Two reasons this stayed rather than being rewritten or dropped, in case that
choice ever needs re-litigating: the code under it isn't ours to relicense —
MIT permits broad reuse but *conditions* that permission on keeping the notice
intact, so removing it doesn't make the obligation disappear, it makes the
copy unlicensed; and this repo is public on GitHub (`TAQ2/cheese.money`), not
private, so "internal, shared with one colleague" doesn't describe its actual
reach. Everything else that read as unnecessary ceremony for a two-person fork
— `CONTRIBUTING.md`, the PR/issue templates, the contributor vouch bot — is
gone; none of that carried the same weight.

## What did not come along, on purpose

- **Git history.** This is a snapshot of the working tree, not a
  history-preserving merge.
- **`.repos/alchemy-effect` and `.repos/effect-smol`** — two third-party
  open-source repos upstream vendors in-tree (~126 MB), presumably for
  in-editor AI context. Pristine copies of other people's already-public code,
  easy to refetch if ever needed.
- **`node_modules/`, `release/`, `native/**/target/`** — regenerable build
  output, excluded the same way upstream's own `.gitignore` excludes them.

## Required follow-ups this fold-in could not finish

- ~~`pnpm-lock.yaml` and `native/resource-monitor/Cargo.lock` are stale.~~
  **Resolved 2026-08-06**: `pnpm install` reconciled `pnpm-lock.yaml` to
  `@ch3tools/*` on its own; `Cargo.lock`'s package name was fixed with
  `cargo generate-lockfile` after `pnpm dist:desktop:dmg:arm64` caught the
  mismatch (`cargo build --locked` refused to proceed). Both verified via a
  real build: `pnpm build` and the full DMG package succeeded.
- **macOS Dock icon (`icon.icns`) still shows the old black/white T3 mark**
  in the tracked repo assets. A hand-built replacement (correct `#E9C46A`
  tile, proper 824×824-body/100px-margin safe area, no Icon Composer) was
  produced and verified in a staged build, but was deliberately NOT committed
  here — that's a real design decision, not just an execution detail, and
  wasn't mine to make unilaterally. See the build session for the artifact
  and how it was made if you want to commit it.
- **iOS/Linux/Windows/web icon exports were not touched at all** — only the
  macOS Dock icon was addressed (by hand, as above). The `Assets/text.svg`
  used by Icon Composer.icon is the one CH3-rebranded source; the
  platform-specific derived files still show the old black/white T3 mark.
  The *source* is rebranded — `assets/prod/logo.svg`,
  `assets/prod/app-icon.icon/{icon.json,Assets/text.svg}` — but the shipped
  favicons, `apple-touch-icon`, Windows `.ico`, and macOS `.icns` are
  pre-rendered exports of that source, produced by Icon Composer 2 (macOS-only
  GUI app), which isn't available in the environment this fold-in ran in. Run
  `vp run icons:export` per `assets/README.md` on a Mac that has it — that
  file also documents the manual macOS-pre-Tahoe PNG export step Icon
  Composer's CLI can't do headlessly.
- **`t3.json` / `ch3.json` back-compat.** `CH3ProjectFileLoader` now reads
  `ch3.json` first and falls back to the legacy `t3.json` filename only if
  that's absent, specifically so Hark's and VendeBien's existing `t3.json`
  files (written before this rename) keep resolving without needing to touch
  those repos tonight. Worth renaming their files to `ch3.json` eventually and
  dropping the fallback.
