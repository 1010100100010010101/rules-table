// 各頁共用的小工具（全部用 textContent 放文字，避免把模型或玩家的輸入當成 HTML）

export const $ = (id) => document.getElementById(id);

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export const COLORS = ["#c2410c", "#1f5f8b", "#2e7d55", "#7b4cd6", "#c98a00", "#b4235a", "#0e7c86", "#5d6b78"];

export const KIND = {
  explicit: "明文",
  inferred: "推論．需全桌同意",
  conflict: "矛盾．需全桌選一種讀法",
  not_covered: "規則書沒寫",
  unclear: "需要澄清",
  off_topic: "與規則無關",
};
export const VERD = {
  A: "A 的說法符合規則",
  B: "B 的說法符合規則",
  both: "兩邊的說法都符合規則",
  neither: "兩邊的說法都不符合規則",
};

export function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key) ?? "null");
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    return null;
  }
}

export function deviceId() {
  let id = store("device");
  if (!id || !/^[A-Za-z0-9-]{8,64}$/.test(id)) {
    id = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/[^A-Za-z0-9-]/g, "");
    store("device", id);
  }
  return id;
}

export function avatar(name, color, opts = {}) {
  const n = String(name || "?");
  // 「阿哲」「小花」這類暱稱取第二個字，頭像比較分得出來
  const ch = n.length >= 2 && "阿小老大".includes(n[0]) ? n[1] : n[0];
  const a = el("span", "av" + (opts.off ? " off" : ""), ch);
  a.style.background = color || "#9aa5b1";
  a.title = name || "";
  if (opts.dot) a.append(el("span", "dot"));
  return a;
}

let toastTimer;
export function toast(msg) {
  document.querySelector(".toast")?.remove();
  const t = el("div", "toast", msg);
  t.setAttribute("role", "status");
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 2600);
}

export function quoteRows(parent, list, cls = "ev") {
  for (const q of list || []) {
    const isH = String(q.sid).startsWith("H");
    const r = el("div", cls + (isH ? " h" : ""));
    r.append(el("span", "cid" + (isH ? " h" : ""), q.sid), el("span", null, q.text));
    parent.append(r);
  }
}

// 裁定卡的共同部分：類型、結論、說明、依據原句、核對結果
export function renderVerdict(card, d, mode, opts = {}) {
  card.append(el("span", "kind k-" + d.kind, KIND[d.kind] || d.kind));
  const head =
    mode === "duel" && VERD[d.verdict] ? VERD[d.verdict]
    : d.kind === "not_covered" ? "這次不裁定"
    : d.kind === "unclear" ? "想先確認一下"
    : d.kind === "off_topic" ? "這題不在規則範圍內"
    : "回答";
  card.append(el("div", "vm", head), el("p", "res", d.result || ""));
  if (d.reasoning) card.append(el("div", "subh", "推論過程"), el("p", "res", d.reasoning));
  if (d.clarifying_question) card.append(el("div", "subh", "請補充"), el("p", "res", d.clarifying_question));
  if (d.evidence_quotes?.length) {
    card.append(el("div", "subh", "依據（原句由程式依編號從規則書取出）"));
    quoteRows(card, d.evidence_quotes, "ev");
  }
  if (d.related_quotes?.length) {
    card.append(el("div", "subh", "相關，但沒有回答這個問題"));
    quoteRows(card, d.related_quotes, "ev rel");
  }
  if (d.checks && !opts.hideChecks) {
    for (const [k, l] of [["schema", "格式"], ["ids_exist", "編號存在"], ["kind_rules", "類型條件"]]) {
      card.append(el("span", "ck " + (d.checks[k] ? "y" : "n"), (d.checks[k] ? "✓ " : "✗ ") + l));
    }
  }
  if (opts.source !== false) {
    const rec = d.source === "recorded";
    card.append(el("div", "src " + (rec ? "rec" : "live"), rec ? "● 預錄範例（沒有呼叫模型）" : "● 真實調用"));
  }
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已複製");
  } catch {
    toast("無法自動複製，請手動選取");
  }
}

export function wireCounter(input, counter, max = 120) {
  const up = () => (counter.textContent = `${input.value.length}/${max}`);
  input.addEventListener("input", up);
  up();
}
