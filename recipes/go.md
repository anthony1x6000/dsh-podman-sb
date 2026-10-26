# go

Go toolchain, official tarball. Pin version, x86_64 linux:

```
podman_exec {"container": "box", "command": "curl -fsSL https://go.dev/dl/go1.25.4.linux-amd64.tar.gz | tar -C /usr/local -xz && ln -sf /usr/local/go/bin/go /usr/local/bin/go && ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt"}
```

Other arch: swap `linux-amd64` for host arch (`uname -m` → `linux-arm64` for aarch64).

Verify:

```
podman_exec {"container": "box", "command": "go version"}
```

New module, build:

```
podman_exec {"container": "box", "command": "cd /root && go mod init hello && printf 'package main\\nimport \\\"fmt\\\"\\nfunc main() { fmt.Println(\\\"hi\\\") }\\n' > main.go && go build ./... && ./hello"}
```

Module cache live in `/root/go` inside container, cold each new box.
