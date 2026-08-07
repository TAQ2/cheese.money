# Running CH3 in the Background

On a Linux host, CH3 can run as a background service for your user. It starts when the machine
boots and keeps running after you log out.

## Manage the Service

Install it with the latest CH3 release:

```sh
npx ch3@latest service install
```

Check whether it is installed:

```sh
npx ch3@latest service status
```

Update or repair it:

```sh
npx ch3@latest service update
```

Stop it and remove it from startup:

```sh
npx ch3@latest service uninstall
```

Updating restarts CH3 briefly. Let active agent work and terminal commands finish first.

## Using It with CH3 Connect

CH3 Connect may offer to install the service during setup so the host stays reachable after you log
out. This is only an onboarding shortcut: the service and CH3 Connect are managed separately.

Signing out of CH3 Connect does not remove the service. Use `ch3 service uninstall` when you no longer
want CH3 to start in the background.

The background service currently requires Linux with systemd.
