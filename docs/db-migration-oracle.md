# Migrating prod MongoDB from Atlas M0 to a self-hosted Oracle VM

Both `dev` (Vercel) and prod (Oracle Cloud VPS via Coolify, see
`docs/cron-setup.md`) currently point at the same MongoDB Atlas **M0
free-tier** cluster. This doc covers moving **prod only** to a dedicated,
self-hosted MongoDB instance on a second Oracle Cloud "Always Free" VM.
`dev` stays on Atlas M0 - Vercel serverless functions don't have a fixed
outbound IP, so a self-hosted Mongo reachable from dev would have to accept
a broad/unpredictable IP range, defeating the point of an IP allowlist.

A brief (few-minute) downtime window during cutover is acceptable - this is
a straightforward dump/restore/switch, not a live/dual-write migration.

## 1. Provision the new Oracle VM

- Create a **second** Ampere A1 "Always Free" instance (e.g. 2 OCPU / 12 GB
  - Oracle's Always Free tier allows up to 4 OCPU / 24 GB total across
  Ampere instances, so this leaves headroom), Ubuntu 22.04/24.04 LTS.
  Keep it separate from the existing app VPS - dedicated resources, blast
  radius isolated from the app.
- In the VM's subnet Security List / Network Security Group: allow inbound
  TCP `27017` **only** from the existing prod app VPS's public IP, plus
  (temporarily) your own IP for setup. Do not open it to `0.0.0.0/0`.
- Restrict SSH (`22`) the same way.
- Mirror the same allowlist in the VM's own `ufw` as defense-in-depth:
  ```
  ufw allow from <app-vps-ip> to any port 27017 proto tcp
  ufw allow from <your-ip> to any port 22 proto tcp
  ufw enable
  ```

## 2. Install and harden MongoDB

- Install MongoDB Community Server from the official Ubuntu apt repo (7.0
  or 8.0 line - compatible with `mongoose ^9.0.0`, per `package.json`).
- `/etc/mongod.conf`:
  - `security.authorization: enabled`
  - `net.bindIp: <private-ip>,<public-ip>` (never `0.0.0.0`)
  - TLS enabled for connections in transit - use a real cert on a subdomain
    (e.g. `db.docwellness.fit` pointed at this VM) rather than a
    self-signed cert with verification disabled, since this DB holds PHI.
- Create users:
  - An admin user for maintenance.
  - A least-privilege app user scoped to the `docwellness` database only
    (`readWrite` on that DB, not a root/admin role) - this is the one
    `MONGODB_URI` will authenticate as.
- Confirm the apt package's systemd unit (`mongod.service`) is enabled so
  it survives reboots/crashes: `systemctl enable --now mongod`.

## 2a. TLS (private CA)

Since this is a private, non-publicly-reachable instance, a public CA (Let's
Encrypt) isn't obtainable - it requires a public HTTP-01 challenge. Instead,
generate your own private CA on the VM and sign a server cert for it,
covering both the instance's internal FQDN and private IP as SANs:

```bash
sudo mkdir -p /etc/mongodb-tls && cd /etc/mongodb-tls
sudo openssl genrsa -out ca.key 4096
sudo openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 \
  -subj "/CN=DocWellness Internal CA" -out ca.crt
sudo openssl genrsa -out server.key 2048
sudo openssl req -new -key server.key -subj "/CN=<internal-fqdn>" -out server.csr
sudo tee server_ext.cnf > /dev/null << 'EOF'
subjectAltName = DNS:<internal-fqdn>,IP:<private-ip>
EOF
sudo openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -days 1825 -sha256 -extfile server_ext.cnf
sudo bash -c 'cat server.key server.crt > server.pem'
sudo chown -R mongodb:mongodb /etc/mongodb-tls
sudo chmod 600 /etc/mongodb-tls/*.key /etc/mongodb-tls/server.pem
sudo chmod 644 /etc/mongodb-tls/ca.crt
```

Add to `/etc/mongod.conf`'s `net` section:
```yaml
  tls:
    mode: requireTLS
    certificateKeyFile: /etc/mongodb-tls/server.pem
    CAFile: /etc/mongodb-tls/ca.crt
    allowConnectionsWithoutCertificates: true
```
The last line matters - without it, `net.tls.CAFile` also makes the server
demand a *client* certificate (mutual TLS), which isn't what we want here;
auth is handled by SCRAM username/password, not certs. Restart `mongod`
after editing.

**Getting the CA into the app**: the app (`config/database.js`) reads an
optional `MONGODB_TLS_CA_BASE64` env var and writes it to a temp file at
connect time, passed as `tlsCAFile`. Get the CA cert's contents (not the
key - `ca.crt` is safe to share, it's the public cert) onto the app side by
base64-encoding it on the Mongo VM and pasting the result into Coolify's
environment variables for the prod resource, e.g.:
```bash
base64 -w0 /etc/mongodb-tls/ca.crt
```
Set that output as `MONGODB_TLS_CA_BASE64` in Coolify, alongside the new
`MONGODB_URI` (see cutover section below). Dev stays on Atlas and never
sets this var - `config/database.js` falls back to plain (non-custom-CA)
options whenever it's unset.

## 3. Backups

Atlas's automatic backups go away once self-hosted - replace them:

- Daily `mongodump` cron on the new VM, compressed, shipped off-box (e.g.
  Oracle Object Storage's Always-Free 20 GB tier via `oci os object put`,
  or another off-box destination). Never leave the only backup copy on the
  same disk as the live data.
- Retention: e.g. 7 daily + 4 weekly.
- **Actually test a restore** before relying on this in an incident.

## 4. Migrate the data and cut prod over

1. `mongodump` prod data from the current Atlas `MONGODB_URI`.
2. `mongorestore` into the new self-hosted instance.
3. Verify collection/document counts match between source and target.
4. During the accepted short downtime window:
   - Briefly stop prod traffic (or accept failed requests for the window).
   - Take one final dump/restore pass to catch any writes since step 1.
   - Update `MONGODB_URI` in the **Coolify UI** (prod resource's
     environment variables) to the new connection string:
     `mongodb://appuser:<password>@<new-vm-host>:27017/docwellness?tls=true&authSource=docwellness`
   - Also set `MONGODB_TLS_CA_BASE64` there (see step 2a) - without it,
     `config/database.js` won't pass `tlsCAFile` and the connection will
     fail TLS verification.
   - Restart the Coolify resource.
5. Confirm the switch via the existing `MongoDB Connected: <host>` log line
   (`config/database.js:107`) in the Coolify logs - it should now print the
   new VM's host instead of the Atlas cluster host.
6. Run `scripts/maintenance/ensure-indexes.js` against the new instance -
   `mongorestore` only recreates indexes present in the dump at dump time,
   and `RELEASE_CHECKLIST.md` already flags index verification as
   previously unconfirmed against real prod data.

## 5. Post-migration validation

- Exercise the app end-to-end against the new DB (login, meal log, chat).
- Confirm the two prod cron sweeps still fire (`docs/cron-setup.md`'s
  `renewal-reminders` and `goal-nudges`) - no code change needed, they use
  the same `MONGODB_URI`-based connection.
- Watch `mongod` logs and VM resource usage (`htop`, `free -h`) for a few
  days after cutover.
- Keep the Atlas cluster available (paused, not deleted) as a rollback
  fallback for 1-2 weeks before fully decommissioning it.

## Rotation after this migration

See the updated MongoDB rotation entry in `docs/SECURITY.md` - prod
rotation is now done via SSH + `mongosh` against this VM, not the Atlas
dashboard.
