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
