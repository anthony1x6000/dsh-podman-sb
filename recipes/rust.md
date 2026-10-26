# rust

Rust toolchain through rustup.

Install:

```
podman_exec {"container": "box", "command": "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal"}
```

Put cargo on PATH for later exec:

```
podman_exec {"container": "box", "command": "ln -sf /root/.cargo/bin/* /usr/local/bin/"}
```

Verify:

```
podman_exec {"container": "box", "command": "rustc --version && cargo --version"}
```

New project, build, run:

```
podman_exec {"container": "box", "command": "cd /root && cargo new hello && cd hello && cargo run"}
```

Need linker: dev-basics recipe first (`build-base` / `build-essential`). Rust compile eat CPU and RAM: check `podman_host_resources`, give container cpus/memory at create time.
