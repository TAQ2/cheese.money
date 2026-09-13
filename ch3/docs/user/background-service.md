# Running CH3 in the Background

On a Linux host, CH3 can run as a background service for your user. It starts when the machine
boots and keeps running after you log out.

The `ch3` command here is the server's own CLI, run from a checkout (`node apps/server/src/bin.ts`)
or from the installed app's bundle. There is no npm package to fetch it from; CH3 ships the
desktop app only, and this Linux service is inherited from upstream and not something CH3 runs.

## Manage the Service

Install it with the latest CH3 release:

```sh
ch3 service install
```

Check whether it is installed:

```sh
ch3 service status
```

Update or repair it:

```sh
ch3 service update
```

Stop it and remove it from startup:

```sh
ch3 service uninstall
```

Updating restarts CH3 briefly. Let active agent work and terminal commands finish first.

## Using It with CH3 Connect

CH3 Connect may offer to install the service during setup so the host stays reachable after you log
out. This is only an onboarding shortcut: the service and CH3 Connect are managed separately.

Signing out of CH3 Connect does not remove the service. Use `ch3 service uninstall` when you no longer
want CH3 to start in the background.

The background service currently requires Linux with systemd.
