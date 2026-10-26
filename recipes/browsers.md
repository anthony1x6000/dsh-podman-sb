# browsers

Firefox + Chromium in desktop container. Flatpak route, needs flatpak-flathub recipe + kde-plasma recipe done first.

Firefox:

```
podman_exec {"container": "desk", "command": "flatpak install -y --noninteractive flathub org.mozilla.firefox"}
```

Chromium:

```
podman_exec {"container": "desk", "command": "flatpak install -y --noninteractive flathub org.chromium.Chromium"}
```

Launch inside Plasma VNC session (VNC must be up, see kde-plasma):

```
podman_exec {"container": "desk", "command": "su - agent -c 'DISPLAY=:1 flatpak run org.mozilla.firefox &> /tmp/ff.log &'"}
```

Browser then dsh-cu drivable through the same VNC/noVNC screen.

No desktop, just need headless scrape/test? Skip flatpak, use playwright-style headless shell or `apt-get install -y chromium` with `--headless --no-sandbox` flag. Headless in rootless container still need `--no-sandbox`.
