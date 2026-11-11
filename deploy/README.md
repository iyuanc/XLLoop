# XLLoop CentOS self-hosted deployment

For routine deployments after the one-time server setup, run the root-level
script as root. It detects the project directory automatically, installs from
the lockfile, builds, restarts PM2, saves its process list, and checks port
3100:

```bash
bash deploy.sh
```

This deployment runs the web application as a single Node.js process managed by
PM2. Nginx terminates HTTPS and proxies only to `127.0.0.1:3100`. The Python
executor listens only on `127.0.0.1:8788`. MySQL must not expose port 3306 to
the public network.

## 1. Verify prerequisites

```bash
node --version
pnpm --version
python3.14 --version
nginx -v
mysql --version
command -v node pnpm pm2 python3.14 nginx mysql curl
```

The source requires Node.js 22.13 or newer and pnpm 11.25.0. Install PM2 once
if it is not already available:

```bash
npm install --global pm2
pm2 --version
```

Use a dedicated operating-system account. PM2 stores its process list under
this account's home directory, so it needs a real writable home even though
interactive login is disabled.

```bash
useradd --system --create-home --home-dir /home/xlloop --shell /sbin/nologin xlloop
install -d -o xlloop -g xlloop -m 750 \
  /opt/xlloop/app/releases \
  /srv/xlloop/worktrees \
  /var/lib/xlloop \
  /var/log/xlloop
install -d -o root -g xlloop -m 750 /opt/xlloop/runner
install -d -o root -g xlloop -m 750 /etc/xlloop
```

## 2. Prepare MySQL

Create the database and tables using the versioned SQL in `deploy/sql/`. Run
schema changes with an administrative migration account. Create the dedicated
`xlloop_app` runtime account through your normal secure MySQL administration
process and grant it only `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on
`xlloop.*`; it does not need DDL or global privileges. Keep MySQL on loopback
or a private network and never place its password in a committed SQL file.
Confirm `max_allowed_packet` is comfortably above XLLoop's 1.8 MB request
payload limit (2 MB or more; the normal MySQL 8 default is already larger).

Apply the SQL files in lexical order. Do not replay a migration that has
already succeeded.

```bash
mysql -u <migration-admin> -p < deploy/sql/001_core.sql
mysql -u <migration-admin> -p xlloop < deploy/sql/002_auth.sql
```

## 3. Configure secrets

Install the examples, replace every placeholder through a secure editor, and
restrict access. Never commit the completed files.

```bash
install -o root -g xlloop -m 640 deploy/app.env.example /etc/xlloop/app.env
install -o root -g xlloop -m 640 deploy/runner.env.example /etc/xlloop/runner.env
install -o root -g xlloop -m 640 executor/config.example.json /etc/xlloop/runner-config.json
```

Configure a separate worktree and fixed command array for every authorized
project in `/etc/xlloop/runner-config.json`. Never turn request text into a
shell command. Keep the runner token identical in both environment files.

For Claude development, prepare `/srv/xlloop/worktrees/ybirds` as an independent
clone or isolated checkout whose branch starts with `xlloop/`; do not point it
at `master`. Keep it clean before dispatching a development task. Fill
`ANTHROPIC_API_KEY`, task-specific model names and current official per-token
rates in `/etc/xlloop/runner.env`. Configure validation as a fixed JSON argument
array, for example:

```bash
XLLOOP_CHECK_COMMANDS_JSON='{"build":["pnpm","build"]}'
XLLOOP_REQUIRED_DEVELOP_CHECKS=build
XLLOOP_ALLOWED_BRANCHES=xlloop/ybirds
```

The bundled adapter can edit only that checkout and cannot commit, push, switch
branches or deploy. Review is read-only. A separate operator action in the web
console can commit and push the configured `xlloop/*` branch after inspection;
merge and deployment remain separate approvals.

### Configure multiple GitLab repositories per project

The project technical console can register more than one repository. Repository
credentials are not stored in XLLoop: install a read-write GitLab Deploy Key or
a dedicated service-account SSH key for the `xlloop` operating-system account,
protect `main` and `master` against direct pushes in GitLab, and verify the SSH
host key separately. Prefer a service account when audit attribution matters.
The executor accepts only hosts listed under `provisioning.allowed_git_hosts`
in `/etc/xlloop/runner-config.json` and writes its dynamic registry to
`/var/lib/xlloop/projects.json`.

After deploying this version, open the project and use **More → Technical
configuration → Code repositories**. Add each clone URL, base branch,
`xlloop/` work branch, access level and check names, save, then select
**Pull / synchronize to executor**. Check names refer to fixed arrays in
`XLLOOP_CHECK_COMMANDS_JSON`; they are not shell text supplied by the browser.
Each checkout is created below:

```text
/srv/xlloop/worktrees/<project-id>/<repository-id>
```

The synchronization refuses embedded credentials, unapproved Git hosts,
protected work branches, mismatched existing remotes and existing checkouts on
another branch with pending changes. It never deletes a removed checkout
automatically. After Claude produces a checked diff, enter a one-line Chinese
commit message and select **Commit and push new branch**. The gateway rechecks
the exact remote and branch, rejects read-only repositories and existing remote
branches, creates one commit, and pushes only `HEAD:refs/heads/xlloop/...`.
It never merges or deploys. For another change cycle, configure a new `xlloop/*`
branch and synchronize again.

Because the systemd sandbox hides home directories, keep the deploy key and the
verified GitLab host key outside `/home` and reference them from
`/etc/xlloop/runner.env`:

```bash
install -o root -g xlloop -m 640 <deploy-key> /etc/xlloop/gitlab_deploy_key
install -o root -g xlloop -m 640 <verified-known-hosts> /etc/xlloop/git_known_hosts
```

```dotenv
GIT_SSH_COMMAND="/usr/bin/ssh -i /etc/xlloop/gitlab_deploy_key -o IdentitiesOnly=yes -o UserKnownHostsFile=/etc/xlloop/git_known_hosts"
```

Verify the GitLab SSH fingerprint through your infrastructure process before
installing `git_known_hosts`; do not accept an unverified key from an automated
first connection.

## 4. Build a release

Build in a versioned release directory. `postbuild` copies `public/` and
`.next/static/` into the standalone output expected by PM2.
Upload the source and lockfile, then build on CentOS; do not transfer a
Windows-generated `.next` directory because its traced dependencies and
filesystem links are platform-specific.

```bash
chown -R xlloop:xlloop /opt/xlloop/app/releases/<release-id>
sudo -u xlloop -H bash -lc '
  cd /opt/xlloop/app/releases/<release-id>
  pnpm install --frozen-lockfile
  pnpm build
'
ln -sfn /opt/xlloop/app/releases/<release-id> /opt/xlloop/app/current
chown -h xlloop:xlloop /opt/xlloop/app/current
```

Keep at least one previous release until acceptance is complete.

### Initialize the owner account once

After applying `002_auth.sql`, create the first local owner account. Read the
temporary password without echoing it or placing it in shell history; the
account is forced to change it after the first login. Replace the example
email with the exact `XLLOOP_OWNER_EMAIL` value in `/etc/xlloop/app.env`.

```bash
cd /opt/xlloop/app/current
read -r -s -p 'Temporary owner password: ' XLLOOP_ADMIN_PASSWORD
echo
export XLLOOP_ADMIN_PASSWORD
node --env-file=/etc/xlloop/app.env scripts/auth-admin.mjs create-owner \
  --email owner@example.com --name 'XLLoop administrator'
unset XLLOOP_ADMIN_PASSWORD
```

For an operator-approved password recovery, use the same protected input flow
with `reset-owner-password`. It revokes all current sessions for that owner and
requires another password change at the next login:

```bash
read -r -s -p 'New temporary owner password: ' XLLOOP_ADMIN_PASSWORD
echo
export XLLOOP_ADMIN_PASSWORD
node --env-file=/etc/xlloop/app.env scripts/auth-admin.mjs \
  reset-owner-password --email owner@example.com
unset XLLOOP_ADMIN_PASSWORD
```

There is no public registration endpoint. To provision a company member, the
owner first grants that email access in XLLoop, then an operator creates the
login account with a temporary password. Use the same hidden password input
and export flow shown above:

```bash
read -r -s -p 'Temporary member password: ' XLLOOP_ADMIN_PASSWORD
echo
export XLLOOP_ADMIN_PASSWORD
node --env-file=/etc/xlloop/app.env scripts/auth-admin.mjs create-user \
  --email member@example.com --name 'Company member'
unset XLLOOP_ADMIN_PASSWORD
```

Use `reset-password --email member@example.com` for member password recovery.
Both commands force a password change on the next login, and password reset
revokes all existing sessions for that account.

## 5. Start the web application with PM2

The ecosystem file uses one forked process. Do not enable PM2 cluster mode
until multi-instance Next.js caches, server-action encryption keys, and
background coordination have been tested explicitly. Always run the PM2
application and `pm2 save` as the unprivileged `xlloop` account, never as
root; root is used only to install the generated systemd startup unit.

```bash
sudo -u xlloop -H pm2 start /opt/xlloop/app/current/deploy/ecosystem.config.cjs
sudo -u xlloop -H pm2 save
pm2 startup systemd -u xlloop --hp /home/xlloop
```

Run the exact privileged command printed by `pm2 startup`, then save the
process list again:

```bash
sudo -u xlloop -H pm2 save
sudo -u xlloop -H pm2 status
curl --fail --show-error --head http://127.0.0.1:3100/login
```

After a new release:

```bash
sudo -u xlloop -H pm2 restart xlloop-web --update-env
install -o root -g xlloop -m 750 \
  /opt/xlloop/app/current/executor/runner.py \
  /opt/xlloop/runner/runner.py
systemctl restart xlloop-runner.service
```

PM2's startup integration records the absolute Node and PM2 paths. Regenerate
the startup integration after changing the system Node installation.

## 6. Start the isolated executor

```bash
install -o root -g xlloop -m 750 \
  /opt/xlloop/app/current/executor/runner.py \
  /opt/xlloop/runner/runner.py
cp deploy/systemd/xlloop-runner.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now xlloop-runner.service
systemctl status xlloop-runner.service --no-pager
```

The executor port must remain private:

```bash
ss -lntp | grep 8788
```

The expected listener is `127.0.0.1:8788`, not `0.0.0.0:8788`.

## 7. Configure Nginx

Copy `deploy/nginx/xlloop.conf`, replace the example hostname and certificate
paths, then validate before reloading:

```bash
cp deploy/nginx/xlloop.conf /etc/nginx/conf.d/xlloop.conf
nginx -t
setsebool -P httpd_can_network_connect 1
systemctl reload nginx
# If this server uses firewalld:
firewall-cmd --permanent --add-service=http
firewall-cmd --permanent --add-service=https
firewall-cmd --reload
```

The sample limits only `POST /api/auth/login` by client IP (a sustained rate
of five requests per minute with a short burst allowance) and returns HTTP 429
when exceeded. Adjust that policy for trusted corporate proxies only after
confirming Nginx receives the real client IP; do not disable it or apply it
globally to every API.

Expose only HTTP/HTTPS (80/443; port 80 may be kept solely for redirect and
certificate validation). Do not expose ports 3100, 8788, or 3306.

## 8. Enable the hourly background heartbeat

Enable this only after the owner account is initialized and a manual heartbeat
has passed. The timer does not restart a project that was explicitly stopped;
the application persists and enforces that state.

```bash
cp deploy/systemd/xlloop-autonomy.service /etc/systemd/system/
cp deploy/systemd/xlloop-autonomy.timer /etc/systemd/system/
systemctl daemon-reload
systemctl start xlloop-autonomy.service
journalctl -u xlloop-autonomy.service -n 50 --no-pager
systemctl enable --now xlloop-autonomy.timer
systemctl list-timers xlloop-autonomy.timer
```

## 9. Logs and rollback

```bash
sudo -u xlloop -H pm2 logs xlloop-web --lines 100
journalctl -u xlloop-runner.service -n 100 --no-pager
journalctl -u xlloop-autonomy.service -n 100 --no-pager
```

To roll back, repoint `/opt/xlloop/app/current` to the previous tested release
and restart `xlloop-web`. Database migrations require a separately reviewed
rollback or forward-fix; never roll schema state back by replacing application
files alone.

Back up MySQL with an InnoDB-consistent procedure and back up
`/var/lib/xlloop/jobs.sqlite`. Test restoration before production acceptance.
