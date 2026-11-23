// 各頁共用的小工具（全部用 textContent 放文字，避免把模型或玩家的輸入當成 HTML）
import { dict } from "/assets/i18n.js";

export const $ = (id) => document.getElementById(id);

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export const COLORS = ["#c2410c", "#1f5f8b", "#2e7d55", "#7b4cd6", "#c98a00", "#b4235a", "#0e7c86", "#5d6b78"];

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
  const ch = n.length >= 2 && "阿小老大".includes(n[0]) ? n[1] : n[0].toUpperCase();
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

// 裁定卡的共同部分：類型、結論、說明、依據原句、核對結果。t 是目前介面語言的字典。
export function renderVerdict(card, d, mode, opts = {}, t = dict()) {
  card.append(el("span", "kind k-" + d.kind, t.kind[d.kind] || d.kind));
  const head =
    mode === "duel" && t.verd[d.verdict] ? t.verd[d.verdict]
    : d.kind === "not_covered" ? t.headNotCovered
    : d.kind === "unclear" ? t.headUnclear
    : d.kind === "off_topic" ? t.headOffTopic
    : t.headAnswer;
  card.append(el("div", "vm", head), el("p", "res", d.result || ""));
  if (d.reasoning) card.append(el("div", "subh", t.lblReasoning), el("p", "res", d.reasoning));
  if (d.clarifying_question) card.append(el("div", "subh", t.lblClarify), el("p", "res", d.clarifying_question));
  if (d.evidence_quotes?.length) {
    card.append(el("div", "subh", t.lblEvidence));
    quoteRows(card, d.evidence_quotes, "ev");
  }
  if (d.related_quotes?.length) {
    card.append(el("div", "subh", t.lblRelated));
    quoteRows(card, d.related_quotes, "ev rel");
  }
  if (d.checks && !opts.hideChecks) {
    for (const [k, l] of [["schema", t.ckSchema], ["ids_exist", t.ckIds], ["kind_rules", t.ckKind]]) {
      card.append(el("span", "ck " + (d.checks[k] ? "y" : "n"), (d.checks[k] ? "✓ " : "✗ ") + l));
    }
  }
  if (opts.source !== false) {
    const rec = d.source === "recorded";
    card.append(el("div", "src " + (rec ? "rec" : "live"), rec ? t.srcRec : t.srcLive));
  }
}

export async function copyText(text, t = dict()) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t.copied);
  } catch {
    toast(t.copyManual);
  }
}

export function wireCounter(input, counter, max = 120) {
  const up = () => (counter.textContent = `${input.value.length}/${max}`);
  input.addEventListener("input", up);
  up();
}
