# kde-plasma

KDE Plasma desktop in container. Preferred desktop: dsh-cu computer-use plugin drive it over VNC/noVNC.

Create container first, desktop mode. Debian bookworm-slim is the desktop default:

```
podman_create {"name": "desk", "desktop": true, "ttl_minutes": 240, "memory_mb": 4096, "cpus": 2}
```

Result carries host VNC port and noVNC port. Write them down. Desktop eat RAM: give 4 GB if host can spare.

Install KDE Plasma + VNC + noVNC inside. Big download, ~1 GB, few minutes:

```
podman_exec {"container": "desk", "command": "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends kde-plasma-desktop tigervnc-standalone-server novnc websockify dbus-x11 xterm"}
```

Make desktop user. VNC as root is pain, do not:

```
podman_exec {"container": "desk", "command": "useradd -m -s /bin/bash agent && echo 'agent:agent' | chpasswd"}
```

Set VNC password for that user:

```
podman_exec {"container": "desk", "command": "su - agent -c 'mkdir -p ~/.vnc && echo agent | vncpasswd -f > ~/.vnc/passwd && chmod 600 ~/.vnc/passwd'"}
```

Point VNC at Plasma session:

```
podman_exec {"container": "desk", "command": "su - agent -c 'printf \"#!/bin/sh\\nunset SESSION_MANAGER\\nunset DBUS_SESSION_BUS_ADDRESS\\nexec dbus-run-session -- startplasma-x11\\n\" > ~/.vnc/xstartup && chmod +x ~/.vnc/xstartup'"}
```

Start VNC on display :1, port 5901 in container:

```
podman_exec {"container": "desk", "command": "su - agent -c 'vncserver :1 -localhost yes -geometry 1280x800 -depth 24'"}
```

Start noVNC web gateway on port 6081 in container:

```
podman_exec {"container": "desk", "command": "websockify --web /usr/share/novnc 6081 localhost:5901 &> /tmp/novnc.log & sleep 1 && curl -s -o /dev/null -w \"%{http_code}\" http://localhost:6081/vnc.html"}
```

`200` mean up. Browser on host: `http://127.0.0.1:<novnc-host-port>/vnc.html`. Password `agent`.

dsh-cu: point it at that noVNC URL, or bare VNC `127.0.0.1:<vnc-host-port>`, password `agent`.

Verify session alive:

```
podman_exec {"container": "desk", "command": "su - agent -c 'vncserver -list'"}
```

Kill and restart VNC if session wedges:

```
podman_exec {"container": "desk", "command": "su - agent -c 'vncserver -kill :1 && vncserver :1 -localhost yes -geometry 1280x800 -depth 24'"}
```

Lighter option: `plasma-desktop` instead of `kde-plasma-desktop`. Less polish, less RAM. Screen glitch? Recreate with bigger `memory_mb` first.
