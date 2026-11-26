# Deploying the backend (AWS server)

The server is small (1 GB of memory). These steps keep the site up while the new version goes in, check it before it replaces the
old one, and go back to the old one on their own if the new one does not answer.

## Every deploy

**On the Mac** (backend folder):

```bash
bash scripts/makeDeployZip.sh
```

It first checks that the backend would start (`npm run check`) — nothing is zipped if it would not — then makes
`~/Downloads/backend-deploy-<date-time>.zip`. The zip never contains `.env` files, `node_modules`, `tmp/` (customer CSVs) or `tests/`.

Upload that zip to the server's home folder (`/home/ubuntu`), the same way as before.

**On the server** (the AWS black screen, prompt `ubuntu@ip-…`):

```bash
bash ~/Nizan_ERP_CRM/backend/scripts/serverDeploy.sh ~/backend-deploy-YYYYMMDD-HHMM.zip
```

It unpacks the new version next to the live one, copies the server's `.env` in, installs packages only if they changed (stopping the
app first, to free memory), checks the new version, switches over, and waits for the API to answer. If it does not answer within
40 seconds it switches back to the previous version by itself and tells you. When it says **✔ Deployed**, you are done.

If it says **another program is using the port**, nothing was switched: a second copy of the backend is running (started by hand, or
under another PM2 name). `pm2 ls` shows it; remove the extra one with `pm2 delete <its name>` and run the deploy again. A **⚠** line at
the start means a one-time step below is still missing.

Do **not** use the old way any more (`rm -rf backend`, `unzip`, `npm install` while the app runs): it removes the only working copy,
and `npm install` next to the running app can freeze this machine.

## Going back by hand

```bash
bash ~/Nizan_ERP_CRM/backend/scripts/serverDeploy.sh --rollback
```

The version before is always kept as `~/Nizan_ERP_CRM/backend.prev` (and a version that failed its check after switching as
`backend.failed`). Running `--rollback` again switches forward again.

## One-time setup (do these once)

1. **The first deploy with this kit** — the server does not have the script yet, so take it out of the zip first:

   ```bash
   unzip -o -j ~/backend-deploy-YYYYMMDD-HHMM.zip backend/scripts/serverDeploy.sh -d ~ && bash ~/serverDeploy.sh ~/backend-deploy-YYYYMMDD-HHMM.zip
   ```

   From then on the script is inside the backend folder (`~/Nizan_ERP_CRM/backend/scripts/serverDeploy.sh`).

2. **Swap** (spare memory on disk, so a busy moment slows the server down instead of freezing it):

   ```bash
   sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
   ```

3. **Start the backend again after a reboot** (without this a reboot leaves the site down):

   ```bash
   sudo env PATH=$PATH pm2 startup systemd -u ubuntu --hp /home/ubuntu && pm2 save
   ```

4. **Let the gallery play videos straight from Dropbox** (so they no longer pass through this small server). The Dropbox app needs
   one more permission:
   - Dropbox App Console → the CRM's app → **Permissions** → tick **files.content.read** → **Submit**.
   - On the Mac (backend folder): `node scripts/dropboxConnect.mjs` — the company Dropbox account clicks **Allow** once more.
   - Copy the three `DROPBOX_` lines from the Mac's `backend/.env` into the server's `~/Nizan_ERP_CRM/backend/.env` (replace the old
     ones), then `pm2 restart nizan-backend --update-env`.

   Until this is done the videos still play — through the server, as before.

## Good to know

- PM2 runs the backend with `ecosystem.config.cjs`: it restarts it before it can use up the machine's memory (450 MB) and waits
  longer between restarts if it keeps crashing.
- Health check by hand: `curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5001/api/projects` → **401** means it is up. (The
  port is `PORT=` in the server's `.env` — 5001 on this server; the deploy script reads it from there.)
- If a deploy ever leaves the API on **502** with `Cannot find package … node_modules/…` in `pm2 logs`, the packages are incomplete:
  `pm2 stop nizan-backend && cd ~/Nizan_ERP_CRM/backend && npm ci --omit=dev && pm2 restart nizan-backend`.
- Logs: `pm2 logs nizan-backend --lines 80`.
- Gallery videos: the company's own Dropbox videos (mp4/m4v/webm) play straight from Dropbox. Anyone else's links and .mov files come
  through the server, which keeps at most 256 MB of copies (`MEDIA_CACHE_MAX_MB`), makes none while the disk has less than 1.5 GB
  free, and passes on at most 6 videos at once (`MEDIA_MAX_STREAMS`); a 7th viewer is told "busy" and the app tries Dropbox itself.
- Check the code on the Mac at any time: `npm run check`.
