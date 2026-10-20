#!/usr/bin/env bash
# Throwaway CA + a leaf cert for 127.0.0.1, for the CIMD metadata server in the MCP e2e (SPEC §14 M11).
# Start the BE with NODE_EXTRA_CA_CERTS=<dir>/ca.pem; the e2e serves https with <dir>/leaf.{pem,key}.
#   gen-test-ca.sh <dir>
set -euo pipefail
d=${1:?usage: gen-test-ca.sh <dir>}
mkdir -p "$d"
cd "$d"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=mcp-e2e test CA' \
  -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign' \
  -keyout ca.key -out ca.pem 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj '/CN=127.0.0.1' -keyout leaf.key -out leaf.csr 2>/dev/null
printf 'subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n' > leaf.ext
openssl x509 -req -in leaf.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 2 -extfile leaf.ext -out leaf.pem 2>/dev/null
rm -f leaf.csr leaf.ext ca.srl ca.key
echo "$d/ca.pem"
