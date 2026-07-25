# RaccoonHouse online power-share signaling + transfer relay

A small Cloudflare Worker + Durable Object + R2 bucket that lets two
RaccoonHouse instances share power **entirely over the internet, with no
direct connection between them** — no shared LAN, no VPN mesh, no port
forwarding. Everything a Power Share job needs flows through this Worker:

- **Presence** — who's currently online, learned from the connection itself
  via Cloudflare's `CF-Connecting-IP` header (kept for logging only; it's no
  longer used to open a direct connection to a peer).
- **Consent** — the "can I borrow your PC?" request/response, relayed as a
  small WebSocket message between the two specific peers involved.
- **File transfer** — the actual audio/video, and the processed result
  coming back, both go through the `TRANSFERS` R2 bucket: the sender `PUT`s
  the file to `/transfer/:id`, the receiver `GET`s it from the same URL, and
  both sides `DELETE` it when they're done. This is a store-and-forward
  relay, not a live proxy — the Worker only ever holds the object in R2
  between the two HTTP calls, which is what lets it handle multi-gigabyte
  files without hitting a Worker's per-request CPU/duration limits (which a
  live in-request relay of that much data would).

## Deploy

Needs a free Cloudflare account (no card required for the Workers free
tier; R2 may ask you to add a payment method to enable it even though the
free tier itself has no charge for typical personal usage — 10GB storage,
generous free request quota, no egress fee).

```sh
cd cloudflare-signaling
npm install
npx wrangler login                              # opens a browser to authorize once
npx wrangler r2 bucket create raccoonhouse-transfers   # one-time, matches wrangler.jsonc
npx wrangler deploy
```

Optional but recommended — auto-expire any transfer object nobody ever
picked up (e.g. the receiver's PC crashed mid-job), as a safety net on top
of the app's own explicit `DELETE` after a completed transfer:

```sh
npx wrangler r2 bucket lifecycle add raccoonhouse-transfers --expire-days 1
```

Wrangler prints the deployed URL, e.g.
`https://raccoonhouse-signaling.<your-subdomain>.workers.dev` — the app
needs it as `wss://raccoonhouse-signaling.<your-subdomain>.workers.dev/`
(note `wss://`, not `https://`) in Settings → Power Share → signaling URL,
on every instance that should use it. The app derives the `https://` base
for `/transfer/:id` calls from that same URL.

## Local development

```sh
npm run dev
```

Starts a local copy at `ws://127.0.0.1:8787/` (and R2 is emulated locally
too) — point a dev build's `online_signaling_url` setting at that to test
without deploying.

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

Client → Worker → target peer (consent handshake and job control; payload
`kind` is one of `consent_request` / `consent_response` / `job_request` /
`job_done` / `job_error` — see `backend/services/discovery_service.py`):
```json
{"type": "relay", "target_id": "...", "payload": {"kind": "...", "request_id": "...", ...}}
```

File transfer (plain HTTPS, not WebSocket) — `id` is a per-transfer UUID
agreed between the two peers via the `relay` messages above:
```
PUT    /transfer/:id     body = raw file bytes, streamed into R2
GET    /transfer/:id     -> raw file bytes, streamed from R2 (404 if absent)
DELETE /transfer/:id     removes the object
```
