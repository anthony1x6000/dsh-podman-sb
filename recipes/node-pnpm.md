# node-pnpm

Node LTS + pnpm in container. LTS today: Node 22.

Debian / Ubuntu path, NodeSource build:

```
podman_exec {"container": "box", "command": "apt-get update && apt-get install -y ca-certificates curl gnupg && mkdir -p /etc/apt/keyrings && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' > /etc/apt/sources.list.d/nodesource.list && apt-get update && apt-get install -y nodejs"}
```

Alpine path, distro package:

```
podman_exec {"container": "box", "command": "apk add --no-cache nodejs npm"}
```

pnpm through corepack, every distro:

```
podman_exec {"container": "box", "command": "corepack enable pnpm && corepack prepare pnpm@latest --activate"}
```

Fedora: `dnf install -y nodejs npm`. Arch: `pacman -S --noconfirm nodejs npm`.

Verify both:

```
podman_exec {"container": "box", "command": "node -v && pnpm -v"}
```

`v22.x` and `pnpm/10.x`-ish mean good. Now `pnpm init`, `pnpm add`, `pnpm run` all work. Store lives in container: `pnpm store` cache die with container, expect cold installs each new box.
