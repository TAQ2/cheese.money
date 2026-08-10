# Build and install CH3 Desktop locally

> For maintainers shipping a local change to the installed app. Releases go
> through [Release](./release.md) instead.

`/Applications/CH3.app` is a packaged artifact: it carries its own server and a
**prebuilt** web client inside `Contents/Resources/app.asar`. Editing
`apps/web/src` and relaunching the app changes nothing — the bundle it serves is
the one that was packed at build time. A source change reaches the installed app
only by rebuilding the artifact and installing it.

Two ways to see a change, depending on what you need:

| Need                          | Command                                      | Restart?      |
| ----------------------------- | -------------------------------------------- | ------------- |
| Iterate on the change         | `npm run dev` (web `:5733`, server `:13773`) | No — Vite HMR |
| Ship it to the app you launch | build + install below                        | Yes, once     |

The dev server writes to a worktree-scoped CH3 home, so it has its own projects
and threads and never touches the installed app's data.

## Build

```sh
npm run dist:desktop:dmg:arm64      # or :x64 — match the host arch (`uname -m`)
```

Roughly two minutes on an M-series host. The script builds web/server/desktop,
stages a production-only dependency install, then runs electron-builder. Output
lands in `release/` (gitignored):

```
release/CH3-Code-<version>-arm64.dmg
release/CH3-Code-<version>-arm64.zip        # auto-update channel asset
release/*.blockmap
```

## Install

The app can stay running. Moving the old bundle aside rather than deleting it
keeps the live process's open files valid, so a running session survives the
swap and picks up the new code on its next launch.

```sh
hdiutil attach release/CH3-Code-<version>-arm64.dmg -nobrowse -readonly -mountpoint /tmp/ch3-dmg
mkdir -p ~/.ch3-app-backups
mv /Applications/CH3.app ~/.ch3-app-backups/CH3-<version>-pre-<timestamp>.app
ditto /tmp/ch3-dmg/CH3.app /Applications/CH3.app
hdiutil detach /tmp/ch3-dmg
```

`/Applications` is admin-writable, so no `sudo`.

Roll back by reversing the move — the backup is a complete bundle, not a diff:

```sh
rm -rf /Applications/CH3.app && mv ~/.ch3-app-backups/CH3-<version>-pre-<timestamp>.app /Applications/CH3.app
```

## Verify the artifact actually carries the change

Local builds do not bump the version, so `CFBundleShortVersionString` is
identical before and after and proves nothing. Grep the packed bundle for a
string unique to the change instead — a class name, an identifier, a literal:

```sh
grep -ac "<marker>" /Applications/CH3.app/Contents/Resources/app.asar
```

`0` (exit 1) on the outgoing bundle and non-zero on the new one is the check
that matters. `-a` is required: `app.asar` is binary.

## Signing

Without `CH3CODE_DESKTOP_LOCAL_SIGN_IDENTITY` the build is ad-hoc signed
(`codesign -dv` reports `Signature=adhoc`, `TeamIdentifier=not set`). macOS keys
keychain permission to the exact binary, so each ad-hoc reinstall is a stranger
to the login keychain and the app asks for the password again. Setting that
variable to a self-signed identity present in the keychain makes every local
build sign as the same identity and the grant survives reinstalls; see
`readLocalSignIdentity` in `scripts/build-desktop-artifact.ts`.

## Before building

The artifact packs the **entire working tree**, not just the change under
review. Uncommitted work elsewhere in the repo ships with it. Check `git status`
first and say what went in.
