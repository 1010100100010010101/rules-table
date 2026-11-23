// 房間物件：每個房間一個。負責連線、存檔、廣播與到期刪除；規則都在 room-core.ts。
import { DurableObject } from "cloudflare:workers";
import { RoomCore, newRoom, type RoomState, type Deps } from "./room-core";
import { arbitrate, generateGraph } from "./ai";
import type { AppEnv } from "./env";
import type { Sentence } from "./split";
import { tr, normLang } from "./i18n";

const TTL = 48 * 3600 * 1000; // 最後一次活動 48 小時後刪除

export class RoomDO extends DurableObject<AppEnv> {
  private s: RoomState | null = null;

  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const got = await ctx.storage.get<any>(["state", "sentences", "disputes"]);
      const base = got.get("state");
      this.s = base ? { ...base, sentences: got.get("sentences") ?? [], disputes: got.get("disputes") ?? [] } : null;
    });
  }

  private deps(lang?: string): Deps {
    return {
      now: () => Date.now(),
      randInt: (n) => {
        const a = new Uint32Array(1);
        crypto.getRandomValues(a);
        return a[0] % n;
      },
      arbitrate: (input, sentences) => arbitrate(input, sentences, this.env, normLang(this.s?.lang)),
      generateGraph: (sentences) => generateGraph(sentences, this.env, normLang(this.s?.lang)),
      quota: async (key) => {
        const stub = this.env.USAGE.get(this.env.USAGE.idFromName("global"));
        const r = await stub.take(`dev:${key}`, 6, Number(this.env.DAILY_LIMIT ?? 2000));
        if (r.ok) return { ok: true };
        const t = tr(lang ?? this.s?.lang);
        return { ok: false, message: r.reason === "daily" ? t.quotaDaily : t.tooFast(r.retryAfter) };
      },
      commit: () => this.commit(),
    };
  }

  // lang：這次操作者的介面語言（錯誤訊息用）；沒給就用房間語言
  private core(lang?: string) {
    return new RoomCore(this.s!, this.deps(lang), lang);
  }

  private online(): Set<string> {
    const set = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as { device?: string } | null;
      if (att?.device && ws.readyState === WebSocket.OPEN) set.add(att.device);
    }
    return set;
  }

  private broadcast() {
    if (!this.s) return;
    const core = this.core();
    const on = this.online();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as { device?: string } | null;
      if (!att?.device) continue;
      try {
        ws.send(JSON.stringify({ type: "state", state: core.view(att.device, on) }));
      } catch {}
    }
  }

  private async commit() {
    if (!this.s) return;
    this.s.lastActive = Date.now();
    if (this.s.closed) {
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(JSON.stringify({ type: "closed" }));
          ws.close(1000, "room closed");
        } catch {}
      }
      this.s = null;
      await this.ctx.storage.deleteAll();
      return;
    }
    const { sentences, disputes, ...rest } = this.s;
    await this.ctx.storage.put({ state: rest, sentences, disputes });
    await this.ctx.storage.setAlarm(Date.now() + TTL);
    this.broadcast();
  }

  // ---- 給 Worker 呼叫的 RPC ----
  async info() {
    if (!this.s) return { exists: false as const };
    return { exists: true as const, title: this.s.title, lang: normLang(this.s.lang), players: Object.keys(this.s.players).length };
  }

  async init(args: { code: string; title: string; host: string; hostName: string; hostColor: string; sentences: Sentence[]; lang?: string }) {
    if (this.s) return { ok: false };
    this.s = newRoom({ ...args, now: Date.now() });
    const { sentences, disputes, ...rest } = this.s;
    await this.ctx.storage.put({ state: rest, sentences, disputes });
    await this.ctx.storage.setAlarm(Date.now() + TTL);
    return { ok: true };
  }

  // ---- WebSocket 連線 ----
  async fetch(req: Request): Promise<Response> {
    if (!this.s) return new Response("房間不存在或已過期", { status: 404 });
    if (req.headers.get("Upgrade") !== "websocket") return new Response("需要 WebSocket", { status: 426 });
    const url = new URL(req.url);
    const device = url.searchParams.get("device") ?? "";
    if (!/^[A-Za-z0-9-]{8,64}$/.test(device)) return new Response("裝置識別碼不正確", { status: 400 });
    const lang = url.searchParams.get("lang") || undefined;
    const err = this.core(lang).join(device, {
      name: url.searchParams.get("name") ?? "",
      color: url.searchParams.get("color") ?? "",
      role: url.searchParams.get("role") ?? "player",
    });
    if (err) return new Response(err, { status: 403 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ device, lang });
    await this.commit();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (!this.s) {
      try { ws.send(JSON.stringify({ type: "closed" })); ws.close(1000, "room closed"); } catch {}
      return;
    }
    const att = ws.deserializeAttachment() as { device?: string; lang?: string } | null;
    if (!att?.device || typeof raw !== "string" || raw.length > 12000) return;
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      const r = await this.core(att.lang).handle(att.device, msg, this.online());
      if (r.reply) ws.send(JSON.stringify(r.reply));
      if (r.error) ws.send(JSON.stringify({ type: "error", message: r.error }));
    } catch (e) {
      try { ws.send(JSON.stringify({ type: "error", message: tr(att.lang ?? this.s?.lang).serverError })); } catch {}
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try { ws.close(code === 1005 ? 1000 : code, "bye"); } catch {}
    this.broadcast();
  }

  async webSocketError() {
    this.broadcast();
  }

  async alarm() {
    if (!this.s) {
      await this.ctx.storage.deleteAll();
      return;
    }
    if (Date.now() - this.s.lastActive >= TTL - 60_000) {
      for (const ws of this.ctx.getWebSockets()) {
        try { ws.send(JSON.stringify({ type: "closed" })); ws.close(1000, "expired"); } catch {}
      }
      this.s = null;
      await this.ctx.storage.deleteAll();
    } else {
      await this.ctx.storage.setAlarm(this.s.lastActive + TTL);
    }
  }
}
