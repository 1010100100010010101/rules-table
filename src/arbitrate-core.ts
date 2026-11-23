// 仲裁與回合地圖的核心流程（不直接依賴 Cloudflare 或提示詞檔，方便測試）
import type { ModelResult } from "./model";
import type { Sentence } from "./split";
import { parseJson, validateVerdict } from "./validate";
import { fail, type ArbInput, type Fail } from "./input";
import { normalizeGraph, validateGraph, type Graph } from "./graph-validate";
import { tr, normLang, LANG_NAME, type Lang } from "./i18n";

// 附加在系統提示後面：要求模型用房間的語言寫給玩家看的文字
function langNote(lang: Lang, fields: string): string {
  return `

# 輸出語言
${LANG_NAME[lang]}。${fields}都用這個語言寫；JSON 的鍵名、kind 與 verdict 的值、規則編號不要翻譯。`;
}

export type CallFn = (system: string, user: string, opts?: { maxTokens?: number; timeoutMs?: number }) => Promise<ModelResult>;

function upstreamFail(res: ModelResult, lang?: Lang): Fail | null {
  const t = tr(lang);
  if (res.status === 0) return fail(503, "no_key", t.noKey);
  if (res.status === 401 || res.status === 403) return fail(502, "auth_error", t.authError);
  if (res.status === 402) return fail(502, "no_balance", t.noBalance);
  if (res.status === 404) return fail(502, "model_not_found", t.modelNotFound);
  if (res.status === 429) return fail(429, "rate_limited", t.modelBusy);
  if (res.status !== 200) return fail(502, "upstream_error", t.upstream(res.status));
  return null;
}

export async function arbitrateWith(call: CallFn, basePrompt: string, input: ArbInput, sentences: Sentence[], langIn?: Lang) {
  const lang = normLang(langIn);
  const t = tr(lang);
  const prompt = basePrompt + langNote(lang, "result、reasoning、clarifying_question、house_rule_options 的 text 與 effect ");
  const maxResult = lang === "en" ? 600 : 300;
  const maxOpt = lang === "en" ? 200 : 120;
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
      return fail(504, "timeout", t.timeout);
    }
    usage.push(res.usage);
    const f = upstreamFail(res, lang);
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
        .map((o: any) => ({ text: o.text.trim().slice(0, maxOpt), effect: String(o.effect ?? "").slice(0, maxOpt) }))
    : [];

  return {
    ok: true as const,
    data: {
      kind: ok ? parsed.kind : parsed?.kind ?? "unclear",
      verdict: parsed?.verdict ?? null,
      result: typeof parsed?.result === "string" ? parsed.result.slice(0, maxResult) : t.badFormat,
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

export async function graphWith(call: CallFn, basePrompt: string, sentences: Sentence[], langIn?: Lang): Promise<{ ok: true; graph: Graph } | Fail> {
  const lang = normLang(langIn);
  const t = tr(lang);
  const prompt = basePrompt + langNote(lang, "setup 與 steps 的 text、分支的 label、end 的 text ");
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
      return fail(504, "timeout", t.graphTimeout);
    }
    const f = upstreamFail(res, lang);
    if (f) return f;
    const g = normalizeGraph(parseJson(res.text ?? ""));
    errors = validateGraph(g, ids);
    if (errors.length === 0) return { ok: true, graph: g! };
  }
  return fail(422, "graph_invalid", t.graphInvalid(errors.slice(0, 3).join("；")));
}

// 翻譯規則書：保留條號與分行，回傳翻好的純文字（之後一樣要給房主檢查）
export async function translateWith(call: CallFn, prompt: string, text: string, toIn: Lang): Promise<{ ok: true; text: string } | Fail> {
  const to = normLang(toIn);
  const t = tr(to);
  const user = `<target>${LANG_NAME[to]}</target>\n<text>\n${text}\n</text>`;
  let res: ModelResult;
  try {
    res = await call(prompt, user, { maxTokens: 8000, timeoutMs: 120000 });
  } catch {
    return fail(504, "timeout", t.translateTimeout);
  }
  const f = upstreamFail(res, to);
  if (f) return f;
  const out = (res.text ?? "")
    .replace(/^\s*```[a-z]*\s*/i, "")
    .replace(/```\s*$/, "")
    .replace(/^\s*<text>\s*/, "")
    .replace(/\s*<\/text>\s*$/, "")
    .trim();
  if (!out) return fail(502, "upstream", t.translateFail);
  return { ok: true, text: out };
}
