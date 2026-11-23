// 仲裁與回合地圖的核心流程（不直接依賴 Cloudflare 或提示詞檔，方便測試）
import type { ModelResult } from "./model";
import type { Sentence } from "./split";
import { parseJson, validateVerdict } from "./validate";
import { fail, type ArbInput, type Fail } from "./input";
import { normalizeGraph, validateGraph, type Graph } from "./graph-validate";

export type CallFn = (system: string, user: string, opts?: { maxTokens?: number; timeoutMs?: number }) => Promise<ModelResult>;

function upstreamFail(res: ModelResult): Fail | null {
  if (res.status === 0) return fail(503, "no_key", "伺服器還沒設定模型金鑰，可以先看預錄範例");
  if (res.status === 401 || res.status === 403) return fail(502, "auth_error", "服務設定有誤（金鑰無效）");
  if (res.status === 402) return fail(502, "no_balance", "模型服務餘額不足");
  if (res.status === 404) return fail(502, "model_not_found", "服務設定有誤（找不到模型）");
  if (res.status === 429) return fail(429, "rate_limited", "使用人數多，請稍後再試");
  if (res.status !== 200) return fail(502, "upstream_error", `模型服務錯誤（${res.status}）`);
  return null;
}

export async function arbitrateWith(call: CallFn, prompt: string, input: ArbInput, sentences: Sentence[]) {
  const ids = new Set(sentences.map((s) => s.sid));
  const rules = sentences.map((s) => `[${s.sid}] ${s.text}`).join("\n");
  const request =
    input.mode === "duel" ? `模式：兩方對質\nA 的主張：${input.a}\nB 的主張：${input.b}` : `模式：直接提問\n問題：${input.q}`;
  const ctx: string[] = [];
  if (input.context) ctx.push(input.context);
  if (input.history?.length) {
    ctx.push("同一位玩家先前的私下提問：");
    for (const h of input.history) ctx.push(`問：${h.q}\n答：${h.a}`);
  }
  const user =
    `<rules>\n${rules}\n</rules>\n\n` + (ctx.length ? `<context>\n${ctx.join("\n")}\n</context>\n\n` : "") + `<request>\n${request}\n</request>`;

  let parsed: any = null;
  let errors: string[] = [];
  const usage: any[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const retryNote = attempt === 0 ? "" : `\n\n你上一次的輸出有這些問題，請修正後重新輸出完整 JSON：\n- ${errors.join("\n- ")}`;
    let res: ModelResult;
    try {
      res = await call(prompt, user + retryNote, { maxTokens: 2000, timeoutMs: 30000 });
    } catch {
      return fail(504, "timeout", "模型回應太慢，請再試一次");
    }
    usage.push(res.usage);
    const f = upstreamFail(res);
    if (f) return f;
    parsed = parseJson(res.text ?? "");
    errors = validateVerdict(parsed, ids);
    if (errors.length === 0) break;
  }

  const ok = errors.length === 0;
  const textOf = new Map(sentences.map((s) => [s.sid, s.text]));
  const quotes = (list: any) =>
    (Array.isArray(list) ? list : [])
      .filter((id: any) => typeof id === "string" && textOf.has(id))
      .map((id: string) => ({ sid: id, text: textOf.get(id)! }));
  const opts = Array.isArray(parsed?.house_rule_options)
    ? parsed.house_rule_options
        .filter((o: any) => o && typeof o.text === "string" && o.text.trim())
        .slice(0, 3)
        .map((o: any) => ({ text: o.text.trim().slice(0, 120), effect: String(o.effect ?? "").slice(0, 120) }))
    : [];

  return {
    ok: true as const,
    data: {
      kind: ok ? parsed.kind : parsed?.kind ?? "unclear",
      verdict: parsed?.verdict ?? null,
      result: typeof parsed?.result === "string" ? parsed.result.slice(0, 300) : "模型回傳格式有誤，這次結果需要人工確認。",
      evidence: Array.isArray(parsed?.evidence) ? parsed.evidence : [],
      related: Array.isArray(parsed?.related) ? parsed.related : [],
      reasoning: parsed?.reasoning ?? null,
      clarifying_question: parsed?.clarifying_question ?? null,
      house_rule_options: opts,
      evidence_quotes: quotes(parsed?.evidence),
      related_quotes: quotes(parsed?.related),
      needs_review: !ok || parsed?.kind !== "explicit",
      checks: {
        schema: !errors.some((e) => e.startsWith("格式")),
        ids_exist: !errors.some((e) => e.startsWith("編號")),
        kind_rules: !errors.some((e) => e.startsWith("類型")),
        errors,
      },
      source: "live",
      usage,
    },
  };
}

export async function graphWith(call: CallFn, prompt: string, sentences: Sentence[]): Promise<{ ok: true; graph: Graph } | Fail> {
  const ids = new Set(sentences.map((s) => s.sid));
  const rules = sentences.map((s) => `[${s.sid}] ${s.text}`).join("\n");
  const user = `<rules>\n${rules}\n</rules>`;
  let errors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const retryNote = attempt === 0 ? "" : `\n\n你上一次的輸出有這些問題，請修正後重新輸出完整 JSON：\n- ${errors.join("\n- ")}`;
    let res: ModelResult;
    try {
      res = await call(prompt, user + retryNote, { maxTokens: 6000, timeoutMs: 90000 });
    } catch {
      return fail(504, "timeout", "整理回合地圖逾時，請再試一次");
    }
    const f = upstreamFail(res);
    if (f) return f;
    const g = normalizeGraph(parseJson(res.text ?? ""));
    errors = validateGraph(g, ids);
    if (errors.length === 0) return { ok: true, graph: g! };
  }
  return fail(422, "graph_invalid", `回合地圖沒有通過檢查：${errors.slice(0, 3).join("；")}`);
}
