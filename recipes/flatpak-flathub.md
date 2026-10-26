# flatpak-flathub

Flatpak + Flathub repo in container. Base for GUI apps, browsers, anything packaged there.

Best on desktop containers (kde-plasma recipe). Flatpak want user namespaces inside container; desktop base have tooling ready.

Install flatpak:

```
podman_exec {"container": "desk", "command": "apt-get update && apt-get install -y flatpak"}
```

Add Flathub remote:

```
podman_exec {"container": "desk", "command": "flatpak remote-add --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo"}
```

Install app, no prompts:

```
podman_exec {"container": "desk", "command": "flatpak install -y --noninteractive flathub org.mozilla.firefox"}
```

Run installed app:

```
podman_exec {"container": "desk", "command": "flatpak run org.mozilla.firefox"}
```

List what you got:

```
podman_exec {"container": "desk", "command": "flatpak list"}
```

Search Flathub:

```
podman_exec {"container": "desk", "command": "flatpak search spotify"}
```

Trouble: `bwrap` spawn fail mean container lack needed namespaces. Recreate with desktop mode and try again; bare alpine no good for flatpak.

Downloads land in `/var/lib/flatpak`. Big apps eat disk: check host room first with `podman_host_resources`.
