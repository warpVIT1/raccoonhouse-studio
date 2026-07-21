# RaccoonHouse online power-share signaling

A small Cloudflare Worker + Durable Object that lets two RaccoonHouse
instances find each other over the internet (not just LAN/VPN mesh) for the
Power Share feature. It only ever sees:

- who's currently online, and their public IP (learned from the connection
  itself via Cloudflare's `CF-Connecting-IP` header — no self-IP-detection
  needed on the client)
- tiny consent-request/response messages between two specific peers

The actual separation job's file upload still goes **directly** PC-to-PC
over plain HTTP (see `backend/services/power_share_service.py`) — this
Worker never sees that traffic, and structurally couldn't handle it anyway
(Workers have per-request CPU/duration limits that make them a poor fit for
relaying multi-gigabyte video files).

This does **not** solve NAT traversal. If the receiving PC's router blocks
unsolicited incoming connections (no port forwarding / UPnP), the direct
file upload still won't connect even after both sides find each other here.

## Deploy

Needs a free Cloudflare account (no card required for the Workers free
tier).

```sh
cd cloudflare-signaling
npm install
npx wrangler login          # opens a browser to authorize once
npx wrangler deploy
```

Wrangler prints the deployed URL, e.g.
`https://raccoonhouse-signaling.<your-subdomain>.workers.dev` — the app
needs it as `wss://raccoonhouse-signaling.<your-subdomain>.workers.dev/`
(note `wss://`, not `https://`) in Settings → Power Share → online
signaling URL, on every instance that should use it.

## Local development

```sh
npm run dev
```

Starts a local copy at `ws://127.0.0.1:8787/` — point a dev build's
`online_signaling_url` setting at that to test without deploying.

## Protocol

Client → Worker:
```json
{"type": "hello", "name": "...", "port": 8765, "gpu_name": "...", "vram_gb": 8, "power_share_enabled": true, "logged_in": true}
```

Worker → client, once per connection right after its first "hello":
```json
{"type": "welcome", "your_id": "..."}
```

Worker → all clients, whenever the online set changes:
```json
{"type": "peers", "peers": [{"id": "...", "host": "1.2.3.4", "port": 8765, "name": "...", ...}]}
```

Client → Worker → target peer (small messages only):
```json
{"type": "relay", "target_id": "...", "payload": {...}}
```
