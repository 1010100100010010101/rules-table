// 玩家輸入的檢查（純函式，房間與單機版共用）
import { tr } from "./i18n";

export const MAX_LEN = 120;

export type ArbInput = {
  mode: "duel" | "ask";
  a: string;
  b: string;
  q: string;
  history?: { q: string; a: string }[];
  context?: string;
};

export type Fail = { ok: false; status: number; error: string; message: string };

export function fail(status: number, error: string, message: string): Fail {
  return { ok: false, status, error, message };
}

export function checkInput(body: any, lang?: string): { ok: true; input: ArbInput } | Fail {
  const t = tr(lang);
  const mode = body?.mode === "duel" ? "duel" : "ask";
  const a = String(body?.claim_a ?? body?.a ?? "").trim();
  const b = String(body?.claim_b ?? body?.b ?? "").trim();
  const q = String(body?.question ?? body?.q ?? "").trim();
  if (mode === "duel" && (!a || !b)) return fail(400, "bad_input", t.bothClaims);
  if (mode === "ask" && !q) return fail(400, "bad_input", t.emptyQuestion);
  if ([a, b, q].some((s) => s.length > MAX_LEN)) return fail(400, "too_long", t.inputTooLong(MAX_LEN));
  const history = Array.isArray(body?.history)
    ? body.history
        .slice(-6)
        .map((h: any) => ({ q: String(h?.q ?? "").slice(0, MAX_LEN), a: String(h?.a ?? "").slice(0, 200) }))
        .filter((h: any) => h.q)
    : undefined;
  return { ok: true, input: { mode, a: mode === "duel" ? a : "", b: mode === "duel" ? b : "", q: mode === "ask" ? q : "", history } };
}

export function cleanText(s: any, max: number): string {
  return String(s ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
}
