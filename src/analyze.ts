import ARBITRATE from "../prompts/arbitrate.md";
import { callModel, ModelEnv } from "./model";
import { Sentence } from "./split";
import { parseJson, validateVerdict } from "./validate";

const MAX = 120;

function fail(status: number, error: string, message: string) {
  return Response.json({ error, message }, { status });
}

export async function analyze(body: any, sentences: Sentence[], env: ModelEnv) {
  // 1. 檢查輸入
  const mode = body?.mode === "duel" ? "duel" : "ask";
  const a = String(body?.claim_a ?? "").trim();
  const b = String(body?.claim_b ?? "").trim();
  const q = String(body?.question ?? "").trim();
  if (mode === "duel" && (!a || !b)) return fail(400, "bad_input", "兩方的主張都要填");
  if (mode === "ask" && !q) return fail(400, "bad_input", "問題不能空白");
  if ([a, b, q].some((s) => s.length > MAX)) return fail(400, "too_long", `每句最多 ${MAX} 字`);

  // 2. 組成給模型的資料（規則與玩家輸入都包在標籤裡）
  const ids = new Set(sentences.map((s) => s.sid));
  const rules = sentences.map((s) => `[${s.sid}] ${s.text}`).join("\n");
  const request =
    mode === "duel"
      ? `模式：兩方對質\nA 的主張：${a}\nB 的主張：${b}`
      : `模式：直接提問\n問題：${q}`;
  const user = `<rules>\n${rules}\n</rules>\n\n<request>\n${request}\n</request>`;

  // 3. 呼叫模型；檢查不通過就附上錯誤重試一次
  let parsed: any = null;
  let errors: string[] = [];
  const usage: any[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const retryNote =
      attempt === 0 ? "" : `\n\n你上一次的輸出有這些問題，請修正後重新輸出完整 JSON：\n- ${errors.join("\n- ")}`;
    let res;
    try {
      res = await callModel(env, ARBITRATE, user + retryNote);
    } catch {
      return fail(504, "timeout", "模型回應太慢，請再試一次");
    }
    usage.push(res.usage);
    if (res.status === 401 || res.status === 403) return fail(502, "auth_error", "服務設定有誤");
    if (res.status === 404) return fail(502, "model_not_found", "服務設定有誤");
    if (res.status === 429) return fail(429, "rate_limited", "使用人數多，請稍後再試");
    if (res.status !== 200) return fail(502, "upstream_error", `模型服務錯誤（${res.status}）`);

    parsed = parseJson(res.text ?? "");
    errors = validateVerdict(parsed, ids);
    if (errors.length === 0) break;
  }

  // 4. 依編號取回原句，整理成回應
  const ok = errors.length === 0;
  const textOf = new Map(sentences.map((s) => [s.sid, s.text]));
  const quotes = (list: any) =>
    (Array.isArray(list) ? list : [])
      .filter((id: string) => textOf.has(id))
      .map((id: string) => ({ sid: id, text: textOf.get(id) }));

  return Response.json({
    ...(parsed ?? {}),
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
  });
}