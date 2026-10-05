# Castify Server

Backend for the **Castify** Chrome extension: a claim-sync API plus a dark,
compact admin dashboard. One Node.js process, one SQLite file — built to run
cheaply on a VPS.

- `server.js` — Express API + static dashboard (`public/`)
- `public/` — dependency-free dashboard (login, stats, claims table, users admin)
- `Dockerfile` / `docker-compose.yml` — VPS deployment

## Quick start (local)

```bash
cd ~/workspace/castify/server
npm install
cp .env.example .env
# edit .env and set a strong JWT_SECRET:
#   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
npm start
```

Open http://localhost:3001 — on first run the server creates a default admin
and prints a **big warning** with the credentials:

- email: `admin@castify.local`
- password: `changeme123`

**Change that password immediately** (dashboard → Users tab → create your real
admin, then delete the default — or just create users and keep it; either way,
don't keep the default password).

## VPS deploy (Docker)

On the server (needs Docker + the compose plugin):

```bash
# copy this folder to the VPS, then:
cp .env.example .env        # set JWT_SECRET to a long random string
docker compose up -d --build
docker compose logs -f      # watch the first-run admin warning
```

- Data persists in `./data/castify.db` (mounted volume — back this file up).
- **Reverse proxy (recommended):** put Caddy or nginx in front for HTTPS and
  expose the dashboard on a subdomain. Minimal Caddy example:

  ```
  castify.example.com {
      reverse_proxy 127.0.0.1:3001
  }
  ```

  Never expose the API over plain HTTP with real credentials/tokens.

## Creating users (admin)

1. Sign in to the dashboard as an admin.
2. Open the **Users** tab → fill the form (name, email, password ≥ 8 chars,
   role `user` or `admin`) → Create.
3. Share the email + password with the team member; they sign in and the
   dashboard shows only **their own** synced claims. Admins see everyone's.

## Connecting the Chrome extension

The extension syncs to `POST /api/claims/batch` with a Bearer JWT.

1. Sign in to the dashboard (as the user who will run the extension).
2. Click **Copy API token** (top-right). This copies the JWT (valid 12 hours).
3. In the extension, open **Options → Backend** and set:
   - **Backend URL** → e.g. `https://castify.example.com` (no trailing slash)
   - **API token** → paste the token.
4. The extension's next sync pushes billed / unbilled / queued claims to the
   server, idempotently keyed on `(user, claim id)`.

> Tokens expire after 12h. When sync starts failing with "Invalid or expired
> token", just sign in to the dashboard again and copy a fresh token.

## API reference (JSON, `Authorization: Bearer <token>`)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/login` | `{email,password}` → `{token, user}` (rate-limited: 10/min) |
| POST | `/api/admin/users` | admin only — `{email,password,name,role}` |
| GET | `/api/admin/users` | admin only — user list, **no password hashes** |
| DELETE | `/api/admin/users/:id` | admin only — cannot delete self; also removes their claims |
| POST | `/api/claims/batch` | `{billed:[], unbilled:[], claims:[]}` — idempotent upsert |
| GET | `/api/claims/summary?days=30` | counts + $ + breakdowns by center/payer/CPT |
| GET | `/api/claims?status=&payer=&center=&q=&limit=&offset=` | paginated claim list |
| GET | `/api/health` | `{ok:true}` |

Batch item fields: `claimId` (or `id`) → `ext_id`, `patient`, `mrn`, `payer`,
`memberId`, `center`, `serviceDate`, `cpt`, `units`, `charges`, plus
`status`/`tcn`/`reason`/`step`/`note` depending on the array. A claim already
recorded as `billed`/`unbilled` is never downgraded back to `ready`.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | HTTP listen port |
| `JWT_SECRET` | *(none — dev fallback with warning)* | Token signing secret; **set in production** |
| `DB_PATH` | `./data/castify.db` | SQLite file location |
