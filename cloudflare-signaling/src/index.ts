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
}

export class PeerRegistry {
  ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  async fetch(request: Request): Promise<Response> {
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
    } satisfies PeerAttachment);

    return new Response(null, { status: 101, webSocket: client });
  }

  private peerList(): PeerAttachment[] {
    return this.ctx.getWebSockets().map((ws) => ws.deserializeAttachment() as PeerAttachment);
  }

  private broadcastPeerList() {
    const peers = this.peerList().filter((p) => p.port > 0); // skip pre-hello sockets
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
      } satisfies PeerAttachment);
      // The client has no other way to know which entry in the broadcasted
      // peer list is itself (it doesn't know its own public IP, and several
      // peers could plausibly share a name) — tell it directly, once, so it
      // can filter its own id out of every "peers" message from here on.
      ws.send(JSON.stringify({ type: "welcome", your_id: clientId }));
      this.broadcastPeerList();
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
        if (attachment.id === targetId) {
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
      const body = await request.json().catch(() => null) as { nickname?: string; message?: string } | null;
      const nickname = (body?.nickname ?? "").toString().trim().slice(0, 100) || "Анонім";
      const message = (body?.message ?? "").toString().trim().slice(0, 4000);
      if (!message) {
        return new Response("message is required", { status: 400 });
      }
      const item: FeedbackItem = { id: crypto.randomUUID(), nickname, message, created_at: new Date().toISOString() };
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
        const obj = await env.TRANSFERS.get(id);
        if (obj === null) {
          return new Response("Not found", { status: 404 });
        }
        return new Response(obj.body, {
          headers: { "Content-Length": String(obj.size) },
        });
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
