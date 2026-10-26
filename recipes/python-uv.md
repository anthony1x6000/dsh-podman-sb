# python-uv

Python + uv, fast package manager. One curl, no apt python mess.

Install uv, all distros:

```
podman_exec {"container": "box", "command": "curl -LsSf https://astral.sh/uv/install.sh | sh && ln -sf /root/.local/bin/uv /usr/local/bin/uv && ln -sf /root/.local/bin/uvx /usr/local/bin/uvx"}
```

Alpine need curl first: `apk add --no-cache curl`. Debian: `apt-get install -y curl`.

Fresh project with pinned python:

```
podman_exec {"container": "box", "command": "cd /root && uv init app && cd app && uv python install 3.12 && uv add requests"}
```

Run inside project env:

```
podman_exec {"container": "box", "command": "cd /root/app && uv run python -c 'import requests; print(requests.__version__)'"}
```

One-off tool, no install:

```
podman_exec {"container": "box", "command": "uvx ruff --version"}
```

uv cache live in `~/.cache/uv` inside container. Cold each new box: budget big installs accordingly.
