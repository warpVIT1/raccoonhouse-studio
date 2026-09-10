// RaccoonHouse Power Share — online signaling + transfer relay.
//
// Discovery/consent: this Worker answers "who else is online right now" and
// relays small consent-request/response and job-control messages between two
// specific peers over WebSocket (see PeerRegistry below).
//
// File transfer: the actual video/audio for a power-shared job is store-
// and-forwarded through the TRANSFERS R2 bucket via plain HTTP PUT/GET/
// DELETE on /transfer/:id (handled directly in the default fetch handler,
// below, entirely outside the Durable Object) — a Worker can stream a
// request body straight into R2 and back out without buffering the whole
// file in memory, which sidesteps the per-request CPU/duration limits that
// would make relaying multi-gigabyte files through a plain request/response
// or through the WebSocket a bad idea.
//
// One shared PeerRegistry Durable Object instance (idFromName("global"))
// holds every currently-connected client's WebSocket. Uses the Hibernation
// API (ctx.acceptWebSocket / webSocketMessage / webSocketClose) rather than
// a plain event listener loop, so Cloudflare can evict an idle connection's
// JS from memory between messages without dropping the socket — the
// connection metadata (id, name, gpu info, self-reported port) is stored via
// ws.serializeAttachment(), which survives that eviction; nothing here is
// kept in a plain in-memory Map.

interface Env {
  PEER_REGISTRY: DurableObjectNamespace;
  TRANSFERS: R2Bucket;
  MODELS_DB: D1Database;
  AI: Ai;
  // Secret (wrangler secret put) — never returned in any response. Used
  // only to verify the Telegram Login Widget's own HMAC signature (see
  // verifyTelegramAuth) and to call api.telegram.org/bot<token>/getMe once
  // at deploy time to resolve TELEGRAM_BOT_USERNAME below.
  TELEGRAM_BOT_TOKEN: string;
}

// Public — safe to embed directly in the login page's HTML (it's the
// @username Telegram's widget script itself requires as data-telegram-login).
const TELEGRAM_BOT_USERNAME = "raccoonhouse_studio_bot";

// Telegram's own documented verification algorithm — https://core.telegram.org/widgets/login#checking-authorization.
// The widget hands back a flat object (id, first_name, last_name?,
// username?, photo_url?, auth_date, hash) whose `hash` is an HMAC-SHA256
// (keyed by SHA256(bot_token)) over every OTHER field, sorted by key and
// joined as "key=value\n" lines. Verifying this server-side (not trusting
// whatever the Electron-embedded page merely CLAIMS Telegram sent) is the
// only thing standing between "real Telegram login" and "anyone who can
// POST JSON to this endpoint can log in as anyone."
async function verifyTelegramAuth(data: Record<string, string>, botToken: string): Promise<boolean> {
  const { hash, ...rest } = data;
  if (!hash) return false;
  const checkString = Object.keys(rest).sort().map((k) => `${k}=${rest[k]}`).join("\n");
  const secretKey = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(botToken));
  const hmacKey = await crypto.subtle.importKey("raw", secretKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(checkString));
  const computedHash = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  if (computedHash !== hash) return false;
  // Rejects a replayed/stale auth payload — Telegram's own auth_date is a
  // Unix timestamp of when the widget itself signed it, not when this
  // endpoint receives it.
  const authDate = Number(data.auth_date);
  return Boolean(authDate) && Date.now() / 1000 - authDate < 24 * 60 * 60;
}

// Proxies Telegram's own getUserProfilePhotos/getFile Bot API calls and
// streams the actual image bytes back — NEVER hands the caller a raw
// api.telegram.org/file/bot<TOKEN>/... URL directly, since that URL has
// the bot token embedded in plain sight (anyone who saw it in an <img src>
// or browser history would have the whole studio's Telegram bot token).
// This endpoint is the only place that URL is ever constructed.
async function fetchTelegramAvatar(userId: string, botToken: string): Promise<Response> {
  const photosResp = await fetch(`https://api.telegram.org/bot${botToken}/getUserProfilePhotos?user_id=${userId}&limit=1`);
  const photosData = await photosResp.json() as { ok: boolean; result?: { photos: Array<Array<{ file_id: string }>> } };
  const fileId = photosData.result?.photos?.[0]?.[0]?.file_id;
  if (!fileId) return new Response("No avatar", { status: 404 });
  const fileResp = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
  const fileData = await fileResp.json() as { ok: boolean; result?: { file_path?: string } };
  const filePath = fileData.result?.file_path;
  if (!filePath) return new Response("No avatar", { status: 404 });
  const imgResp = await fetch(`https://api.telegram.org/file/bot${botToken}/${filePath}`);
  return new Response(imgResp.body, {
    headers: { "Content-Type": imgResp.headers.get("Content-Type") || "image/jpeg", "Cache-Control": "public, max-age=3600" },
  });
}

function telegramLoginPageHtml(code: string): string {
  // Telegram's widget script injects its own iframe (from oauth.telegram.org)
  // into this page — this page itself just needs to BE a normal page Telegram
  // considers a real website, which is exactly what loading it in Electron's
  // embedded webview gives it (same as any real browser tab would).
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>RaccoonHouse Studio</title>
<style>body{font-family:system-ui,sans-serif;background:#15171c;color:#e8e8ea;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;gap:16px}
p{color:#9a9aa2;font-size:14px}</style></head>
<body>
<p>Увійдіть через Telegram, щоб продовжити</p>
<script async src="https://telegram.org/js/telegram-widget.js?22"
  data-telegram-login="${TELEGRAM_BOT_USERNAME}"
  data-size="large"
  data-onauth="onTelegramAuth(user)"
  data-request-access="write"
  data-lang="uk"></script>
<p id="status" style="display:none">Готово! Можете закрити це вікно.</p>
<script>
function onTelegramAuth(user) {
  fetch('/telegram-login/callback?code=${encodeURIComponent(code)}', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(user),
  }).then(function () {
    document.getElementById('status').style.display = 'block';
  });
}
</script>
</body></html>`;
}

interface PeerAttachment {
  id: string;
  name: string;
  host: string;
  port: number;
  gpu_name: string;
  vram_gb: number;
  power_share_enabled: boolean;
  logged_in: boolean;
  // The profile-scoped id from device_identity_service.get_profile_id() —
  // completely separate address space from `id` above (which is this WS
  // session's own random/persisted client_id). Only exists so a team-invite
  // relay (see backend team_service.invite_member) can find this exact
  // connection despite being addressed by the profile-scoped id, which the
  // Worker otherwise has no way to associate with any connected socket.
  team_device_id: string;
}

export class PeerRegistry {
  ctx: DurableObjectState;
  env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    // Internal-only: the main fetch handler's /notify-team-content route
    // (see below) has already resolved D1 for "who's in this team" — this
    // DO is the only place that actually holds live WebSocket connections
    // (this.ctx.getWebSockets()), so it does the actual relay send, same
    // matching style as the "relay" branch in webSocketMessage below.
    if (new URL(request.url).pathname === "/relay-to-devices" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { targetIds?: string[]; payload?: unknown } | null;
      const targetIds = new Set(body?.targetIds ?? []);
      const payload = body?.payload ?? {};
      let sent = 0;
      for (const target of this.ctx.getWebSockets()) {
        const attachment = target.deserializeAttachment() as PeerAttachment;
        if (attachment.team_device_id && targetIds.has(attachment.team_device_id)) {
          target.send(JSON.stringify({ type: "relay", from_id: "server", payload }));
          sent++;
        }
      }
      return Response.json({ sent });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }

    // Cloudflare terminates TLS and forwards this header with the client's
    // real public IP — the whole reason this app needs a signaling server at
    // all is that a peer behind NAT has no other reliable way to learn its
    // own internet-facing address.
    const publicIp = request.headers.get("CF-Connecting-IP") ?? "0.0.0.0";

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    // Placeholder attachment until the client's own "hello" message fills in
    // name/gpu/port — but the socket is already tracked as connected, so a
    // client that disconnects before saying hello still gets cleaned up.
    server.serializeAttachment({
      id: crypto.randomUUID(),
      name: "?",
      host: publicIp,
      port: 0,
      gpu_name: "?",
      vram_gb: 0,
      power_share_enabled: false,
      logged_in: false,
      team_device_id: "",
    } satisfies PeerAttachment);

    return new Response(null, { status: 101, webSocket: client });
  }

  private peerList(): PeerAttachment[] {
    return this.ctx.getWebSockets().map((ws) => ws.deserializeAttachment() as PeerAttachment);
  }

  private broadcastPeerList() {
    // `host` (the real CF-Connecting-IP, see fetch() above) is kept in each
    // socket's own attachment for potential future abuse-mitigation use, but
    // must NEVER be forwarded to other peers — every online RaccoonHouse
    // install was otherwise leaking every other online user's real public IP
    // through this exact broadcast (confirmed live 2026-08-05: visible in
    // /power-share/discovered's raw response even though the frontend never
    // rendered it). Routing is entirely by `id` through this relay already —
    // nothing legitimate ever needed the real host/port on the client side.
    const peers = this.peerList()
      .filter((p) => p.port > 0) // skip pre-hello sockets
      // team_device_id DOES need to reach every client now (unlike host/
      // port) — each backend uses it locally to filter the "who's online"
      // list down to teammates only before ever showing it in the UI (see
      // backend routers/power_share.py's _visible_peers), and to route
      // team-invite relays. It's an opaque profile-scoped hash, not a real
      // identifier like an IP, so broadcasting it carries the same
      // exposure as the `id` field already broadcast here.
      .map(({ host, port, ...rest }) => rest);
    const payload = JSON.stringify({ type: "peers", peers });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // socket mid-close — webSocketClose will clean it up separately
      }
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    if (msg.type === "hello") {
      const existing = ws.deserializeAttachment() as PeerAttachment;
      // Prefer the client's own persisted id over the random one assigned
      // at connection time — without this, every WebSocket reconnect (network
      // blip, Worker-side connection recycling, etc.) would hand out a brand
      // new id, and any relay reply already in flight to the OLD id (a
      // consent response, or a job's result) would have nowhere to go,
      // silently stranding the requester until its own long timeout expires.
      const clientId = typeof msg.client_id === "string" && msg.client_id ? msg.client_id : existing.id;
      ws.serializeAttachment({
        ...existing,
        id: clientId,
        name: String(msg.name ?? "?"),
        port: Number(msg.port) || 0,
        gpu_name: String(msg.gpu_name ?? "?"),
        vram_gb: Number(msg.vram_gb) || 0,
        power_share_enabled: Boolean(msg.power_share_enabled),
        logged_in: Boolean(msg.logged_in),
        team_device_id: String(msg.team_device_id ?? ""),
      } satisfies PeerAttachment);
      // The client has no other way to know which entry in the broadcasted
      // peer list is itself (it doesn't know its own public IP, and several
      // peers could plausibly share a name) — tell it directly, once, so it
      // can filter its own id out of every "peers" message from here on.
      ws.send(JSON.stringify({ type: "welcome", your_id: clientId }));
      this.broadcastPeerList();

      // Best-effort registry of "every device that's ever said hello" — see
      // known_devices' own schema comment for why this exists (the
      // app-admin "Користувачі" tab needs to show literally everyone, not
      // just team members). Never blocks/fails the hello flow itself.
      const teamDeviceId = String(msg.team_device_id ?? "");
      if (teamDeviceId) {
        const now = new Date().toISOString();
        // roles/telegram_id ride along on the same best-effort upsert so
        // /notify-director (translator -> director handoff) can find
        // "teammates with role X who have Telegram linked" without a
        // dedicated sync channel — see known_devices' schema.sql comment.
        const roles = Array.isArray(msg.roles) ? JSON.stringify(msg.roles) : null;
        const telegramId = typeof msg.telegram_id === "number" ? msg.telegram_id : null;
        const telegramUsername = typeof msg.telegram_username === "string" && msg.telegram_username ? msg.telegram_username : null;
        this.ctx.waitUntil(
          this.env.MODELS_DB.prepare(
            `INSERT INTO known_devices (device_id, display_name, first_seen_at, last_seen_at, roles, telegram_id, telegram_username) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(device_id) DO UPDATE SET display_name = excluded.display_name, last_seen_at = excluded.last_seen_at, roles = excluded.roles, telegram_id = excluded.telegram_id, telegram_username = excluded.telegram_username`,
          ).bind(teamDeviceId, String(msg.name ?? "?"), now, now, roles, telegramId, telegramUsername).run().catch(() => {}),
        );
      }
      return;
    }

    if (msg.type === "relay") {
      // Small consent-request/response and job-control messages only — the
      // actual file bytes go through the /transfer/:id R2 routes instead
      // (see the module docstring and the default fetch handler below).
      const targetId = String(msg.target_id ?? "");
      const from = ws.deserializeAttachment() as PeerAttachment;
      for (const target of this.ctx.getWebSockets()) {
        const attachment = target.deserializeAttachment() as PeerAttachment;
        // Matches either address space — plain power-share relay (consent/
        // job-control) is addressed by `id` (this session's own client_id);
        // team-invite relay is addressed by `team_device_id` (see
        // team_service.invite_member) since that's the only id the inviter
        // actually knows. A session's team_device_id is empty until a
        // profile is active, so it never accidentally matches an empty
        // targetId.
        if (attachment.id === targetId || (targetId && attachment.team_device_id === targetId)) {
          target.send(JSON.stringify({ type: "relay", from_id: from.id, payload: msg.payload }));
        }
      }
      return;
    }
  }

  async webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean) {
    this.broadcastPeerList();
  }

  async webSocketError(_ws: WebSocket) {
    this.broadcastPeerList();
  }
}

function transferId(url: URL): string | null {
  const match = url.pathname.match(/^\/transfer\/([A-Za-z0-9_-]+)$/);
  return match ? match[1] : null;
}

// Cloudflare's own account-level request body size cap (100MB on Free/Pro,
// 200MB Business) sits well under the size of an uncompressed separated WAV
// stem (routinely 300-400MB+ for a full episode) — confirmed live 2026-07-23:
// a single-shot PUT of a ~376MB result file was rejected outright before
// even reaching this Worker's own code. R2 itself has no such limit (up to
// 5TB per object), so the fix is R2's multipart upload API: the client
// splits the file into several smaller PUTs (each safely under the request
// body cap) instead of one giant one. These routes exist purely to expose
// that 3-step protocol (create/uploadPart/complete) over plain HTTP, mirroring
// R2Bucket's own API shape one-to-one.
const MULTIPART_CREATE = /^\/transfer\/([A-Za-z0-9_-]+)\/multipart$/;
const MULTIPART_PART = /^\/transfer\/([A-Za-z0-9_-]+)\/multipart\/([^/]+)\/(\d+)$/;
const MULTIPART_COMPLETE = /^\/transfer\/([A-Za-z0-9_-]+)\/multipart\/([^/]+)\/complete$/;
const MULTIPART_ABORT = /^\/transfer\/([A-Za-z0-9_-]+)\/multipart\/([^/]+)\/abort$/;

// In-app "suggestions & complaints" inbox — any RaccoonHouse install in the
// trusted circle can POST /feedback; only the app owner's own install is
// expected to ever call GET/DELETE (gated client-side by a local-only
// AppSettings toggle, not by anything here — this Worker has no per-user
// auth anywhere, matching the rest of this closed-group app's trust model).
// Reuses the existing TRANSFERS R2 bucket (a "feedback/<uuid>.json" key per
// submission) rather than provisioning a second bucket just for this.
const FEEDBACK_ITEM = /^\/feedback\/([A-Za-z0-9_-]+)$/;
interface FeedbackItem {
  id: string;
  nickname: string;
  // Which known_devices row sent this, when the sender had an active
  // profile — lets the admin "База даних" tab's per-user detail view cross-
  // reference feedback by device_id rather than the free-text nickname
  // alone (two people can share a display name). Null for anything
  // submitted before this field existed.
  device_id: string | null;
  message: string;
  created_at: string;
}

// Separation-run reports for the admin — same trust model and same TRANSFERS
// bucket as feedback above (a "reports/<uuid>.json" key per run), just a
// different key prefix. Any install can POST a report for a run it just did;
// only the admin's own install is expected to GET/DELETE (gated client-side
// by Profile.is_admin — see backend/routers/settings.py).
const REPORT_ITEM = /^\/reports\/([A-Za-z0-9_-]+)$/;

interface SeparationReport {
  id: string;
  profile_name: string;
  device_id: string | null;
  user_timezone: string;
  episode_label: string;
  model: string;
  ensemble: boolean;
  distributed: boolean;
  peers_used: string[];
  duration_seconds: number;
  status: string;
  error_message: string | null;
  warnings: string[];
  started_at_utc: string;
  created_at: string;
}

// Renderer error reports — same R2-JSON-blob pattern and trust model as
// feedback/reports above (an "errors/<uuid>.json" key per report). Fed by
// ErrorBoundary.tsx's componentDidCatch and main.tsx's global window
// error/unhandledrejection listeners; only the admin "База даних" tab's
// per-user "Помилки" sub-tab reads these back.
const ERROR_ITEM = /^\/errors\/([A-Za-z0-9_-]+)$/;
interface ErrorReportItem {
  id: string;
  device_id: string | null;
  profile_name: string;
  message: string;
  stack: string | null;
  context: string;
  created_at: string;
}

// Model Browser — shared catalog (models added by hand or via the "add by
// URL" AI auto-configure flow — audio-separator's own built-in registry
// entries are NOT stored here, see backend/routers/model_browser.py) plus
// per-profile 1-5 star ratings, both in the MODELS_DB D1 database (see
// schema.sql) rather than R2 JSON blobs — this data is genuinely relational
// (filter/sort by method, one rating per method+filename+profile), which a
// real SQL table handles far better than listing+fetching many small R2
// objects on every read the way feedback/reports/apex-models above do.
interface ModelRow {
  id: string;
  method: string;
  filename: string;
  label: string;
  arch: string;
  download_url: string;
  config_yaml_url: string | null;
  source_url: string;
  added_by: string;
  is_custom: number;
  notes: string | null;
  created_at: string;
}
interface ModelRating {
  method: string;
  filename: string;
  profile_name: string;
  rating: number;
  created_at: string;
}

// Free-text "what's this model good/bad at" note, shared studio-wide and
// editable by anyone (unlike ratings, which are per-profile) — keyed by
// filename alone, same reasoning as the models table's own unique index
// (see schema.sql): the same physical checkpoint is one model regardless of
// which method tab it's browsed under. A plain last-write-wins overwrite,
// not a history/diff — this is a shared note, not a moderated wiki.
interface ModelDescription {
  filename: string;
  description: string;
  updated_by: string;
  updated_at: string;
}

// Team system (see backend/services/team_service.py) — device_id is the
// fixed per-machine id from backend/services/device_identity_service.py,
// never a Profile row (those are local and can be wiped). Passwords arrive
// here already hashed (see routers/teams.py) — this Worker never sees or
// stores a plaintext team password. Auth for who's ALLOWED to call each of
// these endpoints (app-admin for team creation, team-admin for invites) is
// checked entirely on the Python backend before it makes the call, same
// trust posture as /apex-models and everything else in this file — this is
// a closed trusted circle, not a public multi-tenant API.
interface Team {
  id: string;
  name: string;
  password_hash: string;
  credits_enabled: number; // 0 | 1 — D1 has no native boolean
  created_by_device_id: string;
  created_at: string;
}
interface TeamMember {
  team_id: string;
  device_id: string;
  display_name: string;
  is_team_admin: number;
  joined_at: string;
}
interface TeamInvite {
  id: string;
  team_id: string;
  invited_device_id: string;
  created_by_device_id: string;
  created_at: string;
  status: string; // pending | accepted | declined
}
interface TeamJoinRequest {
  id: string;
  team_id: string;
  device_id: string;
  display_name: string;
  telegram_id: number | null;
  telegram_username: string | null;
  created_at: string;
  status: string; // pending | accepted | declined
}
interface CreditGrant {
  device_id: string;
  enabled: number;
  granted_by_device_id: string;
  updated_at: string;
}

const SUPPORTED_METHODS = ["MDX-Net", "VR Arch", "Demucs", "MDX23C", "BS-RoFormer"] as const;
const SUPPORTED_ARCHS = ["mdx", "vr", "demucs", "mdxc"] as const;

// Fetches enough context about a model repository (HuggingFace or GitHub)
// for the LLM below to figure out how to install it — the file listing
// (so it can pick out the actual checkpoint/config filenames) and the
// README (so it can read stated architecture/stems). Best-effort: a
// platform this doesn't recognize, or a fetch that 404s, just yields less
// context rather than failing outright — the model still gets a shot at
// answering from the URL and whatever partial context it has.
async function fetchRepoContext(url: string): Promise<{ listing: string; readme: string }> {
  let listing = "";
  let readme = "";
  const headers = { "User-Agent": "RaccoonHouse-Studio-ModelBrowser" };

  try {
    const u = new URL(url);
    if (u.hostname === "huggingface.co" || u.hostname === "www.huggingface.co") {
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length >= 2) {
        const repoId = `${parts[0]}/${parts[1]}`;
        const infoRes = await fetch(`https://huggingface.co/api/models/${repoId}`, { headers });
        if (infoRes.ok) {
          const info = await infoRes.json() as { siblings?: { rfilename: string }[] };
          listing = (info.siblings ?? []).map((s) => s.rfilename).join("\n");
        }
        for (const branch of ["main", "master"]) {
          const readmeRes = await fetch(`https://huggingface.co/${repoId}/raw/${branch}/README.md`, { headers });
          if (readmeRes.ok) {
            readme = (await readmeRes.text()).slice(0, 6000);
            break;
          }
        }
      }
    } else if (u.hostname === "github.com") {
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length >= 2) {
        const [owner, repo] = parts;
        const contentsRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents`, { headers });
        const treeLines: string[] = [];
        if (contentsRes.ok) {
          const contents = await contentsRes.json() as { name: string }[];
          treeLines.push(...contents.map((c) => c.name));
        }
        const releasesRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases`, { headers });
        if (releasesRes.ok) {
          const releases = await releasesRes.json() as { assets?: { name: string; browser_download_url: string }[] }[];
          for (const rel of releases) {
            for (const asset of rel.assets ?? []) {
              treeLines.push(`${asset.name} -> ${asset.browser_download_url}`);
            }
          }
        }
        listing = treeLines.join("\n").slice(0, 6000);
        const readmeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/readme`, {
          headers: { ...headers, Accept: "application/vnd.github.raw" },
        });
        if (readmeRes.ok) readme = (await readmeRes.text()).slice(0, 6000);
      }
    }
  } catch {
    // partial or no context — the model still gets the raw URL to work with
  }
  return { listing, readme };
}

const AUTO_CONFIGURE_SYSTEM_PROMPT = `You help configure audio source-separation models (vocal/instrumental isolation) for the "audio-separator" Python library, given a model repository's URL, file listing, and README.

Valid "method" values (pick exactly one): ${SUPPORTED_METHODS.join(", ")}.
Valid "arch" values (pick exactly one, matching method): mdx (for MDX-Net), vr (for VR Arch), demucs (for Demucs), mdxc (for MDX23C AND for BS-RoFormer / Mel-Band-Roformer — they all use the same "mdxc" architecture key with a YAML config).

For a HuggingFace repository, construct download_url/config_yaml_url EXACTLY as:
https://huggingface.co/<owner>/<repo>/resolve/<branch>/<path>
using the owner/repo/branch from the Repository URL given to you, and <path> copied VERBATIM from a line in the file listing below. Do NOT insert "/datasets/", "/spaces/", or any other extra path segment that does not literally appear in the Repository URL — that is a common mistake that produces a broken link. For a GitHub repository, only use a download_url that appears literally in the file listing (release asset URLs already include their full path — copy them exactly, don't reconstruct them).

Repos like this commonly contain MANY unrelated checkpoint+config pairs across different subfolders (e.g. separate folders per variant: "instrumental/", "karaoke/", "vocals/"). The config_yaml_url MUST be the one that actually belongs to the SAME checkpoint you picked for download_url — confirmed live as a real mistake: pairing "instrumental/inst_gabox.ckpt" with an unrelated "instrumental/karaoke_bs_roformer.yaml" that belongs to a completely different checkpoint in a different folder, which 404'd when actually used. The correct config is almost always either (a) in the exact same folder AND sharing the same base filename as the checkpoint (e.g. "inst_gabox.ckpt" pairs with "inst_gabox.yaml", not any other .yaml), or (b) the only .yaml file present in that same folder. If you cannot find a config with a matching base filename or folder, set config_yaml_url to null rather than guessing one from a different folder.

Respond with ONLY a single JSON object, no other text, no markdown fences, with exactly these keys:
{
  "method": one of the valid method values,
  "arch": one of the valid arch values,
  "filename": the exact checkpoint filename (e.g. "model.ckpt", "model.onnx", "model.th"),
  "download_url": a direct, publicly fetchable URL to download that exact checkpoint file,
  "config_yaml_url": a direct URL to the model's YAML config file if the architecture needs one (mdxc almost always does) — or null if none is needed,
  "label": a short human-friendly display name for this model,
  "stems": an array of stem names this model outputs if you can tell from the README (e.g. ["vocals","instrumental"]), else an empty array,
  "confidence": "high" | "medium" | "low" — how sure you are this configuration is correct
}
If you cannot determine a direct download_url with reasonable confidence, set it to null and confidence to "low" rather than guessing a URL that may not work.`;

// HuggingFace's web UI paths ("/blob/<branch>/<path>" — the syntax-
// highlighted HTML preview page, and "/tree/<branch>/<path>" — the
// directory browser) look like file URLs to an LLM but are NOT raw file
// downloads; only "/resolve/<branch>/<path>" is. Confirmed live: the model
// proposed a "/tree/main/....ckpt" URL and a "/blob/main/....yaml" URL in
// two separate real runs, both of which 404'd (or would have returned an
// HTML page instead of the actual file) at actual download time — a HEAD
// request to a /blob/ page still returns 200 (the preview page itself
// loads fine), so validation alone doesn't catch this class of mistake.
// This is a mechanical, 100%-reliable rewrite (unlike hoping the model
// always gets it right), so it's applied unconditionally rather than left
// as another thing for the prompt to hopefully get right.
function normalizeHfUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname !== "huggingface.co") return url;
    u.pathname = u.pathname.replace(/\/(blob|tree)\//, "/resolve/");
    return u.toString();
  } catch {
    return url;
  }
}

// A HEAD request against a URL the model claims is a working direct
// download link — LLMs reliably hallucinate plausible-looking but wrong
// paths (confirmed live: it once inserted an extra "/datasets/" segment
// into an otherwise-correct HuggingFace URL, producing a 401). Rather than
// trying to make the prompt airtight (impossible) or silently trusting the
// output, every URL the model proposes gets checked here and flagged in the
// response — ModelBrowserModal surfaces "⚠ посилання не перевірено" so a
// human reviews it before it's saved to the shared catalog, instead of
// quietly poisoning everyone else's download. Also rejects an HTML
// response body for what's supposed to be a binary/yaml file — catches a
// /blob/ preview page slipping through the plain "was it a 200" check
// above, in case normalizeHfUrl above ever misses a variant of that URL
// shape.
async function urlLooksDownloadable(url: string | null | undefined): Promise<boolean> {
  if (!url) return true; // nothing to check (e.g. config_yaml_url legitimately absent)
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow" });
    if (!res.ok) return false;
    const contentType = res.headers.get("content-type") ?? "";
    return !contentType.includes("text/html");
  } catch {
    return false;
  }
}

async function autoConfigureModel(env: Env, url: string): Promise<Record<string, unknown>> {
  const { listing, readme } = await fetchRepoContext(url);
  const userContent = `Repository URL: ${url}\n\nFile listing:\n${listing || "(unavailable)"}\n\nREADME excerpt:\n${readme || "(unavailable)"}`;

  const result = await env.AI.run("@cf/meta/llama-3.2-3b-instruct", {
    messages: [
      { role: "system", content: AUTO_CONFIGURE_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
  });

  // Workers AI's response shape varies by model/binding version — usually
  // { response: string }, but has been observed returning the string
  // directly, or a { response: object } already-parsed JSON. Handle all
  // three rather than assuming one, since a wrong assumption here fails
  // every single auto-configure call with an unhelpful TypeError.
  let parsed: Record<string, unknown>;
  const response = (result as { response?: unknown }).response;
  if (typeof response === "string") {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`AI did not return a JSON object: ${response.slice(0, 300)}`);
    parsed = JSON.parse(jsonMatch[0]);
  } else if (response && typeof response === "object") {
    parsed = response as Record<string, unknown>;
  } else if (typeof result === "string") {
    const jsonMatch = (result as string).match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`AI did not return a JSON object: ${(result as string).slice(0, 300)}`);
    parsed = JSON.parse(jsonMatch[0]);
  } else {
    throw new Error(`Unexpected AI response shape: ${JSON.stringify(result).slice(0, 300)}`);
  }

  if (typeof parsed.download_url === "string") parsed.download_url = normalizeHfUrl(parsed.download_url);
  if (typeof parsed.config_yaml_url === "string") parsed.config_yaml_url = normalizeHfUrl(parsed.config_yaml_url);

  const [download_url_ok, config_yaml_url_ok] = await Promise.all([
    urlLooksDownloadable(parsed.download_url as string | null | undefined),
    urlLooksDownloadable(parsed.config_yaml_url as string | null | undefined),
  ]);

  return { ...parsed, source_url: url, download_url_ok, config_yaml_url_ok };
}

// Global kill switch for the stage-handoff/direct-message notifications
// below — checked by notifyTeamRole and /notify-device, NOT by /feedback,
// /reports, or the pause/resume announcement itself (see PUT
// /notification-settings, which sends that announcement directly rather
// than through either of the gated paths — otherwise pausing would also
// block the "notifications are paused" message).
async function areNotificationsPaused(env: Env): Promise<boolean> {
  const row = await env.MODELS_DB.prepare(
    "SELECT paused FROM notification_settings WHERE id = 1",
  ).first<{ paused: number }>();
  return !!row?.paused;
}

// Infers a real Content-Type from the requested download filename's own
// extension — the previous logic just hardcoded "video/mp4" for anything
// that wasn't an "actorsrt" transfer_id, which was wrong the moment
// ?filename= started being used for non-video downloads too (actor audio
// submissions — see backend routers/actor_audio.py's get_actor_audio_url).
// `id` (the transfer_id) is only a fallback signal for the two shapes that
// predate ?filename= carrying a real extension at all.
function contentTypeForFilename(filename: string, id: string): string {
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  const byExt: Record<string, string> = {
    mp4: "video/mp4", mkv: "video/x-matroska", mov: "video/quicktime", webm: "video/webm",
    wav: "audio/wav", mp3: "audio/mpeg", flac: "audio/flac", ogg: "audio/ogg", m4a: "audio/mp4",
    srt: "text/plain; charset=utf-8", txt: "text/plain; charset=utf-8",
  };
  if (byExt[ext]) return byExt[ext];
  return id.includes("actorsrt") ? "text/plain; charset=utf-8" : "application/octet-stream";
}

// Shared by /notify-director and /notify-actors (see their route handlers
// below) — resolves the TARGET team, finds other members with `role` in
// their known_devices.roles JSON array and a Telegram chat id on file (both
// synced via "hello", see webSocketMessage), and fire-and-forget
// sendMessages each. Stage-handoff notifications only differ by which role
// they're broadcasting to.
//
// `explicitTeamId`, when given, IS the team to notify — the title/episode's
// own team_id (see backend discovery_service.py's own comment on
// _notify_team_role) — used as-is, no lookup. Without it (older callers, or
// a broadcast with no specific title in scope), falls back to the OLD
// behavior of inferring the team from the sender's OWN team_members row —
// confirmed live 2026-09-09 as a real bug for anyone in more than one team:
// that lookup has no ORDER BY/LIMIT, so it could silently pick a DIFFERENT
// team than the one the content actually belongs to.
async function notifyTeamRole(env: Env, teamDeviceId: string, role: string, message: string, explicitTeamId?: string | null): Promise<number> {
  if (await areNotificationsPaused(env)) return 0;
  let teamId = explicitTeamId;
  if (!teamId) {
    const team = await env.MODELS_DB.prepare(
      "SELECT team_id FROM team_members WHERE device_id = ?",
    ).bind(teamDeviceId).first<{ team_id: string }>();
    if (!team) return 0;
    teamId = team.team_id;
  }
  const { results } = await env.MODELS_DB.prepare(
    `SELECT kd.telegram_id AS telegram_id FROM team_members tm
     JOIN known_devices kd ON kd.device_id = tm.device_id
     WHERE tm.team_id = ? AND tm.device_id != ? AND kd.telegram_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM json_each(kd.roles) WHERE value = ?)`,
  ).bind(teamId, teamDeviceId, role).all<{ telegram_id: number }>();
  let sent = 0;
  for (const row of results) {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: row.telegram_id, text: message }),
    }).catch(() => {}); // best-effort per-recipient — one failure shouldn't block the rest
    sent++;
  }
  return sent;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    let m = url.pathname.match(MULTIPART_CREATE);
    if (m && request.method === "POST") {
      const multipart = await env.TRANSFERS.createMultipartUpload(m[1]);
      return Response.json({ uploadId: multipart.uploadId });
    }

    m = url.pathname.match(MULTIPART_PART);
    if (m && request.method === "PUT") {
      const [, id, uploadId, partNumberStr] = m;
      const multipart = env.TRANSFERS.resumeMultipartUpload(id, uploadId);
      const part = await multipart.uploadPart(parseInt(partNumberStr, 10), request.body as ReadableStream);
      return Response.json({ partNumber: part.partNumber, etag: part.etag });
    }

    m = url.pathname.match(MULTIPART_COMPLETE);
    if (m && request.method === "POST") {
      const [, id, uploadId] = m;
      const parts = await request.json() as { partNumber: number; etag: string }[];
      const multipart = env.TRANSFERS.resumeMultipartUpload(id, uploadId);
      await multipart.complete(parts);
      return new Response(null, { status: 204 });
    }

    m = url.pathname.match(MULTIPART_ABORT);
    if (m && request.method === "POST") {
      const [, id, uploadId] = m;
      const multipart = env.TRANSFERS.resumeMultipartUpload(id, uploadId);
      try {
        await multipart.abort();
      } catch {
        // Already completed, already aborted, or expired past R2's own
        // 7-day auto-abort — nothing left to clean up either way.
      }
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/feedback" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { nickname?: string; device_id?: string; message?: string } | null;
      const nickname = (body?.nickname ?? "").toString().trim().slice(0, 100) || "Анонім";
      const deviceId = (body?.device_id ?? "").toString().trim().slice(0, 64) || null;
      const message = (body?.message ?? "").toString().trim().slice(0, 4000);
      if (!message) {
        return new Response("message is required", { status: 400 });
      }
      const item: FeedbackItem = { id: crypto.randomUUID(), nickname, device_id: deviceId, message, created_at: new Date().toISOString() };
      await env.TRANSFERS.put(`feedback/${item.id}.json`, JSON.stringify(item));
      return Response.json({ id: item.id });
    }

    if (url.pathname === "/feedback" && request.method === "GET") {
      const listed = await env.TRANSFERS.list({ prefix: "feedback/" });
      const items = await Promise.all(
        listed.objects.map(async (o) => {
          const obj = await env.TRANSFERS.get(o.key);
          if (!obj) return null;
          try {
            return JSON.parse(await obj.text()) as FeedbackItem;
          } catch {
            return null;
          }
        }),
      );
      const valid = items.filter((x): x is FeedbackItem => x !== null);
      valid.sort((a, b) => a.created_at.localeCompare(b.created_at));
      return Response.json(valid);
    }

    const feedbackMatch = url.pathname.match(FEEDBACK_ITEM);
    if (feedbackMatch && request.method === "DELETE") {
      await env.TRANSFERS.delete(`feedback/${feedbackMatch[1]}.json`);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/reports" && request.method === "POST") {
      const body = await request.json().catch(() => null) as Partial<SeparationReport> | null;
      if (!body || typeof body.model !== "string") {
        return new Response("model is required", { status: 400 });
      }
      const item: SeparationReport = {
        id: crypto.randomUUID(),
        profile_name: (body.profile_name ?? "").toString().slice(0, 100) || "Анонім",
        device_id: body.device_id ? String(body.device_id).slice(0, 64) : null,
        user_timezone: (body.user_timezone ?? "").toString().slice(0, 32) || "UTC+00:00",
        episode_label: (body.episode_label ?? "").toString().slice(0, 200),
        model: body.model.slice(0, 64),
        ensemble: !!body.ensemble,
        distributed: !!body.distributed,
        peers_used: Array.isArray(body.peers_used) ? body.peers_used.map(String).slice(0, 20) : [],
        duration_seconds: typeof body.duration_seconds === "number" ? body.duration_seconds : 0,
        status: (body.status ?? "unknown").toString().slice(0, 32),
        error_message: body.error_message ? String(body.error_message).slice(0, 2000) : null,
        warnings: Array.isArray(body.warnings) ? body.warnings.map(String).slice(0, 50) : [],
        started_at_utc: (body.started_at_utc ?? new Date().toISOString()).toString(),
        created_at: new Date().toISOString(),
      };
      await env.TRANSFERS.put(`reports/${item.id}.json`, JSON.stringify(item));
      return Response.json({ id: item.id });
    }

    if (url.pathname === "/reports" && request.method === "GET") {
      const listed = await env.TRANSFERS.list({ prefix: "reports/" });
      const items = await Promise.all(
        listed.objects.map(async (o) => {
          const obj = await env.TRANSFERS.get(o.key);
          if (!obj) return null;
          try {
            return JSON.parse(await obj.text()) as SeparationReport;
          } catch {
            return null;
          }
        }),
      );
      const valid = items.filter((x): x is SeparationReport => x !== null);
      valid.sort((a, b) => b.started_at_utc.localeCompare(a.started_at_utc));
      return Response.json(valid);
    }

    const reportMatch = url.pathname.match(REPORT_ITEM);
    if (reportMatch && request.method === "DELETE") {
      await env.TRANSFERS.delete(`reports/${reportMatch[1]}.json`);
      return new Response(null, { status: 204 });
    }

    // Renderer error reports — same R2-JSON-blob CRUD shape as feedback/
    // reports above, see ErrorReportItem's own comment.
    if (url.pathname === "/errors" && request.method === "POST") {
      const body = await request.json().catch(() => null) as Partial<ErrorReportItem> | null;
      if (!body || typeof body.message !== "string") {
        return new Response("message is required", { status: 400 });
      }
      const item: ErrorReportItem = {
        id: crypto.randomUUID(),
        device_id: body.device_id ? String(body.device_id).slice(0, 64) : null,
        profile_name: (body.profile_name ?? "").toString().slice(0, 100) || "Анонім",
        message: body.message.slice(0, 2000),
        stack: body.stack ? String(body.stack).slice(0, 8000) : null,
        context: (body.context ?? "renderer").toString().slice(0, 32),
        created_at: new Date().toISOString(),
      };
      await env.TRANSFERS.put(`errors/${item.id}.json`, JSON.stringify(item));
      return Response.json({ id: item.id });
    }

    if (url.pathname === "/errors" && request.method === "GET") {
      const listed = await env.TRANSFERS.list({ prefix: "errors/" });
      const items = await Promise.all(
        listed.objects.map(async (o) => {
          const obj = await env.TRANSFERS.get(o.key);
          if (!obj) return null;
          try {
            return JSON.parse(await obj.text()) as ErrorReportItem;
          } catch {
            return null;
          }
        }),
      );
      const valid = items.filter((x): x is ErrorReportItem => x !== null);
      valid.sort((a, b) => b.created_at.localeCompare(a.created_at));
      return Response.json(valid);
    }

    const errorMatch = url.pathname.match(ERROR_ITEM);
    if (errorMatch && request.method === "DELETE") {
      await env.TRANSFERS.delete(`errors/${errorMatch[1]}.json`);
      return new Response(null, { status: 204 });
    }

    // Translator -> director handoff (see backend
    // discovery_service.notify_director and routers/episodes.py's
    // /episodes/{id}/send-to-director). See notifyTeamRole above for the
    // actual team-lookup + role-filter + sendMessage logic, shared with
    // /notify-actors below.
    if (url.pathname === "/notify-director" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { team_device_id?: string; message?: string; team_id?: string | null } | null;
      const teamDeviceId = (body?.team_device_id ?? "").toString();
      const message = (body?.message ?? "").toString().slice(0, 2000);
      if (!teamDeviceId || !message) {
        return new Response("team_device_id and message are required", { status: 400 });
      }
      const sent = await notifyTeamRole(env, teamDeviceId, "director", message, body?.team_id);
      return Response.json({ sent });
    }

    // Director -> actors handoff, one stage further than /notify-director
    // above (see backend discovery_service.notify_actors and
    // routers/episodes.py's /episodes/{id}/send-to-actors).
    if (url.pathname === "/notify-actors" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { team_device_id?: string; message?: string; team_id?: string | null } | null;
      const teamDeviceId = (body?.team_device_id ?? "").toString();
      const message = (body?.message ?? "").toString().slice(0, 2000);
      if (!teamDeviceId || !message) {
        return new Response("team_device_id and message are required", { status: 400 });
      }
      const sent = await notifyTeamRole(env, teamDeviceId, "actor", message, body?.team_id);
      return Response.json({ sent });
    }

    // Director's "Звук" tab -> sound engineer handoff (see backend
    // discovery_service.notify_sound_engineer and
    // routers/actor_audio.py's send-to-sound-engineer) — same shape as
    // /notify-director/-actors above.
    if (url.pathname === "/notify-sound-engineer" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { team_device_id?: string; message?: string; team_id?: string | null } | null;
      const teamDeviceId = (body?.team_device_id ?? "").toString();
      const message = (body?.message ?? "").toString().slice(0, 2000);
      if (!teamDeviceId || !message) {
        return new Response("team_device_id and message are required", { status: 400 });
      }
      const sent = await notifyTeamRole(env, teamDeviceId, "sound_engineer", message, body?.team_id);
      return Response.json({ sent });
    }

    // ASS/SRT import -> translator handoff (see backend
    // discovery_service.notify_translator and routers/subtitles.py's
    // import_ass) — same shape as /notify-director/-actors/-sound-engineer
    // above.
    if (url.pathname === "/notify-translator" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { team_device_id?: string; message?: string; team_id?: string | null } | null;
      const teamDeviceId = (body?.team_device_id ?? "").toString();
      const message = (body?.message ?? "").toString().slice(0, 2000);
      if (!teamDeviceId || !message) {
        return new Response("team_device_id and message are required", { status: 400 });
      }
      const sent = await notifyTeamRole(env, teamDeviceId, "translator", message, body?.team_id);
      return Response.json({ sent });
    }

    // Read-only team-member-by-role listing (see backend
    // team_service.list_team_actors and routers/teams.py's
    // /teams/{team_id}/actors) — feeds the subtitle grid's "АКТОР" dropdown
    // (default role) and, since 2026-08-19, the title "Команда тайтлу"
    // panel's per-role assignment dropdowns (?role=director etc.). Same D1
    // join shape as notifyTeamRole above, minus the Telegram send. No admin
    // gate, same trust posture as /teams/{team_id}/members.
    if (url.pathname === "/team-actors" && request.method === "GET") {
      const teamId = url.searchParams.get("team_id") ?? "";
      const role = url.searchParams.get("role") ?? "actor";
      if (!teamId) {
        return new Response("team_id is required", { status: 400 });
      }
      const { results } = await env.MODELS_DB.prepare(
        `SELECT tm.device_id AS device_id, kd.display_name AS display_name FROM team_members tm
         JOIN known_devices kd ON kd.device_id = tm.device_id
         WHERE tm.team_id = ? AND EXISTS (SELECT 1 FROM json_each(kd.roles) WHERE value = ?)`,
      ).bind(teamId, role).all<{ device_id: string; display_name: string | null }>();
      return Response.json(results.map((r) => ({ device_id: r.device_id, display_name: r.display_name ?? r.device_id })));
    }

    // Shared-titles live-update push (see backend sync_service.py's
    // share_title/push_* functions and PeerRegistry's internal
    // /relay-to-devices handler above, which actually holds the live
    // sockets). Resolves "everyone else in this team" via D1 here (same
    // synchronous-lookup style as notifyTeamRole), then hands the actual
    // send off to the DO. Members who are offline just don't get this —
    // covered by the periodic/on-reconnect pull fallback in sync_service.py.
    if (url.pathname === "/notify-team-content" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { team_device_id?: string; team_id?: string } | null;
      const teamDeviceId = (body?.team_device_id ?? "").toString();
      const teamId = (body?.team_id ?? "").toString();
      if (!teamDeviceId || !teamId) {
        return new Response("team_device_id and team_id are required", { status: 400 });
      }
      const { results } = await env.MODELS_DB.prepare(
        "SELECT device_id FROM team_members WHERE team_id = ? AND device_id != ?",
      ).bind(teamId, teamDeviceId).all<{ device_id: string }>();
      const targetIds = results.map((r) => r.device_id);
      if (targetIds.length === 0) {
        return Response.json({ sent: 0 });
      }
      const doId = env.PEER_REGISTRY.idFromName("global");
      const stub = env.PEER_REGISTRY.get(doId);
      const relayResp = await stub.fetch("https://do/relay-to-devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetIds, payload: { kind: "shared_content_updated", team_id: teamId } }),
      });
      const relayJson = await relayResp.json().catch(() => ({ sent: 0 })) as { sent?: number };
      return Response.json({ sent: relayJson.sent ?? 0 });
    }

    // Shared titles CRUD (see schema.sql's shared_titles/shared_episodes/
    // shared_characters/shared_subtitle_lines comment, and backend
    // sync_service.py which is the only caller of all of these). Plain D1
    // writes, same shape as /reports and /teams above — team-membership
    // trust is enforced at the Python layer (Title.shared_id gate), not
    // here, matching this whole file's existing posture.
    if (url.pathname === "/shared-titles" && request.method === "POST") {
      const body = await request.json().catch(() => null) as {
        team_id?: string; name_ua?: string; name_original?: string; status?: string;
        show_key?: string | null; created_by_device_id?: string;
      } | null;
      if (!body?.team_id || !body?.name_ua || !body?.created_by_device_id) {
        return new Response("team_id, name_ua and created_by_device_id are required", { status: 400 });
      }
      const now = new Date().toISOString();
      const row = {
        id: crypto.randomUUID(), team_id: body.team_id, name_ua: body.name_ua,
        name_original: body.name_original ?? "", poster_transfer_id: null,
        status: body.status ?? "new", show_key: body.show_key ?? null,
        created_by_device_id: body.created_by_device_id, updated_at: now,
      };
      await env.MODELS_DB.prepare(
        `INSERT INTO shared_titles (id, team_id, name_ua, name_original, poster_transfer_id, status, show_key, created_by_device_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(row.id, row.team_id, row.name_ua, row.name_original, row.poster_transfer_id, row.status, row.show_key, row.created_by_device_id, row.updated_at).run();
      return Response.json(row);
    }

    const sharedTitleMatch = url.pathname.match(/^\/shared-titles\/([A-Za-z0-9_-]+)$/);
    if (sharedTitleMatch && request.method === "PUT") {
      const id = sharedTitleMatch[1];
      const body = await request.json().catch(() => null) as {
        name_ua?: string; name_original?: string; poster_transfer_id?: string | null;
        status?: string; show_key?: string | null;
      } | null;
      const now = new Date().toISOString();
      await env.MODELS_DB.prepare(
        `UPDATE shared_titles SET name_ua = COALESCE(?, name_ua), name_original = COALESCE(?, name_original),
         poster_transfer_id = ?, status = COALESCE(?, status), show_key = ?, updated_at = ? WHERE id = ?`,
      ).bind(body?.name_ua ?? null, body?.name_original ?? null, body?.poster_transfer_id ?? null,
             body?.status ?? null, body?.show_key ?? null, now, id).run();
      return Response.json({ ok: true });
    }

    const sharedTitleEpisodesMatch = url.pathname.match(/^\/shared-titles\/([A-Za-z0-9_-]+)\/episodes$/);
    if (sharedTitleEpisodesMatch && request.method === "POST") {
      const sharedTitleId = sharedTitleEpisodesMatch[1];
      const body = await request.json().catch(() => null) as {
        season?: number; number?: number; duration?: number | null;
        original_size?: number | null; original_bitrate?: number | null; original_format?: string | null;
        status?: string; subtitle_stage?: string;
      } | null;
      if (body?.number == null) {
        return new Response("number is required", { status: 400 });
      }
      const now = new Date().toISOString();
      const row = {
        id: crypto.randomUUID(), shared_title_id: sharedTitleId, season: body.season ?? 1, number: body.number,
        duration: body.duration ?? null, video_transfer_id: null,
        original_size: body.original_size ?? null, original_bitrate: body.original_bitrate ?? null,
        original_format: body.original_format ?? null, status: body.status ?? "not_uploaded",
        subtitle_stage: body.subtitle_stage ?? "translating", updated_at: now,
      };
      await env.MODELS_DB.prepare(
        `INSERT INTO shared_episodes (id, shared_title_id, season, number, duration, video_transfer_id, original_size, original_bitrate, original_format, status, subtitle_stage, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(row.id, row.shared_title_id, row.season, row.number, row.duration, row.video_transfer_id,
             row.original_size, row.original_bitrate, row.original_format, row.status, row.subtitle_stage, row.updated_at).run();
      return Response.json(row);
    }

    const sharedEpisodeMatch = url.pathname.match(/^\/shared-episodes\/([A-Za-z0-9_-]+)$/);
    if (sharedEpisodeMatch && request.method === "PUT") {
      const id = sharedEpisodeMatch[1];
      const body = await request.json().catch(() => null) as {
        season?: number; number?: number; duration?: number | null; video_transfer_id?: string | null;
        actor_video_transfer_id?: string | null; original_filename?: string | null;
        translation_started_at?: string | null; sound_engineer_done_at?: string | null;
        cleaned_video_transfer_id?: string | null; cleaned_video_filename?: string | null;
        cleaned_video_uploaded_at?: string | null; cleaned_video_sent_to_sound_engineer_at?: string | null;
        original_size?: number | null; original_bitrate?: number | null; original_format?: string | null;
        status?: string; subtitle_stage?: string;
      } | null;
      const now = new Date().toISOString();
      await env.MODELS_DB.prepare(
        `UPDATE shared_episodes SET season = COALESCE(?, season), number = COALESCE(?, number),
         duration = ?, video_transfer_id = COALESCE(?, video_transfer_id),
         actor_video_transfer_id = COALESCE(?, actor_video_transfer_id),
         original_filename = COALESCE(?, original_filename),
         translation_started_at = COALESCE(?, translation_started_at),
         sound_engineer_done_at = COALESCE(?, sound_engineer_done_at),
         cleaned_video_transfer_id = COALESCE(?, cleaned_video_transfer_id),
         cleaned_video_filename = COALESCE(?, cleaned_video_filename),
         cleaned_video_uploaded_at = COALESCE(?, cleaned_video_uploaded_at),
         cleaned_video_sent_to_sound_engineer_at = COALESCE(?, cleaned_video_sent_to_sound_engineer_at),
         original_size = ?, original_bitrate = ?,
         original_format = ?, status = COALESCE(?, status), subtitle_stage = COALESCE(?, subtitle_stage), updated_at = ? WHERE id = ?`,
      ).bind(body?.season ?? null, body?.number ?? null, body?.duration ?? null, body?.video_transfer_id ?? null,
             body?.actor_video_transfer_id ?? null, body?.original_filename ?? null,
             body?.translation_started_at ?? null, body?.sound_engineer_done_at ?? null,
             body?.cleaned_video_transfer_id ?? null, body?.cleaned_video_filename ?? null,
             body?.cleaned_video_uploaded_at ?? null, body?.cleaned_video_sent_to_sound_engineer_at ?? null,
             body?.original_size ?? null, body?.original_bitrate ?? null, body?.original_format ?? null,
             body?.status ?? null, body?.subtitle_stage ?? null, now, id).run();
      return Response.json({ ok: true });
    }

    // Upserts who holds one role for this title (see backend
    // sync_service.py's push_title_role_assignment) — delete-then-insert
    // rather than leaning on the UNIQUE(shared_title_id, role) constraint,
    // since a null device_id (clearing an assignment) still needs the old
    // row gone. device_id: null clears the assignment entirely.
    const sharedTitleRoleMatch = url.pathname.match(/^\/shared-titles\/([A-Za-z0-9_-]+)\/role-assignment$/);
    if (sharedTitleRoleMatch && request.method === "PUT") {
      const sharedTitleId = sharedTitleRoleMatch[1];
      const body = await request.json().catch(() => null) as {
        role?: string; device_id?: string | null; display_name?: string | null;
      } | null;
      if (!body?.role) {
        return new Response("role is required", { status: 400 });
      }
      const now = new Date().toISOString();
      await env.MODELS_DB.prepare(
        "DELETE FROM shared_title_role_assignments WHERE shared_title_id = ? AND role = ?",
      ).bind(sharedTitleId, body.role).run();
      if (body.device_id) {
        await env.MODELS_DB.prepare(
          `INSERT INTO shared_title_role_assignments (id, shared_title_id, role, device_id, display_name, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(crypto.randomUUID(), sharedTitleId, body.role, body.device_id, body.display_name ?? body.device_id, now).run();
      }
      return Response.json({ ok: true });
    }

    // Upserts a deadline for one role (optionally one actor/character) on
    // one episode — same delete-then-insert shape as role-assignment above.
    // A null `deadline` in the body clears it (row is dropped entirely,
    // same as an unset deadline never having existed).
    const sharedEpisodeDeadlineMatch = url.pathname.match(/^\/shared-episodes\/([A-Za-z0-9_-]+)\/role-deadline$/);
    if (sharedEpisodeDeadlineMatch && request.method === "PUT") {
      const sharedEpisodeId = sharedEpisodeDeadlineMatch[1];
      const body = await request.json().catch(() => null) as {
        role?: string; character_id?: string | null; deadline?: string | null;
      } | null;
      if (!body?.role) {
        return new Response("role is required", { status: 400 });
      }
      const characterId = body.character_id ?? null;
      const now = new Date().toISOString();
      await env.MODELS_DB.prepare(
        "DELETE FROM shared_episode_role_deadlines WHERE shared_episode_id = ? AND role = ? AND character_id IS ?",
      ).bind(sharedEpisodeId, body.role, characterId).run();
      if (body.deadline) {
        await env.MODELS_DB.prepare(
          `INSERT INTO shared_episode_role_deadlines (id, shared_episode_id, role, character_id, deadline, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(crypto.randomUUID(), sharedEpisodeId, body.role, characterId, body.deadline, now).run();
      }
      return Response.json({ ok: true });
    }

    // Episode-level role-assignment override (see backend
    // sync_service.py's push_episode_role_assignment) — same
    // delete-then-insert shape as the title-level role-assignment route
    // above. device_id: null clears the override, falling back to the
    // title's own default.
    const sharedEpisodeRoleMatch = url.pathname.match(/^\/shared-episodes\/([A-Za-z0-9_-]+)\/role-assignment$/);
    if (sharedEpisodeRoleMatch && request.method === "PUT") {
      const sharedEpisodeId = sharedEpisodeRoleMatch[1];
      const body = await request.json().catch(() => null) as {
        role?: string; device_id?: string | null; display_name?: string | null;
      } | null;
      if (!body?.role) {
        return new Response("role is required", { status: 400 });
      }
      const now = new Date().toISOString();
      await env.MODELS_DB.prepare(
        "DELETE FROM shared_episode_role_assignments WHERE shared_episode_id = ? AND role = ?",
      ).bind(sharedEpisodeId, body.role).run();
      if (body.device_id) {
        await env.MODELS_DB.prepare(
          `INSERT INTO shared_episode_role_assignments (id, shared_episode_id, role, device_id, display_name, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(crypto.randomUUID(), sharedEpisodeId, body.role, body.device_id, body.display_name ?? body.device_id, now).run();
      }
      return Response.json({ ok: true });
    }

    const sharedTitleCharactersMatch = url.pathname.match(/^\/shared-titles\/([A-Za-z0-9_-]+)\/characters$/);
    if (sharedTitleCharactersMatch && request.method === "POST") {
      const sharedTitleId = sharedTitleCharactersMatch[1];
      const body = await request.json().catch(() => null) as {
        name?: string; code?: string | null; team_device_id?: string | null;
      } | null;
      if (!body?.name) {
        return new Response("name is required", { status: 400 });
      }
      const now = new Date().toISOString();
      const row = {
        id: crypto.randomUUID(), shared_title_id: sharedTitleId, name: body.name, code: body.code ?? null,
        team_device_id: body.team_device_id ?? null, updated_at: now,
      };
      await env.MODELS_DB.prepare(
        `INSERT INTO shared_characters (id, shared_title_id, name, code, team_device_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(row.id, row.shared_title_id, row.name, row.code, row.team_device_id, row.updated_at).run();
      return Response.json(row);
    }

    // Pushes a LATER team_device_id assignment (see routers/characters.py's
    // PUT /characters/{id}/team-actor) — the POST route above only ever
    // covers whatever was known at creation time; a character assigned to a
    // real team actor after the fact (or re-assigned to someone else) needs
    // this to actually reach teammates' installs via pull_and_merge, rather
    // than staying a local-only change on the assigning device.
    const sharedCharacterMatch = url.pathname.match(/^\/shared-characters\/([A-Za-z0-9_-]+)$/);
    if (sharedCharacterMatch && request.method === "PUT") {
      const id = sharedCharacterMatch[1];
      const body = await request.json().catch(() => null) as { team_device_id?: string | null } | null;
      const now = new Date().toISOString();
      await env.MODELS_DB.prepare(
        `UPDATE shared_characters SET team_device_id = ?, updated_at = ? WHERE id = ?`,
      ).bind(body?.team_device_id ?? null, now, id).run();
      return Response.json({ ok: true });
    }

    // Permanent delete of one character — confirmed live 2026-09-10 as the
    // root cause of a "duplicate persists forever" bug: the local DELETE
    // /characters/{id} (routers/characters.py) never told the cloud at
    // all, so a re-added actor got a BRAND NEW shared_characters row every
    // time (POST /characters' own find-or-create had nothing local left to
    // match against, but the old cloud row was still sitting there
    // unreachable) — visible in the Marker Manager Reaper script's cast
    // list as the same actor listed twice. Un-assigns (never deletes) any
    // subtitle lines/markers/audio submissions that referenced this
    // character, matching how a character removal already behaves locally
    // — removing a roster slot shouldn't destroy real subtitle/marker/
    // audio content, just its character tag.
    if (sharedCharacterMatch && request.method === "DELETE") {
      const id = sharedCharacterMatch[1];
      await env.MODELS_DB.batch([
        env.MODELS_DB.prepare("UPDATE shared_subtitle_lines SET character_id = NULL WHERE character_id = ?").bind(id),
        env.MODELS_DB.prepare("UPDATE shared_markers SET character_id = NULL WHERE character_id = ?").bind(id),
        env.MODELS_DB.prepare("UPDATE shared_audio_submissions SET character_id = NULL WHERE character_id = ?").bind(id),
        env.MODELS_DB.prepare("DELETE FROM shared_characters WHERE id = ?").bind(id),
      ]);
      return new Response(null, { status: 204 });
    }

    // Bulk replace, same posture as the local PUT /episodes/{id}/subtitle-lines
    // this mirrors — deletes everything for this shared episode and inserts
    // the given set fresh, returning the new rows (with fresh ids) so the
    // caller can stamp them back onto its own local rows' shared_id.
    const sharedEpisodeLinesMatch = url.pathname.match(/^\/shared-episodes\/([A-Za-z0-9_-]+)\/subtitle-lines$/);
    if (sharedEpisodeLinesMatch && request.method === "POST") {
      const sharedEpisodeId = sharedEpisodeLinesMatch[1];
      const body = await request.json().catch(() => null) as Array<{
        start_ms: number; end_ms: number; text?: string; character_id?: string | null;
        ass_style?: string; is_overlap?: boolean; layer?: number;
        margin_l?: number; margin_r?: number; margin_v?: number;
      }> | null;
      if (!Array.isArray(body)) {
        return new Response("expected a JSON array", { status: 400 });
      }
      const now = new Date().toISOString();
      const rows = body.map((l) => ({
        id: crypto.randomUUID(), shared_episode_id: sharedEpisodeId,
        start_ms: l.start_ms, end_ms: l.end_ms, text: l.text ?? "", character_id: l.character_id ?? null,
        ass_style: l.ass_style ?? "Default", is_overlap: l.is_overlap ? 1 : 0, layer: l.layer ?? 0,
        margin_l: l.margin_l ?? 0, margin_r: l.margin_r ?? 0, margin_v: l.margin_v ?? 0, updated_at: now,
      }));
      const stmts = [
        env.MODELS_DB.prepare("DELETE FROM shared_subtitle_lines WHERE shared_episode_id = ?").bind(sharedEpisodeId),
        ...rows.map((r) => env.MODELS_DB.prepare(
          `INSERT INTO shared_subtitle_lines (id, shared_episode_id, start_ms, end_ms, text, character_id, ass_style, is_overlap, layer, margin_l, margin_r, margin_v, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(r.id, r.shared_episode_id, r.start_ms, r.end_ms, r.text, r.character_id, r.ass_style, r.is_overlap, r.layer, r.margin_l, r.margin_r, r.margin_v, r.updated_at)),
      ];
      await env.MODELS_DB.batch(stmts);
      return Response.json(rows);
    }

    // Bulk replace, same shape as the subtitle-lines route above — see
    // backend/services/sync_service.py's push_markers, the only caller.
    const sharedEpisodeMarkersMatch = url.pathname.match(/^\/shared-episodes\/([A-Za-z0-9_-]+)\/markers$/);
    if (sharedEpisodeMarkersMatch && request.method === "POST") {
      const sharedEpisodeId = sharedEpisodeMarkersMatch[1];
      const body = await request.json().catch(() => null) as Array<{
        reaper_name: string; position_seconds: number; confirmed?: boolean;
        color?: string | null; character_id?: string | null;
      }> | null;
      if (!Array.isArray(body)) {
        return new Response("expected a JSON array", { status: 400 });
      }
      const now = new Date().toISOString();
      const rows = body.map((m) => ({
        id: crypto.randomUUID(), shared_episode_id: sharedEpisodeId,
        reaper_name: m.reaper_name, position_seconds: m.position_seconds,
        confirmed: m.confirmed ? 1 : 0, color: m.color ?? null, character_id: m.character_id ?? null,
        updated_at: now,
      }));
      const stmts = [
        env.MODELS_DB.prepare("DELETE FROM shared_markers WHERE shared_episode_id = ?").bind(sharedEpisodeId),
        ...rows.map((r) => env.MODELS_DB.prepare(
          `INSERT INTO shared_markers (id, shared_episode_id, reaper_name, position_seconds, confirmed, color, character_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(r.id, r.shared_episode_id, r.reaper_name, r.position_seconds, r.confirmed, r.color, r.character_id, r.updated_at)),
      ];
      await env.MODELS_DB.batch(stmts);
      return Response.json(rows);
    }

    // Lightweight read for one episode's markers (name/position/character
    // only, no color/id/updated_at) — lets the Reaper script's "Відправити
    // на сервер" diff against what's already there BEFORE posting, instead
    // of blindly re-inserting the whole REAPER project's marker list every
    // click (confirmed live 2026-09-10: every send duplicated every
    // already-sent marker, since the additive route below has no
    // dedup of its own — that's by design, it can't tell "already sent"
    // from "same marker independently placed twice" on its own; the
    // diffing has to happen client-side, which needs this read first).
    const sharedEpisodeMarkersGetMatch = url.pathname.match(/^\/shared-episodes\/([A-Za-z0-9_-]+)\/markers$/);
    if (sharedEpisodeMarkersGetMatch && request.method === "GET") {
      const sharedEpisodeId = sharedEpisodeMarkersGetMatch[1];
      const { results } = await env.MODELS_DB.prepare(
        "SELECT reaper_name, position_seconds, character_id FROM shared_markers WHERE shared_episode_id = ?",
      ).bind(sharedEpisodeId).all();
      return Response.json(results);
    }

    // Additive marker batch — one INSERT batch per call, NO delete first
    // (see the bulk-replace route right above, which the desktop app's own
    // push_markers relies on for its "local list is authoritative" push
    // model). This one exists for the standalone sound-engineer Reaper
    // script (2026-09-10, reaper-scripts/Marker Manager - RaccoonHouse.lua)
    // — it never has the episode's FULL marker set in front of it, only
    // whatever it placed in this one REAPER session, so a bulk-replace call
    // would wipe every marker anyone else already pushed. Same request/
    // response shape as the bulk-replace route otherwise. No auth (same
    // trust posture as the rest of this file) — anyone holding a real
    // shared_episode_id can append markers to it.
    const sharedEpisodeMarkersAddMatch = url.pathname.match(/^\/shared-episodes\/([A-Za-z0-9_-]+)\/markers\/add$/);
    if (sharedEpisodeMarkersAddMatch && request.method === "POST") {
      const sharedEpisodeId = sharedEpisodeMarkersAddMatch[1];
      const body = await request.json().catch(() => null) as Array<{
        reaper_name: string; position_seconds: number; confirmed?: boolean;
        color?: string | null; character_id?: string | null;
      }> | null;
      if (!Array.isArray(body)) {
        return new Response("expected a JSON array", { status: 400 });
      }
      const now = new Date().toISOString();
      const rows = body.map((m) => ({
        id: crypto.randomUUID(), shared_episode_id: sharedEpisodeId,
        reaper_name: m.reaper_name, position_seconds: m.position_seconds,
        confirmed: m.confirmed ? 1 : 0, color: m.color ?? null, character_id: m.character_id ?? null,
        updated_at: now,
      }));
      await env.MODELS_DB.batch(rows.map((r) => env.MODELS_DB.prepare(
        `INSERT INTO shared_markers (id, shared_episode_id, reaper_name, position_seconds, confirmed, color, character_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(r.id, r.shared_episode_id, r.reaper_name, r.position_seconds, r.confirmed, r.color, r.character_id, r.updated_at)));

      // Live nudge to every device on this team — confirmed live 2026-09-10
      // as the actual reason "Відправити на сервер" looked like it did
      // nothing in RaccoonHouse Studio: the insert above genuinely
      // succeeded, but nobody ever told an already-open desktop app to
      // pull fresh data, so the new markers only surfaced on the next
      // periodic catch-up sync (_online_signaling_loop's own 5-minute
      // fallback — see discovery_service.py). Every OTHER push path
      // (sync_service.py's push_markers etc.) goes through
      // /notify-team-content, which needs a team_device_id to exclude
      // (the pusher's own live connection) — the script has no such
      // device/WS identity at all, so this relays to literally every
      // team member instead of "everyone but the sender".
      const titleRow = await env.MODELS_DB.prepare(
        `SELECT st.team_id AS team_id FROM shared_episodes se
         JOIN shared_titles st ON st.id = se.shared_title_id WHERE se.id = ?`,
      ).bind(sharedEpisodeId).first<{ team_id: string }>();
      if (titleRow) {
        const { results: members } = await env.MODELS_DB.prepare(
          "SELECT device_id FROM team_members WHERE team_id = ?",
        ).bind(titleRow.team_id).all<{ device_id: string }>();
        const targetIds = members.map((m) => m.device_id);
        if (targetIds.length > 0) {
          const doId = env.PEER_REGISTRY.idFromName("global");
          const stub = env.PEER_REGISTRY.get(doId);
          await stub.fetch("https://do/relay-to-devices", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ targetIds, payload: { kind: "shared_content_updated", team_id: titleRow.team_id } }),
          }).catch(() => {}); // best-effort — the markers are already saved either way
        }
      }

      return Response.json(rows);
    }

    // Additive create — one row per "Здати" upload, NOT a bulk-replace
    // (unlike markers/lines above, each submission is an independent file
    // already sitting in R2 under its own transfer_id; re-pushing
    // everything on every new upload would be pointless). See
    // backend/services/sync_service.py's push_actor_audio_submission.
    const sharedEpisodeAudioMatch = url.pathname.match(/^\/shared-episodes\/([A-Za-z0-9_-]+)\/audio-submissions$/);
    if (sharedEpisodeAudioMatch && request.method === "POST") {
      const sharedEpisodeId = sharedEpisodeAudioMatch[1];
      const body = await request.json().catch(() => null) as {
        character_id?: string | null; filename: string; transfer_id: string;
        uploaded_by_device_id?: string | null; uploaded_by_name?: string;
        fix_of_submission_id?: string | null;
      } | null;
      if (!body?.filename || !body?.transfer_id) {
        return new Response("filename and transfer_id are required", { status: 400 });
      }
      const now = new Date().toISOString();
      const row = {
        id: crypto.randomUUID(), shared_episode_id: sharedEpisodeId, character_id: body.character_id ?? null,
        filename: body.filename, transfer_id: body.transfer_id,
        uploaded_by_device_id: body.uploaded_by_device_id ?? null,
        uploaded_by_name: body.uploaded_by_name ?? "?", created_at: now,
        fix_of_submission_id: body.fix_of_submission_id ?? null,
      };
      await env.MODELS_DB.prepare(
        `INSERT INTO shared_audio_submissions (id, shared_episode_id, character_id, filename, transfer_id, uploaded_by_device_id, uploaded_by_name, created_at, fix_of_submission_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(row.id, row.shared_episode_id, row.character_id, row.filename, row.transfer_id, row.uploaded_by_device_id, row.uploaded_by_name, row.created_at, row.fix_of_submission_id).run();
      return Response.json(row);
    }

    // Status update after creation (fix requested / forwarded to sound
    // engineer) — see backend sync_service.py's
    // push_actor_audio_submission_status, the only caller.
    const sharedAudioSubmissionStatusMatch = url.pathname.match(/^\/shared-audio-submissions\/([A-Za-z0-9_-]+)\/status$/);
    if (sharedAudioSubmissionStatusMatch && request.method === "PUT") {
      const id = sharedAudioSubmissionStatusMatch[1];
      const body = await request.json().catch(() => null) as {
        fix_requested_at?: string | null; fix_requested_by_role?: string | null;
        sent_to_sound_engineer_at?: string | null; fix_message?: string | null;
        accepted_at?: string | null; accepted_by_name?: string | null;
      } | null;
      await env.MODELS_DB.prepare(
        `UPDATE shared_audio_submissions SET
           fix_requested_at = COALESCE(?, fix_requested_at),
           fix_requested_by_role = COALESCE(?, fix_requested_by_role),
           sent_to_sound_engineer_at = COALESCE(?, sent_to_sound_engineer_at),
           fix_message = COALESCE(?, fix_message),
           accepted_at = COALESCE(?, accepted_at),
           accepted_by_name = COALESCE(?, accepted_by_name)
         WHERE id = ?`,
      ).bind(
        body?.fix_requested_at ?? null, body?.fix_requested_by_role ?? null, body?.sent_to_sound_engineer_at ?? null,
        body?.fix_message ?? null, body?.accepted_at ?? null, body?.accepted_by_name ?? null, id,
      ).run();
      return Response.json({ ok: true });
    }

    // Bulk-replace one submission's fix-marker set — see backend
    // sync_service.py's push_actor_audio_fix_markers, the only caller.
    // Same replace-the-whole-array shape as PUT /shared-episodes/:id/markers.
    const sharedAudioFixMarkersMatch = url.pathname.match(/^\/shared-audio-submissions\/([A-Za-z0-9_-]+)\/fix-markers$/);
    if (sharedAudioFixMarkersMatch && request.method === "PUT") {
      const submissionId = sharedAudioFixMarkersMatch[1];
      const rows = await request.json().catch(() => []) as Array<{
        id: string; label: string; position_seconds: number; color?: string | null;
      }>;
      const stmts = [
        env.MODELS_DB.prepare("DELETE FROM shared_actor_audio_fix_markers WHERE shared_submission_id = ?").bind(submissionId),
        ...rows.map((r) => env.MODELS_DB.prepare(
          `INSERT INTO shared_actor_audio_fix_markers (id, shared_submission_id, label, position_seconds, color)
           VALUES (?, ?, ?, ?, ?)`,
        ).bind(r.id, submissionId, r.label, r.position_seconds, r.color ?? null)),
      ];
      await env.MODELS_DB.batch(stmts);
      return Response.json(rows);
    }

    const sharedAudioSubmissionMatch = url.pathname.match(/^\/shared-audio-submissions\/([A-Za-z0-9_-]+)$/);
    if (sharedAudioSubmissionMatch && request.method === "DELETE") {
      const id = sharedAudioSubmissionMatch[1];
      await env.MODELS_DB.prepare("DELETE FROM shared_actor_audio_fix_markers WHERE shared_submission_id = ?").bind(id).run();
      await env.MODELS_DB.prepare("DELETE FROM shared_audio_submissions WHERE id = ?").bind(id).run();
      return new Response(null, { status: 204 });
    }

    // Permanent delete — cascades episodes/characters/subtitle_lines too.
    // Distinct from a plain local DELETE /titles/{id} (see backend
    // routers/titles.py's delete_title): removing ONLY the local mirror of
    // a shared title is by design resilient to that (pull_and_merge brings
    // it right back — see sync_service.py's own comment on why, e.g. a
    // local delete shouldn't destroy a teammate's work if it was a
    // mistake). This route is the actual "no, really, delete it
    // everywhere" action, called only when the local delete request
    // explicitly opts into it — see routers/titles.py's delete_title.
    const sharedTitleDeleteMatch = url.pathname.match(/^\/shared-titles\/([A-Za-z0-9_-]+)$/);
    if (sharedTitleDeleteMatch && request.method === "DELETE") {
      const titleId = sharedTitleDeleteMatch[1];
      const { results: eps } = await env.MODELS_DB.prepare(
        "SELECT id FROM shared_episodes WHERE shared_title_id = ?",
      ).bind(titleId).all<{ id: string }>();
      const stmts = [];
      for (const ep of eps) {
        stmts.push(env.MODELS_DB.prepare(
          `DELETE FROM shared_actor_audio_fix_markers WHERE shared_submission_id IN
           (SELECT id FROM shared_audio_submissions WHERE shared_episode_id = ?)`,
        ).bind(ep.id));
        stmts.push(env.MODELS_DB.prepare("DELETE FROM shared_subtitle_lines WHERE shared_episode_id = ?").bind(ep.id));
        stmts.push(env.MODELS_DB.prepare("DELETE FROM shared_markers WHERE shared_episode_id = ?").bind(ep.id));
        stmts.push(env.MODELS_DB.prepare("DELETE FROM shared_audio_submissions WHERE shared_episode_id = ?").bind(ep.id));
        stmts.push(env.MODELS_DB.prepare("DELETE FROM shared_episode_role_deadlines WHERE shared_episode_id = ?").bind(ep.id));
        stmts.push(env.MODELS_DB.prepare("DELETE FROM shared_episode_role_assignments WHERE shared_episode_id = ?").bind(ep.id));
      }
      stmts.push(env.MODELS_DB.prepare("DELETE FROM shared_episodes WHERE shared_title_id = ?").bind(titleId));
      stmts.push(env.MODELS_DB.prepare("DELETE FROM shared_characters WHERE shared_title_id = ?").bind(titleId));
      stmts.push(env.MODELS_DB.prepare("DELETE FROM shared_title_role_assignments WHERE shared_title_id = ?").bind(titleId));
      stmts.push(env.MODELS_DB.prepare("DELETE FROM shared_titles WHERE id = ?").bind(titleId));
      await env.MODELS_DB.batch(stmts);
      return new Response(null, { status: 204 });
    }

    // Permanent delete of ONE episode — same cascade as the title-level
    // route above, just scoped to a single shared_episode_id (see backend
    // sync_service.py's delete_shared_episode, called from
    // routers/episodes.py's delete_episode when explicitly asked for a
    // permanent delete).
    const sharedEpisodeDeleteMatch = url.pathname.match(/^\/shared-episodes\/([A-Za-z0-9_-]+)$/);
    if (sharedEpisodeDeleteMatch && request.method === "DELETE") {
      const episodeId = sharedEpisodeDeleteMatch[1];
      const stmts = [
        env.MODELS_DB.prepare(
          `DELETE FROM shared_actor_audio_fix_markers WHERE shared_submission_id IN
           (SELECT id FROM shared_audio_submissions WHERE shared_episode_id = ?)`,
        ).bind(episodeId),
        env.MODELS_DB.prepare("DELETE FROM shared_subtitle_lines WHERE shared_episode_id = ?").bind(episodeId),
        env.MODELS_DB.prepare("DELETE FROM shared_markers WHERE shared_episode_id = ?").bind(episodeId),
        env.MODELS_DB.prepare("DELETE FROM shared_audio_submissions WHERE shared_episode_id = ?").bind(episodeId),
        env.MODELS_DB.prepare("DELETE FROM shared_episode_role_deadlines WHERE shared_episode_id = ?").bind(episodeId),
        env.MODELS_DB.prepare("DELETE FROM shared_episode_role_assignments WHERE shared_episode_id = ?").bind(episodeId),
        env.MODELS_DB.prepare("DELETE FROM shared_episodes WHERE id = ?").bind(episodeId),
      ];
      await env.MODELS_DB.batch(stmts);
      return new Response(null, { status: 204 });
    }

    // Full current snapshot for a team — titles + episodes + characters +
    // subtitle-lines nested together. Always the full set (not a `since=`
    // incremental query) — expected scale is a handful of titles per team,
    // this avoids clock-skew bugs; only video bytes are ever large, and
    // those are fetched separately/lazily by video_transfer_id, not inline
    // here. See sync_service.py's pull_and_merge, the only caller.
    // Trimmed companion to the full GET /shared-titles below (2026-09-10) —
    // the standalone Marker Manager Reaper script only ever needs title/
    // episode names and the cast list, but the full route also nests every
    // episode's subtitle_lines/markers/audio_submissions/role_deadlines/
    // role_assignments (N+1 queries per episode). Confirmed live: one real
    // episode alone carried 163 markers — fetching+parsing all of that in
    // pure Lua (no JSON lib, ReaScript's only network path is shelling out
    // to curl) made the script visibly hang for a long time on connect.
    // This route is the fix: same team_id param, same top-level shape
    // (titles with nested episodes/characters) so the Lua script's parsing
    // code doesn't need two shapes, just far less data per title.
    if (url.pathname === "/shared-titles/summary" && request.method === "GET") {
      const teamId = url.searchParams.get("team_id");
      if (!teamId) {
        return new Response("team_id is required", { status: 400 });
      }
      const { results: titles } = await env.MODELS_DB.prepare(
        "SELECT id, name_ua, name_original, status FROM shared_titles WHERE team_id = ?",
      ).bind(teamId).all();
      const out = [];
      for (const title of titles as Array<{ id: string }>) {
        const [{ results: episodes }, { results: characters }] = await Promise.all([
          env.MODELS_DB.prepare("SELECT id, season, number FROM shared_episodes WHERE shared_title_id = ?").bind(title.id).all(),
          // team_device_id added 2026-09-10 — the Marker Manager Reaper
          // script filters its cast list to characters actually cast to a
          // real actor (or the "everyone" pseudo-actor), so an unassigned
          // character (team_device_id cleared) stops showing there without
          // needing a whole extra route.
          env.MODELS_DB.prepare("SELECT id, name, code, team_device_id FROM shared_characters WHERE shared_title_id = ?").bind(title.id).all(),
        ]);
        out.push({ ...title, episodes, characters });
      }
      return Response.json(out);
    }

    if (url.pathname === "/shared-titles" && request.method === "GET") {
      const teamId = url.searchParams.get("team_id");
      if (!teamId) {
        return new Response("team_id is required", { status: 400 });
      }
      const { results: titles } = await env.MODELS_DB.prepare(
        "SELECT * FROM shared_titles WHERE team_id = ?",
      ).bind(teamId).all();
      const out = [];
      for (const title of titles as Array<{ id: string }>) {
        const [{ results: episodes }, { results: characters }, { results: roleAssignments }] = await Promise.all([
          env.MODELS_DB.prepare("SELECT * FROM shared_episodes WHERE shared_title_id = ?").bind(title.id).all(),
          env.MODELS_DB.prepare("SELECT * FROM shared_characters WHERE shared_title_id = ?").bind(title.id).all(),
          env.MODELS_DB.prepare("SELECT * FROM shared_title_role_assignments WHERE shared_title_id = ?").bind(title.id).all(),
        ]);
        const episodesWithLines = await Promise.all((episodes as Array<{ id: string }>).map(async (ep) => {
          const [{ results: lines }, { results: markers }, { results: audioSubmissions }, { results: roleDeadlines }, { results: epRoleAssignments }] = await Promise.all([
            env.MODELS_DB.prepare("SELECT * FROM shared_subtitle_lines WHERE shared_episode_id = ?").bind(ep.id).all(),
            env.MODELS_DB.prepare("SELECT * FROM shared_markers WHERE shared_episode_id = ?").bind(ep.id).all(),
            env.MODELS_DB.prepare("SELECT * FROM shared_audio_submissions WHERE shared_episode_id = ?").bind(ep.id).all(),
            env.MODELS_DB.prepare("SELECT * FROM shared_episode_role_deadlines WHERE shared_episode_id = ?").bind(ep.id).all(),
            env.MODELS_DB.prepare("SELECT * FROM shared_episode_role_assignments WHERE shared_episode_id = ?").bind(ep.id).all(),
          ]);
          const audioSubmissionsWithFixMarkers = await Promise.all((audioSubmissions as Array<{ id: string }>).map(async (sub) => {
            const { results: fixMarkers } = await env.MODELS_DB.prepare(
              "SELECT * FROM shared_actor_audio_fix_markers WHERE shared_submission_id = ?",
            ).bind(sub.id).all();
            return { ...sub, fix_markers: fixMarkers };
          }));
          return {
            ...ep, subtitle_lines: lines, markers, audio_submissions: audioSubmissionsWithFixMarkers,
            role_deadlines: roleDeadlines, role_assignments: epRoleAssignments,
          };
        }));
        out.push({ ...title, episodes: episodesWithLines, characters, role_assignments: roleAssignments });
      }
      return Response.json(out);
    }

    // Admin -> any known user, direct (see backend
    // team_service.send_message_to_user / routers/teams.py's
    // POST /teams/users/{device_id}/message) — also reused by the per-actor
    // SRT handoff (actor_video_service.py), which passes respect_pause:true
    // since THAT one is an automated stage-handoff notification, unlike an
    // admin's own deliberately-composed message here, which still goes
    // through even while automated notifications are paused (see
    // areNotificationsPaused's own comment for why pausing exists at all).
    // App-admin gated at the backend level only, same trust posture as
    // /known-devices above.
    if (url.pathname === "/notify-device" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { device_id?: string; message?: string; respect_pause?: boolean } | null;
      const deviceId = (body?.device_id ?? "").toString();
      const message = (body?.message ?? "").toString().slice(0, 2000);
      if (!deviceId || !message) {
        return new Response("device_id and message are required", { status: 400 });
      }
      if (body?.respect_pause && (await areNotificationsPaused(env))) {
        return Response.json({ sent: 0 });
      }
      const device = await env.MODELS_DB.prepare(
        "SELECT telegram_id FROM known_devices WHERE device_id = ?",
      ).bind(deviceId).first<{ telegram_id: number | null }>();
      if (!device || device.telegram_id == null) {
        return Response.json({ sent: 0 });
      }
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: device.telegram_id, text: message }),
      }).catch(() => {});
      return Response.json({ sent: 1 });
    }

    // Апекс's canonical line-up — a single JSON blob (not one key per
    // model like feedback/reports) since the whole point is "everyone
    // converges on one shared list," not independent per-install entries.
    // Whoever's admin pushes a full replacement on every add/remove (see
    // backend/routers/separation_models.py); every other install pulls it
    // opportunistically whenever its own Апекс panel is opened (see
    // separator_service.py's sync_apex_models_from_remote) — never during
    // an actual separation run, so this endpoint being briefly unreachable
    // never blocks or alters an in-progress job.
    if (url.pathname === "/apex-models" && request.method === "PUT") {
      const body = await request.json().catch(() => null);
      if (!Array.isArray(body)) {
        return new Response("expected an array", { status: 400 });
      }
      await env.TRANSFERS.put("apex-models.json", JSON.stringify(body));
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/apex-models" && request.method === "GET") {
      const obj = await env.TRANSFERS.get("apex-models.json");
      if (!obj) return Response.json([]);
      return new Response(await obj.text(), { headers: { "Content-Type": "application/json" } });
    }

    // Master kill-switch for MVSep credit usage across the whole studio,
    // independent of any team's own credits_enabled flag or a person's
    // individual credit_grants row — both of those decide WHO is eligible,
    // this decides whether credit usage works AT ALL right now (e.g. the
    // admin ran out of MVSep balance and wants to pause everyone at once
    // without having to flip every team/person back off individually).
    // Also carries the studio's ONE shared MVSep api_token — every install
    // calls MVSep through this same account/credit pool, matching the
    // explicit requirement that adding credits later needs no app update.
    // App-admin only (see team_service.set_mvsep_enabled/set_mvsep_token),
    // same single-blob pattern as apex-models above — merges onto whatever
    // is already stored so toggling `enabled` can't accidentally wipe an
    // already-set `api_token` and vice versa.
    if (url.pathname === "/mvsep-config" && request.method === "PUT") {
      const body = await request.json().catch(() => null) as { enabled?: boolean; api_token?: string } | null;
      if (!body || (body.enabled === undefined && body.api_token === undefined)) {
        return new Response("enabled or api_token is required", { status: 400 });
      }
      const existingObj = await env.TRANSFERS.get("mvsep-config.json");
      const existing = existingObj ? await existingObj.json() as { enabled?: boolean; api_token?: string } : {};
      const merged = {
        enabled: body.enabled ?? existing.enabled ?? false,
        api_token: body.api_token ?? existing.api_token ?? "",
      };
      await env.TRANSFERS.put("mvsep-config.json", JSON.stringify(merged));
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/mvsep-config" && request.method === "GET") {
      // Full config INCLUDING api_token — only the backend calls this
      // directly (to make the actual MVSep request); routers/teams.py's
      // GET /teams/mvsep-config (what the frontend calls) strips api_token
      // before returning, same posture as password_hash elsewhere in this file.
      const obj = await env.TRANSFERS.get("mvsep-config.json");
      if (!obj) return Response.json({ enabled: false, api_token: "" });
      return new Response(await obj.text(), { headers: { "Content-Type": "application/json" } });
    }

    // Lets the admin bump the recommended audio-separator (the Python
    // separation library, not an app version) without shipping a new
    // RaccoonHouse release — see backend/services/lib_runtime_service.py,
    // which downloads and sys.path-swaps the wheel this points at, with the
    // user's explicit confirmation in Settings (never automatic/silent).
    // Same single-blob pattern as apex-models above: one shared value, not
    // per-install state.
    if (url.pathname === "/audio-separator-version" && request.method === "PUT") {
      const body = await request.json().catch(() => null) as { version?: string; wheel_url?: string } | null;
      if (!body || typeof body.version !== "string" || typeof body.wheel_url !== "string") {
        return new Response("expected {version, wheel_url}", { status: 400 });
      }
      await env.TRANSFERS.put("audio-separator-version.json", JSON.stringify(body));
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/audio-separator-version" && request.method === "GET") {
      const obj = await env.TRANSFERS.get("audio-separator-version.json");
      if (!obj) return Response.json(null);
      return new Response(await obj.text(), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/model-ratings" && request.method === "PUT") {
      const body = await request.json().catch(() => null) as Partial<ModelRating> | null;
      if (
        !body ||
        typeof body.method !== "string" ||
        typeof body.filename !== "string" ||
        typeof body.profile_name !== "string" ||
        typeof body.rating !== "number"
      ) {
        return new Response("method, filename, profile_name, rating are required", { status: 400 });
      }
      const item: ModelRating = {
        method: body.method.slice(0, 32),
        filename: body.filename.slice(0, 255),
        profile_name: body.profile_name.slice(0, 100),
        rating: Math.max(1, Math.min(5, Math.round(body.rating))),
        created_at: new Date().toISOString(),
      };
      await env.MODELS_DB.prepare(
        `INSERT INTO model_ratings (method, filename, profile_name, rating, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(method, filename, profile_name)
         DO UPDATE SET rating = excluded.rating, created_at = excluded.created_at`,
      ).bind(item.method, item.filename, item.profile_name, item.rating, item.created_at).run();
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/model-ratings" && request.method === "GET") {
      const method = url.searchParams.get("method");
      const stmt = method
        ? env.MODELS_DB.prepare("SELECT * FROM model_ratings WHERE method = ?").bind(method)
        : env.MODELS_DB.prepare("SELECT * FROM model_ratings");
      const { results } = await stmt.all<ModelRating>();
      return Response.json(results);
    }

    // Deletes every rating for one (method, filename) pair — called when a
    // catalog entry is removed (see DELETE /models/:id below), since
    // ratings are keyed by method+filename rather than the catalog row's
    // own id (multiple catalog entries could theoretically share a
    // filename across re-adds). Without this, deleting a model and
    // resubmitting the same file later silently resurrected its old
    // ratings — confirmed live as a real report.
    if (url.pathname === "/model-ratings" && request.method === "DELETE") {
      const method = url.searchParams.get("method");
      const filename = url.searchParams.get("filename");
      if (!method || !filename) {
        return new Response("method and filename query params are required", { status: 400 });
      }
      await env.MODELS_DB.prepare("DELETE FROM model_ratings WHERE method = ? AND filename = ?").bind(method, filename).run();
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/model-descriptions" && request.method === "PUT") {
      const body = await request.json().catch(() => null) as Partial<ModelDescription> | null;
      if (
        !body ||
        typeof body.filename !== "string" ||
        typeof body.description !== "string" ||
        typeof body.updated_by !== "string"
      ) {
        return new Response("filename, description, updated_by are required", { status: 400 });
      }
      const item: ModelDescription = {
        filename: body.filename.slice(0, 255),
        // Generous but bounded — this is a short "pros/cons" note, not a
        // free-form document; without a cap, D1's own row-size limits would
        // be the only thing stopping an unbounded paste.
        description: body.description.slice(0, 4000),
        updated_by: body.updated_by.slice(0, 100),
        updated_at: new Date().toISOString(),
      };
      await env.MODELS_DB.prepare(
        `INSERT INTO model_descriptions (filename, description, updated_by, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(filename)
         DO UPDATE SET description = excluded.description, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      ).bind(item.filename, item.description, item.updated_by, item.updated_at).run();
      return Response.json(item);
    }

    if (url.pathname === "/model-descriptions" && request.method === "GET") {
      const { results } = await env.MODELS_DB.prepare("SELECT * FROM model_descriptions").all<ModelDescription>();
      return Response.json(results);
    }

    if (url.pathname === "/teams" && request.method === "POST") {
      const body = await request.json().catch(() => null) as Partial<Team> | null;
      if (!body || typeof body.id !== "string" || typeof body.name !== "string" || typeof body.password_hash !== "string" || typeof body.created_by_device_id !== "string") {
        return new Response("id, name, password_hash, created_by_device_id are required", { status: 400 });
      }
      const team: Team = {
        id: body.id,
        name: body.name.slice(0, 100),
        password_hash: body.password_hash,
        credits_enabled: body.credits_enabled ? 1 : 0,
        created_by_device_id: body.created_by_device_id,
        created_at: new Date().toISOString(),
      };
      try {
        await env.MODELS_DB.prepare(
          `INSERT INTO teams (id, name, password_hash, credits_enabled, created_by_device_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(team.id, team.name, team.password_hash, team.credits_enabled, team.created_by_device_id, team.created_at).run();
      } catch {
        return new Response("team name already taken", { status: 409 });
      }
      // The creator is automatically the first team admin — otherwise a
      // freshly created team would have nobody able to invite into it.
      await env.MODELS_DB.prepare(
        `INSERT INTO team_members (team_id, device_id, display_name, is_team_admin, joined_at) VALUES (?, ?, ?, 1, ?)`,
      ).bind(team.id, team.created_by_device_id, "Адмін", team.created_at).run();
      const { password_hash, ...safe } = team;
      return Response.json(safe);
    }

    if (url.pathname === "/teams" && request.method === "GET") {
      // Never returns password_hash — this is the admin-dashboard listing
      // (see team_service.list_teams), not something used for auth.
      const { results } = await env.MODELS_DB.prepare(
        "SELECT id, name, credits_enabled, created_by_device_id, created_at FROM teams ORDER BY created_at",
      ).all();
      return Response.json(results);
    }

    if (url.pathname === "/teams/my-teams" && request.method === "GET") {
      const deviceId = url.searchParams.get("device_id");
      if (!deviceId) return new Response("device_id required", { status: 400 });
      const { results } = await env.MODELS_DB.prepare(
        `SELECT t.id, t.name, t.credits_enabled, m.is_team_admin
         FROM team_members m JOIN teams t ON t.id = m.team_id
         WHERE m.device_id = ?`,
      ).bind(deviceId).all();
      return Response.json(results);
    }

    if (url.pathname === "/teams/members" && request.method === "GET") {
      const teamId = url.searchParams.get("team_id");
      if (!teamId) return new Response("team_id required", { status: 400 });
      // roles joined in from known_devices (2026-09-09) — TeamsPage's own
      // member-management list is where a team admin now grants job-title
      // roles (see PUT /known-devices/:id/roles above), so it needs to show
      // each member's current roles, not just their team-admin flag.
      const { results } = await env.MODELS_DB.prepare(
        `SELECT tm.team_id, tm.device_id, tm.display_name, tm.is_team_admin, tm.joined_at, kd.roles AS roles
         FROM team_members tm LEFT JOIN known_devices kd ON kd.device_id = tm.device_id
         WHERE tm.team_id = ?`,
      ).bind(teamId).all<TeamMember & { roles: string | null }>();
      const withParsedRoles = results.map((r) => ({ ...r, roles: r.roles ? JSON.parse(r.roles) : [] }));
      return Response.json(withParsedRoles);
    }

    if (url.pathname === "/teams/members" && request.method === "DELETE") {
      const teamId = url.searchParams.get("team_id");
      const deviceId = url.searchParams.get("device_id");
      if (!teamId || !deviceId) return new Response("team_id and device_id required", { status: 400 });
      await env.MODELS_DB.prepare("DELETE FROM team_members WHERE team_id = ? AND device_id = ?").bind(teamId, deviceId).run();
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/teams/members/admin" && request.method === "PUT") {
      // Promotes/demotes an EXISTING member — team_service.set_team_admin
      // checks the caller is already a team admin (or app admin) of this
      // team before calling this.
      const body = await request.json().catch(() => null) as { team_id?: string; device_id?: string; is_team_admin?: boolean } | null;
      if (!body || typeof body.team_id !== "string" || typeof body.device_id !== "string" || typeof body.is_team_admin !== "boolean") {
        return new Response("team_id, device_id, is_team_admin are required", { status: 400 });
      }
      await env.MODELS_DB.prepare("UPDATE team_members SET is_team_admin = ? WHERE team_id = ? AND device_id = ?")
        .bind(body.is_team_admin ? 1 : 0, body.team_id, body.device_id).run();
      return new Response(null, { status: 204 });
    }

    // Renames a team (2026-09-09) — team_service.rename_team checks the
    // caller is a team admin (or app admin) of this exact team before
    // calling this, same trust posture as /teams/members/admin just above
    // (no re-check here, unlike PUT /known-devices/:id/roles, which trusts
    // less since ANY team admin can target ANY device_id there).
    const teamRenameMatch = url.pathname.match(/^\/teams\/([A-Za-z0-9_-]+)\/name$/);
    if (teamRenameMatch && request.method === "PUT") {
      const teamId = teamRenameMatch[1];
      const body = await request.json().catch(() => null) as { name?: string } | null;
      const name = body?.name?.trim();
      if (!name) return new Response("name is required", { status: 400 });
      try {
        await env.MODELS_DB.prepare("UPDATE teams SET name = ? WHERE id = ?").bind(name, teamId).run();
      } catch (e) {
        return new Response("Ця назва вже зайнята", { status: 409 });
      }
      return Response.json({ ok: true, name });
    }

    if (url.pathname === "/teams/by-name" && request.method === "GET") {
      // Resolves ONE team by its exact name — used by team_service.join_team
      // for "type the team name + password" joins. Deliberately doesn't
      // exist as a search/listing endpoint: a regular (non-app-admin) user
      // must not be able to discover teams they don't already know the
      // exact name of. Includes password_hash (unlike GET /teams above) —
      // this is how the backend verifies a join attempt; never forwarded to
      // the frontend itself (see team_service.join_team).
      const name = url.searchParams.get("name");
      if (!name) return new Response("name required", { status: 400 });
      const row = await env.MODELS_DB.prepare(
        "SELECT id, name, credits_enabled, password_hash FROM teams WHERE name = ?",
      ).bind(name).first();
      if (!row) return new Response("not found", { status: 404 });
      return Response.json(row);
    }

    if (url.pathname === "/teams/by-id" && request.method === "GET") {
      // Same "one team, not the whole list" reasoning as /teams/by-name,
      // but keyed by id — used by team_service.get_team for a team admin
      // to name-drop THEIR OWN team (e.g. in an invite notification)
      // without needing app-admin's full-listing permission. No
      // password_hash in the response, unlike /teams/by-name.
      const teamId = url.searchParams.get("team_id");
      if (!teamId) return new Response("team_id required", { status: 400 });
      const row = await env.MODELS_DB.prepare(
        "SELECT id, name, credits_enabled, created_by_device_id, created_at FROM teams WHERE id = ?",
      ).bind(teamId).first();
      if (!row) return new Response("not found", { status: 404 });
      return Response.json(row);
    }

    if (url.pathname === "/teams/invites" && request.method === "POST") {
      const body = await request.json().catch(() => null) as Partial<TeamInvite> | null;
      if (!body || typeof body.team_id !== "string" || typeof body.invited_device_id !== "string" || typeof body.created_by_device_id !== "string") {
        return new Response("team_id, invited_device_id, created_by_device_id are required", { status: 400 });
      }
      const invite: TeamInvite = {
        id: crypto.randomUUID(),
        team_id: body.team_id,
        invited_device_id: body.invited_device_id,
        created_by_device_id: body.created_by_device_id,
        created_at: new Date().toISOString(),
        status: "pending",
      };
      await env.MODELS_DB.prepare(
        `INSERT INTO team_invites (id, team_id, invited_device_id, created_by_device_id, created_at, status) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(invite.id, invite.team_id, invite.invited_device_id, invite.created_by_device_id, invite.created_at, invite.status).run();
      return Response.json(invite);
    }

    if (url.pathname === "/teams/invites" && request.method === "GET") {
      const deviceId = url.searchParams.get("device_id");
      if (!deviceId) return new Response("device_id required", { status: 400 });
      const { results } = await env.MODELS_DB.prepare(
        `SELECT i.id, i.team_id, t.name as team_name, i.created_at
         FROM team_invites i JOIN teams t ON t.id = i.team_id
         WHERE i.invited_device_id = ? AND i.status = 'pending'`,
      ).bind(deviceId).all();
      return Response.json(results);
    }

    if (url.pathname === "/teams/invites/respond" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { invite_id?: string; accept?: boolean; display_name?: string } | null;
      if (!body || typeof body.invite_id !== "string" || typeof body.accept !== "boolean") {
        return new Response("invite_id and accept are required", { status: 400 });
      }
      const invite = await env.MODELS_DB.prepare("SELECT * FROM team_invites WHERE id = ?").bind(body.invite_id).first<TeamInvite>();
      if (!invite || invite.status !== "pending") {
        return new Response("invite not found or already resolved", { status: 404 });
      }
      await env.MODELS_DB.prepare("UPDATE team_invites SET status = ? WHERE id = ?")
        .bind(body.accept ? "accepted" : "declined", body.invite_id).run();
      if (body.accept) {
        await env.MODELS_DB.prepare(
          `INSERT INTO team_members (team_id, device_id, display_name, is_team_admin, joined_at) VALUES (?, ?, ?, 0, ?)
           ON CONFLICT(team_id, device_id) DO NOTHING`,
        ).bind(invite.team_id, invite.invited_device_id, (body.display_name ?? "?").slice(0, 100), new Date().toISOString()).run();
      }
      return Response.json({ ok: true });
    }

    if (url.pathname === "/teams/join-requests" && request.method === "GET") {
      // Admin-facing list for TeamsPage.tsx's "Заявки на вступ" section —
      // scoped to one team at a time (the backend proxy checks the caller
      // is actually that team's admin before calling this, same gate
      // invite_member uses).
      const teamId = url.searchParams.get("team_id");
      if (!teamId) return new Response("team_id required", { status: 400 });
      const { results } = await env.MODELS_DB.prepare(
        `SELECT id, team_id, device_id, display_name, telegram_username, created_at
         FROM team_join_requests WHERE team_id = ? AND status = 'pending' ORDER BY created_at ASC`,
      ).bind(teamId).all();
      return Response.json(results);
    }

    if (url.pathname === "/teams/join-requests/respond" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { request_id?: string; accept?: boolean } | null;
      if (!body || typeof body.request_id !== "string" || typeof body.accept !== "boolean") {
        return new Response("request_id and accept are required", { status: 400 });
      }
      const reqRow = await env.MODELS_DB.prepare("SELECT * FROM team_join_requests WHERE id = ?").bind(body.request_id).first<TeamJoinRequest>();
      if (!reqRow || reqRow.status !== "pending") {
        return new Response("request not found or already resolved", { status: 404 });
      }
      await env.MODELS_DB.prepare("UPDATE team_join_requests SET status = ? WHERE id = ?")
        .bind(body.accept ? "accepted" : "declined", body.request_id).run();
      let teamName = reqRow.team_id;
      if (body.accept) {
        await env.MODELS_DB.prepare(
          `INSERT INTO team_members (team_id, device_id, display_name, is_team_admin, joined_at) VALUES (?, ?, ?, 0, ?)
           ON CONFLICT(team_id, device_id) DO NOTHING`,
        ).bind(reqRow.team_id, reqRow.device_id, reqRow.display_name.slice(0, 100), new Date().toISOString()).run();
        const team = await env.MODELS_DB.prepare("SELECT name FROM teams WHERE id = ?").bind(reqRow.team_id).first<{ name: string }>();
        if (team) teamName = team.name;
      }
      if (reqRow.telegram_id) {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: reqRow.telegram_id,
            text: body.accept
              ? `✅ Вашу заявку до команди «${teamName}» прийнято!`
              : `❌ Вашу заявку до команди «${teamName}» відхилено.`,
          }),
        }).catch(() => {});
      }
      return Response.json({ ok: true });
    }

    const teamCreditsMatch = url.pathname.match(/^\/teams\/([A-Za-z0-9]+)\/credits$/);
    if (teamCreditsMatch && request.method === "PUT") {
      // Lets the app admin flip a team's credits_enabled after creation, not
      // just at create-team time — team_service.set_team_credits already
      // checked the caller is the app admin.
      const body = await request.json().catch(() => null) as { enabled?: boolean } | null;
      if (!body || typeof body.enabled !== "boolean") {
        return new Response("enabled is required", { status: 400 });
      }
      await env.MODELS_DB.prepare("UPDATE teams SET credits_enabled = ? WHERE id = ?")
        .bind(body.enabled ? 1 : 0, teamCreditsMatch[1]).run();
      return new Response(null, { status: 204 });
    }

    // Generic /teams/:id — deliberately checked LAST among /teams/* routes
    // (after every literal sub-path like /teams/members, /teams/invites,
    // /teams/my-teams etc. above), since [A-Za-z0-9]+ would otherwise also
    // match those literal segments and shadow their own handlers.
    const teamIdMatch = url.pathname.match(/^\/teams\/([A-Za-z0-9]+)$/);
    if (teamIdMatch && request.method === "DELETE") {
      const teamId = teamIdMatch[1];
      await env.MODELS_DB.batch([
        env.MODELS_DB.prepare("DELETE FROM team_members WHERE team_id = ?").bind(teamId),
        env.MODELS_DB.prepare("DELETE FROM team_invites WHERE team_id = ?").bind(teamId),
        env.MODELS_DB.prepare("DELETE FROM team_join_requests WHERE team_id = ?").bind(teamId),
        env.MODELS_DB.prepare("DELETE FROM teams WHERE id = ?").bind(teamId),
      ]);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/credit-grants" && request.method === "GET") {
      const { results } = await env.MODELS_DB.prepare("SELECT * FROM credit_grants").all<CreditGrant>();
      return Response.json(results);
    }

    // Global pause/resume for automated notifications (see
    // areNotificationsPaused above) — App-admin gated at the backend level
    // only, same trust posture as everything else in this file. PUT both
    // flips the flag and (deliberately bypassing the pause check itself)
    // broadcasts one announcement to every known Telegram-linked user, so
    // people aren't left wondering why the bot suddenly went quiet — or
    // don't notice it's back.
    if (url.pathname === "/notification-settings" && request.method === "GET") {
      const row = await env.MODELS_DB.prepare("SELECT paused FROM notification_settings WHERE id = 1").first<{ paused: number }>();
      return Response.json({ paused: !!row?.paused });
    }

    if (url.pathname === "/notification-settings" && request.method === "PUT") {
      const body = await request.json().catch(() => null) as { paused?: boolean } | null;
      const paused = !!body?.paused;
      await env.MODELS_DB.prepare(
        `INSERT INTO notification_settings (id, paused, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET paused = excluded.paused, updated_at = excluded.updated_at`,
      ).bind(paused ? 1 : 0, new Date().toISOString()).run();

      const announcement = paused
        ? "Сповіщення тимчасово призупинені адміністратором студії — ви не отримуватимете нагадувань про нові серії/репліки, доки їх не увімкнуть знову."
        : "Сповіщення знову увімкнені — нагадування про нові серії/репліки надходитимуть як зазвичай.";
      const { results } = await env.MODELS_DB.prepare(
        "SELECT telegram_id FROM known_devices WHERE telegram_id IS NOT NULL",
      ).all<{ telegram_id: number }>();
      let notified = 0;
      for (const row of results) {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: row.telegram_id, text: announcement }),
        }).catch(() => {});
        notified++;
      }
      return Response.json({ paused, notified });
    }

    // Team-admin-driven role management (2026-09-09) — job-title roles are
    // no longer self-picked by the person themselves (see ProfileModal.tsx/
    // SettingsPage.tsx's own removed <RolePicker> self-edit spots); a team
    // admin grants them here instead, and ONLY for someone who's actually a
    // member of the SAME team the admin administers — both membership rows
    // are checked before the write, not just the admin's own status, so an
    // admin of team A can never touch a person who's only in team B (even
    // if that person happens to ALSO be in team A under a different
    // profile — matched by device_id, the one stable identity this app has).
    // See backend routers/teams.py's set_member_roles, the only caller.
    const knownDeviceRolesMatch = url.pathname.match(/^\/known-devices\/([A-Za-z0-9_-]+)\/roles$/);
    if (knownDeviceRolesMatch && request.method === "PUT") {
      const targetDeviceId = knownDeviceRolesMatch[1];
      const body = await request.json().catch(() => null) as {
        roles?: string[]; team_id?: string; admin_device_id?: string;
      } | null;
      if (!body?.team_id || !body?.admin_device_id || !Array.isArray(body.roles)) {
        return new Response("team_id, admin_device_id and roles are required", { status: 400 });
      }
      const adminRow = await env.MODELS_DB.prepare(
        "SELECT is_team_admin FROM team_members WHERE team_id = ? AND device_id = ?",
      ).bind(body.team_id, body.admin_device_id).first<{ is_team_admin: number }>();
      if (!adminRow || !adminRow.is_team_admin) {
        return new Response("Not a team admin of this team", { status: 403 });
      }
      const targetRow = await env.MODELS_DB.prepare(
        "SELECT 1 FROM team_members WHERE team_id = ? AND device_id = ?",
      ).bind(body.team_id, targetDeviceId).first();
      if (!targetRow) {
        return new Response("Target is not a member of this team", { status: 403 });
      }
      await env.MODELS_DB.prepare(
        "UPDATE known_devices SET roles = ? WHERE device_id = ?",
      ).bind(JSON.stringify(body.roles), targetDeviceId).run();
      return Response.json({ ok: true, roles: body.roles });
    }

    // A device's own current roles, as an admin may have last set them —
    // polled by the AFFECTED device itself (see backend sync_service.py's
    // periodic pull) rather than pushed live, since there's no per-device
    // WebSocket guaranteed connected at the moment an admin makes the
    // change. Not app-admin-gated like the bulk /known-devices list above —
    // a device asking for its OWN roles by its OWN id is not a privacy leak.
    const knownDeviceMatch2 = url.pathname.match(/^\/known-devices\/([A-Za-z0-9_-]+)$/);
    if (knownDeviceMatch2 && request.method === "GET") {
      const deviceId = knownDeviceMatch2[1];
      const row = await env.MODELS_DB.prepare(
        "SELECT device_id, roles FROM known_devices WHERE device_id = ?",
      ).bind(deviceId).first<{ device_id: string; roles: string | null }>();
      if (!row) return new Response("Not found", { status: 404 });
      return Response.json({ device_id: row.device_id, roles: row.roles ? JSON.parse(row.roles) : [] });
    }

    if (url.pathname === "/known-devices" && request.method === "GET") {
      // App-admin gated at the backend level (team_service.all_known_users),
      // not here — same trust posture as everything else in this file.
      const { results } = await env.MODELS_DB.prepare(
        "SELECT device_id, display_name, first_seen_at, last_seen_at, roles, telegram_id, telegram_username FROM known_devices ORDER BY last_seen_at DESC",
      ).all();
      return Response.json(results);
    }

    // "How loaded is the server" (2026-09-09, app admin only Settings ->
    // Адмін tab). Two very different stores, both reported:
    //  - D1 (MODELS_DB) holds only lightweight sync metadata — titles,
    //    episodes, characters, subtitle lines, markers, team/device rows.
    //    Confirmed live 2026-09-09 this stays under ~1MB even with a real
    //    team's data (11 episodes' worth) in it — that's correct, not a
    //    bug, because...
    //  - ...actual media (video/audio files in transit between studio PCs)
    //    passes through R2 (TRANSFERS) as a store-and-forward relay, and
    //    IS the real "how full" number the user cares about — confirmed
    //    live 2026-09-09 at 11.9 GB / 83 objects via `wrangler r2 bucket
    //    info`, while D1 was 0.7 MB. R2 has no querying-from-inside-a-
    //    Worker size API (unlike D1's meta.size_after), so this lists
    //    every object and sums `.size` — fine at this object count, would
    //    need cursor-paginated summing if it ever grows past ~1000 objects.
    //  `percent_of_free_tier` is R2's used bytes against Cloudflare's
    //  documented 10GB/month free R2 storage allowance — not a hard quota
    //  (R2 is pay-as-you-go beyond it), but the one concrete, externally
    //  documented number to measure "how full" against without needing an
    //  account-level Cloudflare API token (which this Worker doesn't have
    //  — see TELEGRAM_BOT_TOKEN being the only secret configured).
    // App-admin gated at the backend level, same trust posture as
    // everything else here — see team_service.get_server_stats, the only
    // caller.
    if (url.pathname === "/admin/db-stats" && request.method === "GET") {
      const result = await env.MODELS_DB.prepare("SELECT 1").run();
      const dbBytes = (result.meta as { size_after?: number } | undefined)?.size_after ?? 0;

      let r2Bytes = 0;
      let r2Objects = 0;
      let cursor: string | undefined;
      do {
        const listed: R2Objects = await env.TRANSFERS.list(cursor ? { cursor, limit: 1000 } : { limit: 1000 });
        for (const o of listed.objects) r2Bytes += o.size;
        r2Objects += listed.objects.length;
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);

      const R2_FREE_TIER_BYTES = 10 * 1024 * 1024 * 1024; // Cloudflare's documented 10GB/month free R2 storage allowance
      return Response.json({
        db_bytes: dbBytes,
        r2_bytes: r2Bytes,
        r2_object_count: r2Objects,
        percent_of_free_tier: Math.round((r2Bytes / R2_FREE_TIER_BYTES) * 1000) / 10,
      });
    }

    // Diagnostic companion to /admin/db-stats above (2026-09-09) — the
    // percentage alone doesn't say WHAT's actually sitting in R2, and
    // /transfer/:id objects are supposed to be temporary store-and-forward
    // relay copies (deleted by discovery_service.delete_transfer once the
    // receiving side finishes downloading — see this file's own top
    // comment). If the real number is dominated by objects that were never
    // cleaned up (an interrupted transfer, a deleted episode whose cleanup
    // call never fired, etc.) that's a different fix than "buy more R2."
    // Not wired into any frontend UI yet — used directly via curl for this
    // one investigation.
    if (url.pathname === "/admin/r2-objects" && request.method === "GET") {
      const objects: { key: string; size: number; uploaded: string }[] = [];
      let cursor: string | undefined;
      do {
        const listed: R2Objects = await env.TRANSFERS.list(cursor ? { cursor, limit: 1000 } : { limit: 1000 });
        for (const o of listed.objects) objects.push({ key: o.key, size: o.size, uploaded: o.uploaded.toISOString() });
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
      objects.sort((a, b) => b.size - a.size);
      return Response.json(objects);
    }

    // One-time cleanup for the leak found+fixed 2026-09-09 (sync_service.py's
    // _push_episode_video / cleaner_service.py's _run_submit_cleaned_video
    // never deleted the PREVIOUS R2 copy before overwriting the pointer —
    // now fixed going forward, this clears out what already accumulated).
    // Only ever deletes "rh-team-video-*" objects (the full original video,
    // sync_service.py's own upload — confirmed gated on `title.shared_id`,
    // so shared_episodes.video_transfer_id is a fully authoritative
    // "what's still live" list for this ONE prefix) that aren't any shared
    // episode's current video_transfer_id, plus known throwaway debug junk
    // (rh-test-*/smoketest456 from earlier dev-session diagnostic scripts).
    // Deliberately leaves rh-team-actorvideo-/-cleanedvideo-/-actoraudio-
    // alone — those aren't share-gated the same way (a purely local/
    // unshared title can still have a live actor-video handoff in R2 with
    // no D1 row to cross-reference against), so a blind cross-check there
    // risks deleting something still in active use. Requires
    // ?confirm=yes-delete so this never fires by accident.
    if (url.pathname === "/admin/cleanup-transfers" && request.method === "POST") {
      if (url.searchParams.get("confirm") !== "yes-delete") {
        return new Response("Pass ?confirm=yes-delete to actually run this", { status: 400 });
      }
      const liveRows = await env.MODELS_DB.prepare(
        "SELECT video_transfer_id FROM shared_episodes WHERE video_transfer_id IS NOT NULL"
      ).all<{ video_transfer_id: string }>();
      const liveVideoIds = new Set(liveRows.results.map((r) => r.video_transfer_id));

      let deletedCount = 0;
      let freedBytes = 0;
      const deletedKeys: string[] = [];
      let cursor: string | undefined;
      do {
        const listed: R2Objects = await env.TRANSFERS.list(cursor ? { cursor, limit: 1000 } : { limit: 1000 });
        for (const o of listed.objects) {
          const isOrphanedVideo = o.key.startsWith("rh-team-video-") && !liveVideoIds.has(o.key);
          const isDebugJunk = o.key.startsWith("rh-test-") || o.key === "smoketest456";
          if (isOrphanedVideo || isDebugJunk) {
            await env.TRANSFERS.delete(o.key);
            deletedCount++;
            freedBytes += o.size;
            deletedKeys.push(o.key);
          }
        }
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);

      return Response.json({ deleted_count: deletedCount, freed_bytes: freedBytes, deleted_keys: deletedKeys });
    }

    // Full wipe (2026-09-09), explicitly requested after the scoped
    // /admin/cleanup-transfers above — deletes EVERY object in the bucket,
    // no exceptions (live episode videos, actor audio/hardsub, error
    // reports, feedback, the Apex model catalog config, MVSep config,
    // telegram-login codes, all of it). D1 rows (shared_episodes etc.)
    // are untouched — this only empties the R2 bucket the transfer_ids
    // point at, so any surviving shared_episodes.video_transfer_id etc.
    // will just 404 on next download until re-synced. Requires
    // ?confirm=wipe-everything so this can never fire by accident.
    if (url.pathname === "/admin/wipe-r2" && request.method === "POST") {
      if (url.searchParams.get("confirm") !== "wipe-everything") {
        return new Response("Pass ?confirm=wipe-everything to actually run this", { status: 400 });
      }
      let deletedCount = 0;
      let freedBytes = 0;
      let cursor: string | undefined;
      do {
        const listed: R2Objects = await env.TRANSFERS.list(cursor ? { cursor, limit: 1000 } : { limit: 1000 });
        for (const o of listed.objects) {
          await env.TRANSFERS.delete(o.key);
          deletedCount++;
          freedBytes += o.size;
        }
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
      return Response.json({ deleted_count: deletedCount, freed_bytes: freedBytes });
    }

    // Precise per-user cleanup for the admin "База даних" tab — deletes
    // just this device's identity + memberships, NOT any shared_titles/
    // episodes/characters/subtitle_lines content (see team_service.
    // delete_known_user's own docstring: this exists so QA/test profiles
    // don't pile up in the shared production D1, without risking real
    // teams' shared content). App-admin gated at the backend level, same
    // posture as the rest of this file.
    const knownDeviceMatch = url.pathname.match(/^\/known-devices\/([A-Za-z0-9_-]+)$/);
    if (knownDeviceMatch && request.method === "DELETE") {
      const deviceId = knownDeviceMatch[1];
      await env.MODELS_DB.batch([
        env.MODELS_DB.prepare("DELETE FROM known_devices WHERE device_id = ?").bind(deviceId),
        env.MODELS_DB.prepare("DELETE FROM team_members WHERE device_id = ?").bind(deviceId),
        env.MODELS_DB.prepare("DELETE FROM credit_grants WHERE device_id = ?").bind(deviceId),
        env.MODELS_DB.prepare("DELETE FROM team_invites WHERE invited_device_id = ? OR created_by_device_id = ?").bind(deviceId, deviceId),
        env.MODELS_DB.prepare("DELETE FROM team_join_requests WHERE device_id = ?").bind(deviceId),
      ]);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/credit-grants" && request.method === "PUT") {
      const body = await request.json().catch(() => null) as Partial<CreditGrant> | null;
      if (!body || typeof body.device_id !== "string" || typeof body.granted_by_device_id !== "string") {
        return new Response("device_id, granted_by_device_id are required", { status: 400 });
      }
      const grant: CreditGrant = {
        device_id: body.device_id,
        enabled: body.enabled ? 1 : 0,
        granted_by_device_id: body.granted_by_device_id,
        updated_at: new Date().toISOString(),
      };
      await env.MODELS_DB.prepare(
        `INSERT INTO credit_grants (device_id, enabled, granted_by_device_id, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET enabled = excluded.enabled, granted_by_device_id = excluded.granted_by_device_id, updated_at = excluded.updated_at`,
      ).bind(grant.device_id, grant.enabled, grant.granted_by_device_id, grant.updated_at).run();
      return Response.json(grant);
    }

    // Model Browser catalog — models added by hand or via the AI
    // auto-configure flow below (audio-separator's own built-in registry is
    // read straight from the library elsewhere, not stored here).
    if (url.pathname === "/models/auto-configure" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { url?: string } | null;
      if (!body?.url) {
        return new Response("url is required", { status: 400 });
      }
      try {
        const config = await autoConfigureModel(env, body.url);
        return Response.json(config);
      } catch (err) {
        return new Response(`Auto-configure failed: ${err instanceof Error ? err.message : String(err)}`, { status: 502 });
      }
    }

    if (url.pathname === "/models" && request.method === "GET") {
      const method = url.searchParams.get("method");
      const stmt = method
        ? env.MODELS_DB.prepare("SELECT * FROM models WHERE method = ? ORDER BY created_at DESC").bind(method)
        : env.MODELS_DB.prepare("SELECT * FROM models ORDER BY created_at DESC");
      const { results } = await stmt.all<ModelRow>();
      return Response.json(results);
    }

    if (url.pathname === "/models" && request.method === "POST") {
      const body = await request.json().catch(() => null) as Partial<ModelRow> | null;
      if (
        !body ||
        !SUPPORTED_METHODS.includes(body.method as (typeof SUPPORTED_METHODS)[number]) ||
        !SUPPORTED_ARCHS.includes(body.arch as (typeof SUPPORTED_ARCHS)[number]) ||
        typeof body.filename !== "string" || !body.filename ||
        typeof body.download_url !== "string" || !body.download_url ||
        typeof body.label !== "string" || !body.label ||
        typeof body.source_url !== "string" || !body.source_url
      ) {
        return new Response("method, arch, filename, download_url, label, source_url are required", { status: 400 });
      }
      const item: ModelRow = {
        id: crypto.randomUUID(),
        method: body.method!,
        filename: body.filename.slice(0, 255),
        label: body.label.slice(0, 255),
        arch: body.arch!,
        download_url: normalizeHfUrl(body.download_url.slice(0, 2000)),
        config_yaml_url: body.config_yaml_url ? normalizeHfUrl(String(body.config_yaml_url).slice(0, 2000)) : null,
        source_url: body.source_url.slice(0, 2000),
        added_by: (body.added_by ?? "Анонім").toString().slice(0, 100),
        is_custom: 1,
        notes: body.notes ? String(body.notes).slice(0, 2000) : null,
        created_at: new Date().toISOString(),
      };
      await env.MODELS_DB.prepare(
        `INSERT INTO models (id, method, filename, label, arch, download_url, config_yaml_url, source_url, added_by, is_custom, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(filename) DO UPDATE SET
           method = excluded.method, label = excluded.label, arch = excluded.arch, download_url = excluded.download_url,
           config_yaml_url = excluded.config_yaml_url, source_url = excluded.source_url,
           added_by = excluded.added_by, notes = excluded.notes`,
      ).bind(
        item.id, item.method, item.filename, item.label, item.arch, item.download_url,
        item.config_yaml_url, item.source_url, item.added_by, item.is_custom, item.notes, item.created_at,
      ).run();
      return Response.json(item);
    }

    const modelIdMatch = url.pathname.match(/^\/models\/([A-Za-z0-9_-]+)$/);
    if (modelIdMatch && request.method === "GET") {
      const row = await env.MODELS_DB.prepare("SELECT * FROM models WHERE id = ?").bind(modelIdMatch[1]).first<ModelRow>();
      if (!row) return new Response("Not found", { status: 404 });
      return Response.json(row);
    }
    if (modelIdMatch && request.method === "DELETE") {
      await env.MODELS_DB.prepare("DELETE FROM models WHERE id = ?").bind(modelIdMatch[1]).run();
      return new Response(null, { status: 204 });
    }

    // Telegram login — a short-lived one-time `code` the Electron app
    // generates itself before opening the embedded widget page, ties the
    // three steps together (open page -> Telegram signs the user in ->
    // Electron polls for the result) without needing a custom URL scheme
    // registered with the installer. Verified-but-unclaimed logins are
    // stored under a single R2 key per code and deleted the moment they're
    // polled once (or expire on their own — see the 10-minute check in the
    // poll handler below — if the user just closes the window instead).
    if (url.pathname === "/telegram-login" && request.method === "GET") {
      const code = url.searchParams.get("code");
      if (!code) return new Response("code is required", { status: 400 });
      return new Response(telegramLoginPageHtml(code), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/telegram-login/callback" && request.method === "POST") {
      const code = url.searchParams.get("code");
      if (!code) return new Response("code is required", { status: 400 });
      const body = await request.json().catch(() => null) as Record<string, string> | null;
      if (!body || typeof body.id !== "string" && typeof body.id !== "number") {
        return new Response("invalid payload", { status: 400 });
      }
      const stringified: Record<string, string> = {};
      for (const [k, v] of Object.entries(body)) stringified[k] = String(v);
      const ok = await verifyTelegramAuth(stringified, env.TELEGRAM_BOT_TOKEN);
      if (!ok) return new Response("Telegram signature verification failed", { status: 403 });
      await env.TRANSFERS.put(`telegram-login/${code}.json`, JSON.stringify({
        telegram_id: Number(body.id),
        first_name: body.first_name || "",
        last_name: body.last_name || "",
        username: body.username || "",
        photo_url: body.photo_url || "",
        created_at: Date.now(),
      }));
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/telegram-login/poll" && request.method === "GET") {
      const code = url.searchParams.get("code");
      if (!code) return new Response("code is required", { status: 400 });
      const key = `telegram-login/${code}.json`;
      const obj = await env.TRANSFERS.get(key);
      if (!obj) return new Response(null, { status: 202 }); // still waiting
      const data = await obj.json<{ created_at: number }>();
      await env.TRANSFERS.delete(key); // one-time use — a stolen/guessed code can't replay an old login
      if (Date.now() - data.created_at > 10 * 60 * 1000) {
        return new Response("Login expired — try again", { status: 410 });
      }
      return Response.json(data);
    }

    // Alternative to the widget page above — a bot deep-link (t.me/<bot>?
    // start=<code>, opened via Electron's shell.openExternal, no embedded
    // window at all) that hands off straight to the user's own already-
    // logged-in Telegram (desktop app if installed, else web.telegram.org),
    // no phone number/code re-entry needed since Telegram itself already
    // knows who they are. Telegram calls this webhook itself (registered
    // once via https://api.telegram.org/bot<token>/setWebhook) the moment
    // the person taps "START" in the resulting chat with the bot — the
    // message IS "/start <code>", and message.from is Telegram's own
    // already-authenticated sender info, so there's no HMAC to check here
    // the way the widget callback needs (see verifyTelegramAuth) — the
    // message only exists at all because Telegram's own servers routed it
    // from a real logged-in account to our bot.
    if (url.pathname === "/telegram-bot/webhook" && request.method === "POST") {
      const update = await request.json().catch(() => null) as {
        message?: { text?: string; from?: { id: number; first_name?: string; last_name?: string; username?: string } };
      } | null;
      const message = update?.message;
      const match = message?.text?.match(/^\/start\s+(\S+)/);
      if (match && message?.from) {
        const code = match[1];
        const from = message.from;
        await env.TRANSFERS.put(`telegram-login/${code}.json`, JSON.stringify({
          telegram_id: from.id,
          first_name: from.first_name || "",
          last_name: from.last_name || "",
          username: from.username || "",
          // Our own proxy URL (see fetchTelegramAvatar) — never the raw
          // Telegram file URL, which would leak the bot token.
          photo_url: `${url.origin}/telegram-avatar/${from.id}`,
          created_at: Date.now(),
        }));
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: from.id,
            text: "✅ Вхід підтверджено! Повертайтеся до RaccoonHouse Studio.",
          }),
        }).catch(() => {}); // best-effort — a failed confirmation message shouldn't fail the login itself
      }

      // `join <team_id>` — lets a person who has already logged into the app
      // via Telegram once (so their telegram_id is on file in known_devices,
      // see the /start block above) request to join a team without an admin
      // having to type their device_id by hand. Creates a pending
      // team_join_requests row; team admins accept/decline it from
      // TeamsPage.tsx's "Заявки на вступ" section. Does NOT touch
      // team_invites or /teams/join (name+password) at all — additional
      // path, not a replacement.
      const joinMatch = message?.text?.match(/^join\s+(\S+)/i);
      if (joinMatch && message?.from) {
        const teamId = joinMatch[1].trim();
        const from = message.from;
        const reply = (text: string) =>
          fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: from.id, text }),
          }).catch(() => {});

        const device = await env.MODELS_DB.prepare(
          "SELECT device_id, display_name FROM known_devices WHERE telegram_id = ? ORDER BY last_seen_at DESC LIMIT 1",
        ).bind(from.id).first<{ device_id: string; display_name: string }>();
        if (!device) {
          await reply("Спочатку увійдіть у RaccoonHouse Studio через Telegram (кнопка входу в застосунку), а потім повторіть команду join.");
          return new Response("OK");
        }

        const team = await env.MODELS_DB.prepare("SELECT id, name FROM teams WHERE id = ?").bind(teamId).first<{ id: string; name: string }>();
        if (!team) {
          await reply("Команду з таким ID не знайдено. Перевірте ID — адмін команди може скопіювати його у вкладці «Команди».");
          return new Response("OK");
        }

        const alreadyMember = await env.MODELS_DB.prepare(
          "SELECT 1 FROM team_members WHERE team_id = ? AND device_id = ?",
        ).bind(team.id, device.device_id).first();
        if (alreadyMember) {
          await reply(`Ви вже у складі команди «${team.name}».`);
          return new Response("OK");
        }

        const alreadyPending = await env.MODELS_DB.prepare(
          "SELECT 1 FROM team_join_requests WHERE team_id = ? AND device_id = ? AND status = 'pending'",
        ).bind(team.id, device.device_id).first();
        if (alreadyPending) {
          await reply(`Заявку на вступ до команди «${team.name}» вже надіслано, очікуйте підтвердження адміна.`);
          return new Response("OK");
        }

        await env.MODELS_DB.prepare(
          `INSERT INTO team_join_requests (id, team_id, device_id, display_name, telegram_id, telegram_username, created_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
        ).bind(
          crypto.randomUUID(), team.id, device.device_id, device.display_name,
          from.id, from.username || null, new Date().toISOString(),
        ).run();

        await reply(`Заявку на вступ до команди «${team.name}» надіслано. Очікуйте підтвердження адміна.`);

        const { results: admins } = await env.MODELS_DB.prepare(
          `SELECT kd.telegram_id AS telegram_id FROM team_members tm
           JOIN known_devices kd ON kd.device_id = tm.device_id
           WHERE tm.team_id = ? AND tm.is_team_admin = 1 AND kd.telegram_id IS NOT NULL`,
        ).bind(team.id).all<{ telegram_id: number }>();
        for (const admin of admins) {
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: admin.telegram_id,
              text: `Нова заявка на вступ до команди «${team.name}» від ${device.display_name}. Прийняти чи відхилити можна у вкладці «Команди» → «Заявки на вступ».`,
            }),
          }).catch(() => {});
        }
        return new Response("OK");
      }

      return new Response("OK"); // Telegram just needs any 200 — the content is ignored
    }

    const avatarMatch = url.pathname.match(/^\/telegram-avatar\/(\d+)$/);
    if (avatarMatch && request.method === "GET") {
      return fetchTelegramAvatar(avatarMatch[1], env.TELEGRAM_BOT_TOKEN);
    }

    const id = transferId(url);
    if (id !== null) {
      if (request.method === "PUT") {
        // Single-shot path — still used directly for anything under the
        // request body cap (most inputs: original audio/video, FLAC extracts).
        // Streamed straight into R2 — request.body is a ReadableStream, so
        // this never buffers the whole file in the Worker's memory.
        await env.TRANSFERS.put(id, request.body);
        return new Response(null, { status: 204 });
      }
      if (request.method === "GET") {
        // Range support — needed for the admin team-content preview's
        // video player (see team_service.admin_preview_team_content) to
        // seek/scrub without downloading the whole file first. Passing the
        // request's own Headers lets R2 parse the Range header itself
        // (R2GetOptions.range accepts a Headers object directly) — a plain
        // single-shot GET (no Range header, e.g. a "Завантажити" download
        // link) keeps working exactly as before, R2 just serves the whole
        // object when there's nothing to parse.
        const obj = await env.TRANSFERS.get(id, { range: request.headers });
        if (obj === null) {
          return new Response("Not found", { status: 404 });
        }
        const totalSize = obj.size;
        const resolvedRange = obj.range as { offset?: number; length?: number } | undefined;
        const isPartial = !!resolvedRange && resolvedRange.offset !== undefined && resolvedRange.length !== undefined;
        const headers: Record<string, string> = {
          "Content-Length": String(isPartial ? (resolvedRange as { length: number }).length : totalSize),
          "Accept-Ranges": "bytes",
        };
        if (isPartial) {
          const { offset, length } = resolvedRange as { offset: number; length: number };
          headers["Content-Range"] = `bytes ${offset}-${offset + length - 1}/${totalSize}`;
        }
        // Browser-download-facing transfers (actor video/SRT handoff — see
        // actor_video_service.py's transfer_id naming) had no Content-Type
        // or filename at all, so a plain window.open() download landed in
        // the browser's save dialog as an extension-less blob named after
        // the raw transfer id (confirmed live 2026-08-18: "не видео
        // скачивает, а непонятно что"). Peer-to-peer power-share transfers
        // (plain UUIDs, no "rh-team-" prefix) are consumed programmatically,
        // never through a browser save dialog, so they're left as before.
        // ?filename= lets the caller (see actor_video_service.py's
        // _build_video_filename) request the actual studio-facing name
        // ({team}_{title}_S{season}_E{episode}_480p_hardsub.mp4) instead of
        // the generic default below.
        const requestedFilename = url.searchParams.get("filename");
        if (requestedFilename) {
          headers["Content-Type"] = contentTypeForFilename(requestedFilename, id);
          headers["Content-Disposition"] = `attachment; filename="${requestedFilename.replace(/"/g, "")}"`;
        } else if (id.includes("actorvideo") || (id.includes("rh-team-video-"))) {
          headers["Content-Type"] = "video/mp4";
          headers["Content-Disposition"] = `attachment; filename="episode.mp4"`;
        } else if (id.includes("actorsrt")) {
          headers["Content-Type"] = "text/plain; charset=utf-8";
          headers["Content-Disposition"] = `attachment; filename="subtitles.srt"`;
        }
        return new Response(obj.body, { status: isPartial ? 206 : 200, headers });
      }
      if (request.method === "DELETE") {
        await env.TRANSFERS.delete(id);
        return new Response(null, { status: 204 });
      }
      return new Response("Method not allowed", { status: 405 });
    }

    const doId = env.PEER_REGISTRY.idFromName("global");
    const stub = env.PEER_REGISTRY.get(doId);
    return stub.fetch(request);
  },
};
