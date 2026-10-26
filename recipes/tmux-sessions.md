# tmux-sessions

Stateful shell session in container, tmux under hood. `podman_session_send` feed command, pane text come back. Session live in container, not plugin: dsh crash, session keep running. Rediscover any time.

Need tmux in container. Alpine:

```
podman_exec {"container": "box", "command": "apk add --no-cache tmux"}
```

Debian: `apt-get install -y tmux`. Fedora: `dnf install -y tmux`. Arch: `pacman -S --noconfirm tmux`.

Send first command, session auto-create:

```
podman_session_send {"container": "box", "session": "work", "keys": "echo hello && sleep 400"}
```

Long build, send and peek later:

```
podman_session_send {"container": "box", "session": "build", "keys": "make -j2", "wait_seconds": 3}
```

Re-read pane, no new command:

```
podman_session_capture {"container": "box", "session": "build", "lines": 50}
```

Interactive thing (top, watch, REPL): send keys, no Enter:

```
podman_session_send {"container": "box", "session": "work", "keys": "q", "enter": false}
```

List session:

```
podman_session_list {"container": "box"}
```

Kill one, or all (omit session):

```
podman_session_kill {"container": "box", "session": "work"}
```

Rule: quick one-liner → `podman_exec`. Thing that outlive one call (test suite, dev server, watch loop) → session. Session die with container at TTL, no rescue.
