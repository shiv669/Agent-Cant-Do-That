# Deployment Guide

**Live URL:** https://agent-cant-do-that.vercel.app

This document explains how the project is deployed to production using **DigitalOcean** (backend) + **Vercel** (frontend).

---

## Architecture Overview

```
Browser
  └──▶ Vercel (Next.js Console)
         └──▶ DigitalOcean Droplet (via HTTPS / Caddy)
                ├── NestJS API          (pm2, port 4001)
                ├── Temporal Worker     (pm2)
                ├── Temporal Server     (Docker, port 7233)
                ├── PostgreSQL          (Docker, port 5432)
                └── Redis               (Docker, port 6379)
```

SSE (Server-Sent Events) streams go **directly from the user's browser to the DigitalOcean API** — not through Vercel — so there are no serverless timeouts or buffering issues.

---

## Infrastructure

| Component | Provider | Cost |
|-----------|----------|------|
| Next.js Console | Vercel (free tier) | $0/mo |
| NestJS API + Worker | DigitalOcean Droplet $8/mo (Premium Intel, 2 GB RAM, NVMe SSD) | ~$8/mo |
| PostgreSQL | Docker on Droplet | included |
| Redis | Docker on Droplet | included |
| Temporal Server | Docker on Droplet | included |
| HTTPS certificates | Caddy + Let's Encrypt | free |
| Domain | DuckDNS (free subdomain) | free |

> New DigitalOcean accounts receive **$200 in free credits**, covering this setup for over a year.

---

## Setting Up From Scratch

### Prerequisites
- A [DigitalOcean](https://digitalocean.com) account ($200 free credits on signup)
- A [Vercel](https://vercel.com) account (free)
- A [DuckDNS](https://www.duckdns.org) account (free subdomain for HTTPS)
- All Auth0 environment variables configured (see `.env.example`)

---

### Step 1 — Create the DigitalOcean Droplet

1. Go to **Create → Droplets** in the DigitalOcean dashboard
2. **Image:** Marketplace → **Docker on Ubuntu 22.04**
3. **Plan:** Premium Intel → **$8/mo** (1 vCPU, 2 GB RAM, 50 GB NVMe SSD)
4. **Region:** Closest to your users
5. **Authentication:** Password or SSH key
6. Click **Create Droplet** and note the public IP

---

### Step 2 — Initial Server Setup

SSH into the Droplet:
```bash
ssh root@YOUR_DROPLET_IP
```

Add swap (safety buffer for memory):
```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

---

### Step 3 — Clone the Repository

```bash
git clone https://github.com/shiv669/Agent-Cant-Do-That.git /root/app
cd /root/app
```

---

### Step 4 — Create the .env File

```bash
cp .env.example .env
nano .env
```

Fill in all required values from `.env.example`. Key production-specific values:

```env
NODE_ENV=production
PORT=4001
API_BASE_URL=http://localhost:4001
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agentcantdothat
REDIS_URL=redis://localhost:6379
TEMPORAL_ADDRESS=localhost:7233
TEMPORAL_NAMESPACE=default
DEMO_MODE_ENABLED=true
```

---

### Step 5 — Start Infrastructure with Docker Compose

Fix the database name to match the app's `DATABASE_URL`:
```bash
sed -i 's/POSTGRES_DB: acdt/POSTGRES_DB: agentcantdothat/' /root/app/docker-compose.yml
```

Start all containers (PostgreSQL, Redis, Temporal Server, Temporal UI):
```bash
docker compose up -d
```

Verify all 4 containers are running:
```bash
docker compose ps
```

---

### Step 6 — Install Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
```

---

### Step 7 — Install Dependencies and Build

```bash
cd /root/app
npm install
npm run build --workspace=apps/api
npm run build --workspace=apps/worker
```

> **Note:** The TypeScript build outputs to nested paths:
> - API: `apps/api/dist/apps/api/src/main.js`
> - Worker: `apps/worker/dist/index.js`

---

### Step 8 — Start API and Worker with pm2

```bash
npm install -g pm2

pm2 start /root/app/apps/api/dist/apps/api/src/main.js --name acdt-api
pm2 start /root/app/apps/worker/dist/index.js --name acdt-worker

pm2 save
pm2 startup
```

Verify the API is responding:
```bash
curl http://localhost:4001/api/health
# Expected: {"status":"ok","service":"api","timestamp":"..."}
```

---

### Step 9 — Bootstrap Demo Mode

Run this once after the API starts to initialize the demo token store:

```bash
curl -X POST http://localhost:4001/api/demo/admin/bootstrap-tokens \
  -H "x-demo-admin-key: YOUR_DEMO_ADMIN_KEY"
```

All three roles (`ops-manager`, `cfo`, `dpo`) should show `"available": true`.

> On Windows (local): `Invoke-RestMethod -Method Post -Uri "http://localhost:4001/api/demo/admin/bootstrap-tokens" -Headers @{ "x-demo-admin-key" = "YOUR_DEMO_ADMIN_KEY" }`

---

### Step 10 — Set Up HTTPS with Caddy

Get a free domain from [DuckDNS](https://www.duckdns.org):
1. Create a subdomain (e.g. `acdt-api`)
2. Point it to your Droplet IP → `acdt-api.duckdns.org`

Install Caddy:
```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

Configure Caddy (`/etc/caddy/Caddyfile`):
```
acdt-api.duckdns.org {
    reverse_proxy localhost:4001

    # SSE streams — disable buffering so events flow instantly
    @sse path /api/authority/ledger/*/stream
    handle @sse {
        reverse_proxy localhost:4001 {
            flush_interval -1
        }
    }
}
```

```bash
systemctl restart caddy
systemctl enable caddy
```

Caddy automatically provisions free Let's Encrypt TLS certificates. Test it:
```bash
curl https://acdt-api.duckdns.org/api/health
```

Open firewall ports:
```bash
ufw allow 80/tcp && ufw allow 443/tcp
```

---

### Step 11 — Deploy Console to Vercel

1. Go to [vercel.com](https://vercel.com) → **Add New Project** → Import this repo
2. Set **Root Directory** to `apps/console`
3. Add environment variables:

| Key | Value |
|-----|-------|
| `NEXT_PUBLIC_API_URL` | `https://acdt-api.duckdns.org` |
| `NEXT_PUBLIC_DEMO_MODE_ENABLED` | `true` |
| `AUTH0_DOMAIN` | Your Auth0 tenant domain |
| `AUTH0_CLIENT_ID` | Your console Auth0 client ID |
| `AUTH0_CLIENT_SECRET` | Your console Auth0 client secret |
| `AUTH0_SECRET` | A 32-byte random hex string |
| `AUTH0_AUDIENCE` | `https://agentcantdothat.api` |
| `APP_BASE_URL` | Your Vercel deployment URL |

4. Click **Deploy**

---

## Operations Reference

### Useful Commands (run on the Droplet)

```bash
# Process status
pm2 status

# View logs
pm2 logs acdt-api --lines 50
pm2 logs acdt-worker --lines 50

# Restart services
pm2 restart acdt-api
pm2 restart acdt-worker

# Docker containers
docker compose -f /root/app/docker-compose.yml ps
docker compose -f /root/app/docker-compose.yml restart

# Memory usage
free -h

# Re-bootstrap demo tokens (run if demo breaks)
curl -X POST http://localhost:4001/api/demo/admin/bootstrap-tokens \
  -H "x-demo-admin-key: YOUR_DEMO_ADMIN_KEY"

# Check demo status
curl http://localhost:4001/api/demo/admin/status \
  -H "x-demo-admin-key: YOUR_DEMO_ADMIN_KEY"
```

### Deploying Code Updates

```bash
cd /root/app
git pull origin main
npm install
npm run build --workspace=apps/api
npm run build --workspace=apps/worker
pm2 restart all
```

---

## Reliability Notes

- **pm2** restarts the API and Worker automatically if they crash, and survives server reboots via `pm2 startup`
- **Docker restart policies** (`unless-stopped`) keep Postgres, Redis, and Temporal running through reboots
- **Caddy `flush_interval -1`** on the SSE route ensures real-time event delivery with zero proxy buffering
- **CORS** is set to permissive (`origin: true`) in `apps/api/src/main.ts` — restrict to your Vercel domain in production hardening
