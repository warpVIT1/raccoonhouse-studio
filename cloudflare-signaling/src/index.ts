// RaccoonHouse Power Share — online signaling.
//
// Solves discovery only, not NAT traversal: this Worker just answers "who
// else is online right now, and at what public IP/port" and relays the tiny
// consent-request/response messages between two specific peers. The actual
// video/audio upload for a running separation job still goes directly
// machine-to-machine over plain HTTP (see backend/routers/power_share.py) —
// this process never sees that traffic and couldn't handle it anyway
// (Workers have per-request CPU/duration limits that make them a bad fit
// for relaying multi-gigabyte files).
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
      ws.serializeAttachment({
        ...existing,
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
      ws.send(JSON.stringify({ type: "welcome", your_id: existing.id }));
      this.broadcastPeerList();
      return;
    }

    if (msg.type === "relay") {
      // Small consent-request/response messages only — see the module
      // docstring for why actual file data never goes through here.
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.PEER_REGISTRY.idFromName("global");
    const stub = env.PEER_REGISTRY.get(id);
    return stub.fetch(request);
  },
};
