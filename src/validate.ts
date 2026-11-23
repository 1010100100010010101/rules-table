export const KINDS = ["explicit", "inferred", "conflict", "not_covered", "unclear", "off_topic"];

// 從模型回傳的文字中取出 JSON（容忍它多加了程式碼框或說明）
export function parseJson(text: string): any {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// 回傳錯誤清單；空陣列代表全部通過。錯誤以「格式／編號／類型」開頭分類。
export function validateVerdict(v: any, ids: Set<string>): string[] {
  if (!v || typeof v !== "object") return ["格式：回傳不是 JSON 物件"];
  const errs: string[] = [];
  if (!KINDS.includes(v.kind)) errs.push(`格式：kind 不合法（${v.kind}）`);
  if (typeof v.result !== "string" || !v.result.trim()) errs.push("格式：result 不可空白");
  if (!Array.isArray(v.evidence)) errs.push("格式：evidence 必須是陣列");
  if (!Array.isArray(v.related)) errs.push("格式：related 必須是陣列");

  const ev: string[] = Array.isArray(v.evidence) ? v.evidence : [];
  const rel: string[] = Array.isArray(v.related) ? v.related : [];
  for (const id of [...ev, ...rel]) {
    if (!ids.has(id)) errs.push(`編號：不存在（${id}）`);
  }

  if (v.kind === "explicit" && ev.length < 1) errs.push("類型：explicit 至少要 1 個依據");
  if (v.kind === "inferred" || v.kind === "conflict") {
    if (ev.length < 2) errs.push(`類型：${v.kind} 至少要 2 個依據`);
    if (!v.reasoning) errs.push(`類型：${v.kind} 必須有 reasoning`);
  }
  if (v.kind === "not_covered" && ev.length > 0) errs.push("類型：not_covered 的依據必須是空的");
  if (v.kind === "unclear" && !v.clarifying_question) errs.push("類型：unclear 必須有反問");
  return errs;
}
