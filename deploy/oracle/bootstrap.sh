#!/usr/bin/env bash
# Orin Router — one-shot host bootstrap for an Oracle Cloud Always Free VM.
#
# Run as root on a freshly created Ubuntu 22.04 / 24.04 instance:
#   sudo bash bootstrap.sh
#
# It is idempotent: re-running it is safe. It never writes secrets for you.

set -euo pipefail

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$1"; }

if [[ $EUID -ne 0 ]]; then
  echo "Run this as root: sudo bash bootstrap.sh" >&2
  exit 1
fi

log "System user and deploy directory"
id -u orin >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/orin --shell /usr/sbin/nologin orin
install -d -o orin -g orin -m 0750 /opt/orin/router

log "Base packages and security updates"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg git ufw fail2ban unattended-upgrades \
  python3 python3-software-properties software-properties-common
apt-get upgrade -y

log "Docker Engine from the official repository"
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y --no-install-recommends \
  docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

log "Host firewall"
# SSH stays reachable; everything else is only reachable through Caddy.
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp comment 'HTTP for TLS challenge'
ufw allow 443/tcp comment 'HTTPS'
ufw allow 443/udp comment 'HTTP/3'
ufw --force enable

log "Unattended security upgrades"
cat > /etc/apt/apt.conf.d/51orin-unattended <<'CONF'
Unattended-Upgrade::Allowed-Origins {
  "${distro_id}:${distro_codename}-security";
  "${distro_id}:${distro_codename}-updates";
};
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "03:00";
CONF

log "fail2ban for sshd"
cat > /etc/fail2ban/jail.d/orin-sshd.local <<'CONF'
[sshd]
enabled = true
maxretry = 5
findtime = 10m
bantime = 1h
CONF
systemctl enable --now fail2ban

log "Kernel tweaks for a long-lived API workload"
cat > /etc/sysctl.d/60-orin.conf <<'CONF'
# Accept legitimate API bursts without dropping them.
net.core.somaxconn = 4096
net.ipv4.tcp_max_syn_backlog = 4096
# Keep a lot of idle client sockets (streaming chat) alive.
net.ipv4.tcp_fin_timeout = 30
net.ipv4.ip_local_port_range = 10240 65535
# Do not advertise the host's memory layout.
kernel.randomize_va_space = 2
CONF
sysctl --system >/dev/null

log "Done"
cat <<'NEXT'

Next steps:

  1. Copy the repo onto this host:
       sudo -u orin git clone https://github.com/januththedev/orin-router-service /opt/orin/router/src
  2. Create the environment file:
       sudo -u orin cp /opt/orin/router/src/deploy/oracle/router.env.example /opt/orin/router/router.env
       sudo -u orin nano /opt/orin/router/router.env
       sudo chmod 600 /opt/orin/router/router.env
  3. Start the service:
       cd /opt/orin/router/src && sudo docker compose up -d --build
  4. Check it:
       curl -fsS http://127.0.0.1:8080/health

Follow deploy/oracle/README.md for DNS, TLS, and the database migration.
NEXT
