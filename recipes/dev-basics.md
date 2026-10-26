# dev-basics

Git, gh CLI, curl, jq, build toolchain. First stop in fresh box.

Alpine:

```
podman_exec {"container": "box", "command": "apk add --no-cache git github-cli curl jq build-base bash less vim"}
```

Debian / Ubuntu:

```
podman_exec {"container": "box", "command": "apt-get update && apt-get install -y git gh curl jq build-essential bash less vim"}
```

Fedora:

```
podman_exec {"container": "box", "command": "dnf install -y git gh curl jq gcc make CMake less vim"}
```

Arch:

```
podman_exec {"container": "box", "command": "pacman -Sy --noconfirm git github-cli curl jq base-devel less vim"}
```

openSUSE:

```
podman_exec {"container": "box", "command": "zypper install -y git github-cli curl jq patterns-devel-base-devel_basis vim"}
```

Login gh (needs token from host, do not paste secrets in chat you do not own):

```
podman_exec {"container": "box", "command": "gh auth login --with-token < /path/to/token"}
```

Verify:

```
podman_exec {"container": "box", "command": "git --version && gcc --version | head -1 && gh --version | head -1"}
```
