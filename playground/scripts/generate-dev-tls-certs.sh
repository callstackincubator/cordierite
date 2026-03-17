#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="$ROOT/certs"
mkdir -p "$CERT_DIR"

KEY="$CERT_DIR/dev-key.pem"
CRT="$CERT_DIR/dev-cert.pem"

if openssl req -help 2>&1 | grep -q -- '-addext'; then
  openssl req -x509 -newkey rsa:2048 \
    -keyout "$KEY" \
    -out "$CRT" \
    -days 825 -nodes \
    -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
else
  CFG="$(mktemp)"
  trap 'rm -f "$CFG"' EXIT
  cat >"$CFG" <<'EOF'
[req]
distinguished_name = dn
x509_extensions = v3_req
prompt = no

[dn]
CN = localhost

[v3_req]
subjectAltName = @san

[san]
DNS.1 = localhost
IP.1 = 127.0.0.1
EOF
  openssl req -x509 -newkey rsa:2048 \
    -keyout "$KEY" \
    -out "$CRT" \
    -days 825 -nodes \
    -config "$CFG" \
    -extensions v3_req
fi

echo "Wrote $CRT and $KEY"
