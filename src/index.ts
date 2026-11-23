import { analyzeRoute } from "./analyze";
import { checkImage, ocrPage } from "./ocr";
import { splitSentences, type Sentence } from "./split";
import { translate } from "./ai";
import { tr, normLang, type Lang } from "./i18n";
import type { AppEnv } from "./env";

export { UsageDO } from "./usage";
export { RoomDO } from "./room";
export { MyDurableObject } from "./legacy";

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 不含容易看錯的 I、L、O、0、1
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$/;
const DEVICE_RE = /^[A-Za-z0-9-]{8,64}$/;
const PRESET_RE = /^[a-z0-9-]{2,40}$/;
const SAMPLE_ID = "night-market";
const TRANSLATE_MAX = 4000;

type Preset = { id: string; players: string; sample?: boolean; title: Record<Lang, string>; summary: Record<Lang, string> };

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

async function presetList(env: AppEnv, reqUrl: string): Promise<Preset[]> {
  const r = await env.ASSETS.fetch(new URL("/rules/presets.json", reqUrl));
  return r.ok ? ((await r.json()) as Preset[]) : [];
}

// 內建遊戲的規則書（切好句子）。每款遊戲有繁體、簡體、英文三份，條號一致。
async function presetRulebook(env: AppEnv, reqUrl: string, id: string, lang: Lang) {
  if (!PRESET_RE.test(id)) return null;
  const preset = (await presetList(env, reqUrl)).find((p) => p.id === id);
  if (!preset) return null;
  const file = await env.ASSETS.fetch(new URL(`/rules/presets/${id}/${lang}.txt`, reqUrl));
  if (!file.ok) return null;
  return { title: preset.title[lang], sentences: splitSentences(await file.text()) };
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
    const qLang = normLang(url.searchParams.get("lang"));
    const daily = Number(env.DAILY_LIMIT ?? 2000);

    // 內建遊戲清單
    if (path === "/api/presets") {
      const list = await presetList(env, request.url);
      return json(list.map((p) => ({ id: p.id, players: p.players, sample: !!p.sample, title: p.title[qLang], summary: p.summary[qLang] })));
    }

    // 內建遊戲的規則書（切好句子）；不帶 game 時是示例遊戲，首頁與單機版用
    if (path === "/api/rulebook" || path === "/api/split") {
      const book = await presetRulebook(env, request.url, url.searchParams.get("game") || SAMPLE_ID, qLang);
      if (!book) return json({ error: "not_found", message: tr(qLang).presetNotFound }, 404);
      return json({ title: book.title, count: book.sentences.length, sentences: book.sentences });
    }

    // 預覽切句結果（開房前讓房主檢查，不呼叫模型）
    if (path === "/api/preview" && request.method === "POST") {
      const body: any = await request.json().catch(() => null);
      const t = tr(body?.lang);
      const text = String(body?.text ?? "");
      if (text.length > 20000) return json({ error: "too_long", message: t.rulebookTooLong }, 400);
      const sentences = splitSentences(text);
      return json({ count: sentences.length, sentences: sentences.slice(0, 400) });
    }

    // 拍照辨識規則書（一次一頁）
    if (path === "/api/ocr" && request.method === "POST") {
      const body: any = await request.json().catch(() => null);
      const t = tr(body?.lang);
      const bad = checkImage(body?.image);
      if (bad) return json({ error: "bad_image", message: bad }, 400);
      const ticket = await usage().take(`ocr:${ip}`, 10, daily);
      if (!ticket.ok) {
        return ticket.reason === "daily"
          ? json({ error: "quota_daily", message: t.quotaDailyOcr }, 429)
          : json({ error: "rate_limited", message: t.tooFast(ticket.retryAfter) }, 429);
      }
      const r = await ocrPage(body.image, env);
      return r.ok ? json(r) : json({ error: r.error, message: r.message }, r.status);
    }

    // 翻譯規則書（一次一段，最多 4,000 字；長的規則書由前端分段送）
    if (path === "/api/translate" && request.method === "POST") {
      const body: any = await request.json().catch(() => null);
      const to = normLang(body?.to);
      const t = tr(body?.lang ?? to);
      const text = String(body?.text ?? "").trim();
      if (!text) return json({ error: "bad_input", message: t.translateEmpty }, 400);
      if (text.length > TRANSLATE_MAX) return json({ error: "too_long", message: t.translateTooLong }, 400);
      const ticket = await usage().take(`tr:${ip}`, 10, daily);
      if (!ticket.ok) {
        return ticket.reason === "daily"
          ? json({ error: "quota_daily", message: t.quotaDaily }, 429)
          : json({ error: "rate_limited", message: t.tooFast(ticket.retryAfter) }, 429);
      }
      const r = await translate(text, to, env);
      return r.ok ? json({ text: r.text }) : json({ error: r.error, message: r.message }, r.status);
    }

    // 單機版仲裁（可以選內建遊戲；不選就是示例遊戲）
    if (path === "/api/analyze" && request.method === "POST") {
      const body: any = await request.json().catch(() => null);
      const lang = normLang(body?.lang);
      const t = tr(lang);
      if (!body) return json({ error: "bad_input", message: t.badInput }, 400);
      const book = await presetRulebook(env, request.url, String(body.game || SAMPLE_ID), lang);
      if (!book) return json({ error: "not_found", message: t.presetNotFound }, 404);
      const ticket = await usage().take(`ip:${ip}`, 5, daily);
      if (!ticket.ok) {
        return ticket.reason === "daily"
          ? json({ error: "quota_daily", message: t.quotaDailySolo }, 429)
          : json({ error: "rate_limited", message: t.tooFast(ticket.retryAfter) }, 429);
      }
      return analyzeRoute(body, book.sentences, env);
    }

    // 開房
    if (path === "/api/rooms" && request.method === "POST") {
      const body: any = await request.json().catch(() => null);
      const lang = normLang(body?.lang);
      const t = tr(lang);
      if (!body || !DEVICE_RE.test(String(body.device ?? ""))) return json({ error: "bad_input", message: t.badInput }, 400);
      const gate = await usage().gate(`create:${ip}`, 3);
      if (!gate.ok) return json({ error: "rate_limited", message: t.createTooFast(gate.retryAfter) }, 429);

      let sentences: Sentence[];
      let title: string;
      const presetId = body.preset ? String(body.preset) : body.useSample ? SAMPLE_ID : "";
      if (presetId) {
        const book = await presetRulebook(env, request.url, presetId, lang);
        if (!book) return json({ error: "not_found", message: t.presetNotFound }, 404);
        sentences = book.sentences;
        title = book.title;
      } else {
        const text = String(body.rulebook ?? "");
        if (text.length > 20000) return json({ error: "too_long", message: t.rulebookTooLong }, 400);
        sentences = splitSentences(text);
        title = String(body.title ?? "").trim().slice(0, 30) || t.customTitle;
      }
      if (sentences.length < 3) return json({ error: "too_short", message: t.rulebookTooShort }, 400);

      for (let i = 0; i < 5; i++) {
        const code = randomCode();
        const stub = env.ROOM.get(env.ROOM.idFromName(code));
        const r = await stub.init({
          code, title, host: body.device, lang,
          hostName: String(body.name ?? ""), hostColor: String(body.color ?? ""), sentences,
        });
        if (r.ok) return json({ code });
      }
      return json({ error: "busy", message: t.roomBusy }, 503);
    }

    // 房間資訊與連線
    const m = path.match(/^\/api\/rooms\/([A-Za-z0-9]{6})(\/ws)?$/);
    if (m) {
      const code = m[1].toUpperCase();
      if (!CODE_RE.test(code)) return json({ error: "not_found", message: tr(qLang).roomCodeBad }, 404);
      const stub = env.ROOM.get(env.ROOM.idFromName(code));
      if (!m[2]) {
        const info = await stub.info();
        return info.exists ? json(info) : json({ error: "not_found", message: tr(qLang).roomNotFound }, 404);
      }
      if (request.headers.get("Upgrade") !== "websocket") return json({ error: "bad_request", message: tr(qLang).needWs }, 426);
      return stub.fetch(request);
    }

    if (path.startsWith("/api/")) return json({ error: "not_found", message: tr(qLang).apiNotFound }, 404);

    // 其他路徑交給靜態網頁
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<AppEnv>;
