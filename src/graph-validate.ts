// 回合地圖的檢查（純函式）

export type Branch = { label: string; to: string; dice?: number[] };
export type Step = { id: string; text: string; cites: string[]; inferred: boolean; end_turn: boolean; next: Branch[] };
export type Graph = {
  setup: { id: string; text: string; cites: string[] }[];
  start: string;
  steps: Step[];
  end: { text: string; cites: string[] } | null;
};

const MAX_STEPS = 30;

function strArr(x: any): string[] {
  return Array.isArray(x) ? x.filter((s) => typeof s === "string") : [];
}

// 把模型的輸出整理成固定形狀（不合法的欄位丟掉，讓檢查只看重要的事）
export function normalizeGraph(g: any): Graph | null {
  if (!g || typeof g !== "object" || !Array.isArray(g.steps)) return null;
  return {
    setup: (Array.isArray(g.setup) ? g.setup : [])
      .filter((s: any) => s && typeof s.text === "string" && s.text.trim())
      .slice(0, 12)
      .map((s: any, i: number) => ({ id: String(s.id ?? `s${i + 1}`), text: s.text.trim().slice(0, 80), cites: strArr(s.cites) })),
    start: String(g.start ?? ""),
    steps: g.steps.slice(0, MAX_STEPS + 1).map((s: any) => ({
      id: String(s?.id ?? ""),
      text: typeof s?.text === "string" ? s.text.trim().slice(0, 80) : "",
      cites: strArr(s?.cites),
      inferred: !!s?.inferred,
      end_turn: !!s?.end_turn,
      next: (Array.isArray(s?.next) ? s.next : []).slice(0, 7).map((b: any) => ({
        label: typeof b?.label === "string" ? b.label.trim().slice(0, 40) : "",
        to: String(b?.to ?? ""),
        dice: Array.isArray(b?.dice) ? b.dice.filter((n: any) => Number.isInteger(n)) : undefined,
      })),
    })),
    end: g.end && typeof g.end.text === "string" ? { text: g.end.text.trim().slice(0, 80), cites: strArr(g.end.cites) } : null,
  };
}

export function validateGraph(g: Graph | null, ids: Set<string>): string[] {
  if (!g) return ["格式：不是合法的回合地圖 JSON"];
  const errs: string[] = [];
  if (!g.steps.length) errs.push("格式：steps 不能是空的");
  if (g.steps.length > MAX_STEPS) errs.push(`格式：步驟最多 ${MAX_STEPS} 個`);

  const stepIds = new Set<string>();
  for (const s of g.steps) {
    if (!s.id) errs.push("格式：每個步驟都要有 id");
    else if (stepIds.has(s.id)) errs.push(`格式：步驟 id 重複（${s.id}）`);
    else stepIds.add(s.id);
  }

  for (const s of g.steps) {
    if (!s.text) errs.push(`格式：步驟 ${s.id} 沒有 text`);
    for (const c of s.cites) if (!ids.has(c)) errs.push(`編號：步驟 ${s.id} 引用了不存在的編號 ${c}`);
    if (!s.inferred && s.cites.length === 0) errs.push(`依據：步驟 ${s.id} 沒有依據；若是推論請把 inferred 設為 true`);
    if (s.end_turn && s.next.length > 0) errs.push(`結構：步驟 ${s.id} 是回合結束，next 必須是空的`);
    if (!s.end_turn && s.next.length === 0) errs.push(`結構：步驟 ${s.id} 沒有下一步，也不是回合結束`);
    for (const b of s.next) {
      if (!b.label) errs.push(`格式：步驟 ${s.id} 有分支沒有 label`);
      if (!stepIds.has(b.to)) errs.push(`結構：步驟 ${s.id} 的分支指向不存在的步驟 ${b.to}`);
      if (b.dice && b.dice.some((n) => n < 1 || n > 18)) errs.push(`格式：步驟 ${s.id} 的 dice 點數超出 1–18`);
    }
  }
  for (const s of g.setup) for (const c of s.cites) if (!ids.has(c)) errs.push(`編號：準備項目引用了不存在的編號 ${c}`);
  if (g.end) for (const c of g.end.cites) if (!ids.has(c)) errs.push(`編號：結束條件引用了不存在的編號 ${c}`);

  if (!stepIds.has(g.start)) {
    errs.push(`結構：start 指向不存在的步驟 ${g.start}`);
    return errs;
  }
  // 從起點走得到哪些步驟
  const byId = new Map(g.steps.map((s) => [s.id, s]));
  const seen = new Set<string>([g.start]);
  const queue = [g.start];
  while (queue.length) {
    const s = byId.get(queue.shift()!);
    for (const b of s?.next ?? []) if (byId.has(b.to) && !seen.has(b.to)) { seen.add(b.to); queue.push(b.to); }
  }
  const unreachable = g.steps.filter((s) => !seen.has(s.id)).map((s) => s.id);
  if (unreachable.length) errs.push(`結構：從起點走不到這些步驟：${unreachable.join("、")}`);
  if (![...seen].some((id) => byId.get(id)?.end_turn)) errs.push("結構：從起點走不到任何回合結束的步驟");
  return errs;
}
