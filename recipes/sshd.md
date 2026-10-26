# sshd

SSH server in container, host reach it with plain ssh client. Handy for tools that speak ssh, or for human to poke around.

Create container with extra port publish first. Pick host port not in VNC/noVNC ranges, say 2222:

```
podman_create {"name": "sshbox", "image": "debian", "ports": ["127.0.0.1:2222:22"], "ttl_minutes": 60}
```

Install + configure sshd:

```
podman_exec {"container": "sshbox", "command": "apt-get update && apt-get install -y openssh-server && mkdir -p /run/sshd && echo 'PermitRootLogin prohibit-password' >> /etc/ssh/sshd_config"}
```

No root password in container, key only. Drop public key from host into container with podman_cp, then install it:

```
podman_cp {"to_container": true, "src": "/home/virt/.ssh/id_ed25519.pub", "dst": "sshbox:/root/key.pub"}
```

```
podman_exec {"container": "sshbox", "command": "mkdir -p /root/.ssh && mv /root/key.pub /root/.ssh/authorized_keys && chmod 700 /root/.ssh && chmod 600 /root/.ssh/authorized_keys"}
```

Start sshd, no systemd needed:

```
podman_exec {"container": "sshbox", "command": "/usr/sbin/sshd && ss -tlnp | grep :22"}
```

From host:

```
ssh -i /home/virt/.ssh/id_ed25519 -p 2222 -o StrictHostKeyChecking=accept-new root@127.0.0.1
```

sshd die when container TTL end, same as everything else. Restart after container stop: rerun `/usr/sbin/sshd` (mkdir /run/sshd again, tmpfs).
