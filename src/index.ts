import { analyzeRoute } from "./analyze";
import { splitSentences, type Sentence } from "./split";
import type { AppEnv } from "./env";

export { UsageDO } from "./usage";
export { RoomDO } from "./room";
export { MyDurableObject } from "./legacy";

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 不含容易看錯的 I、L、O、0、1
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$/;
const DEVICE_RE = /^[A-Za-z0-9-]{8,64}$/;
const SAMPLE_TITLE = "《夜市攤主》示例";

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

async function sampleSentences(env: AppEnv, reqUrl: string): Promise<Sentence[]> {
  const file = await env.ASSETS.fetch(new URL("/rules/night-market.txt", reqUrl));
  return splitSentences(await file.text());
}

function randomCode() {
  const a = new Uint32Array(6);
  crypto.getRandomValues(a);
  return Array.from(a, (n) => CODE_CHARS[n % CODE_CHARS.length]).join("");
}

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const ip = request.headers.get("CF-Connecting-IP") ?? "local";
    const usage = () => env.USAGE.get(env.USAGE.idFromName("global"));

    // 示例規則書（切好句子），首頁與單機版用
    if (path === "/api/rulebook" || path === "/api/split") {
      const sentences = await sampleSentences(env, request.url);
      return json({ title: SAMPLE_TITLE, count: sentences.length, sentences });
    }

    // 預覽切句結果（開房前讓房主檢查，不呼叫模型）
    if (path === "/api/preview" && request.method === "POST") {
      const body: any = await request.json().catch(() => null);
      const text = String(body?.text ?? "");
      if (text.length > 20000) return json({ error: "too_long", message: "規則書最多 20,000 字" }, 400);
      const sentences = splitSentences(text);
      return json({ count: sentences.length, sentences: sentences.slice(0, 400) });
    }

    // 單機版仲裁
    if (path === "/api/analyze" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body) return json({ error: "bad_input", message: "格式錯誤" }, 400);
      const ticket = await usage().take(`ip:${ip}`, 5, Number(env.DAILY_LIMIT ?? 2000));
      if (!ticket.ok) {
        return ticket.reason === "daily"
          ? json({ error: "quota_daily", message: "今天的試用額度用完了，可以先看預錄範例" }, 429)
          : json({ error: "rate_limited", message: `太快了，請 ${ticket.retryAfter} 秒後再試` }, 429);
      }
      return analyzeRoute(body, await sampleSentences(env, request.url), env);
    }

    // 開房
    if (path === "/api/rooms" && request.method === "POST") {
      const body: any = await request.json().catch(() => null);
      if (!body || !DEVICE_RE.test(String(body.device ?? ""))) return json({ error: "bad_input", message: "格式錯誤" }, 400);
      const gate = await usage().gate(`create:${ip}`, 3);
      if (!gate.ok) return json({ error: "rate_limited", message: `開房太頻繁，請 ${gate.retryAfter} 秒後再試` }, 429);

      let sentences: Sentence[];
      let title: string;
      if (body.useSample) {
        sentences = await sampleSentences(env, request.url);
        title = SAMPLE_TITLE;
      } else {
        const text = String(body.rulebook ?? "");
        if (text.length > 20000) return json({ error: "too_long", message: "規則書最多 20,000 字" }, 400);
        sentences = splitSentences(text);
        title = String(body.title ?? "").trim().slice(0, 30) || "自訂規則書";
      }
      if (sentences.length < 3) return json({ error: "too_short", message: "規則書至少要有 3 句" }, 400);

      for (let i = 0; i < 5; i++) {
        const code = randomCode();
        const stub = env.ROOM.get(env.ROOM.idFromName(code));
        const r = await stub.init({
          code, title, host: body.device,
          hostName: String(body.name ?? ""), hostColor: String(body.color ?? ""), sentences,
        });
        if (r.ok) return json({ code });
      }
      return json({ error: "busy", message: "暫時無法開房，請再試一次" }, 503);
    }

    // 房間資訊與連線
    const m = path.match(/^\/api\/rooms\/([A-Za-z0-9]{6})(\/ws)?$/);
    if (m) {
      const code = m[1].toUpperCase();
      if (!CODE_RE.test(code)) return json({ error: "not_found", message: "房號不正確" }, 404);
      const stub = env.ROOM.get(env.ROOM.idFromName(code));
      if (!m[2]) {
        const info = await stub.info();
        return info.exists ? json(info) : json({ error: "not_found", message: "房間不存在或已過期" }, 404);
      }
      if (request.headers.get("Upgrade") !== "websocket") return json({ error: "bad_request", message: "需要 WebSocket" }, 426);
      return stub.fetch(request);
    }

    if (path.startsWith("/api/")) return json({ error: "not_found", message: "找不到這個 API" }, 404);

    // 其他路徑交給靜態網頁
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<AppEnv>;
