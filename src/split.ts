export type Sentence = { sid: string; section: string; text: string };

export const MAX_SENTENCES = 400;

const CLAUSE = /^(\d+(?:\.\d+)*)[\s、．.)）:：]*(.+)$/;
const ARTICLE = /^第\s*(\d+)\s*[條条章節节]\s*[、:：]?\s*(.*)$/;

function splitParts(body: string): string[] {
  const raw = body.split(/(?<=[。！？；!?;])/).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const p of raw) {
    // 太短的碎片（例如單獨的引號）併回上一句
    if (out.length && p.replace(/[」』）)\s]/g, "").length < 2) out[out.length - 1] += p;
    else out.push(p);
  }
  return out;
}

/**
 * 把規則書切成帶編號的句子。
 * - 大部分行以條號開頭（例如「4.2 ⋯」或「第 4 條 ⋯」）時，用條號編號：4.2-1、4.2-2。
 * - 沒有條號時，每一行當作一段，依行序編號：1-1、2-1⋯
 * prefix 用於補充來源（例如 "F1"），編號會變成 F1.3-1。
 */
export function splitSentences(raw: string, prefix = ""): Sentence[] {
  const lines = raw.replace(/^﻿/, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const matchOf = (l: string) => l.match(ARTICLE) ?? l.match(CLAUSE);
  const numbered = lines.filter((l) => matchOf(l)).length;
  const useNumbers = lines.length > 0 && numbered / lines.length >= 0.5;

  const out: Sentence[] = [];
  const used = new Set<string>();
  let para = 0;
  for (const line of lines) {
    let clause: string;
    let body: string;
    const m = useNumbers ? matchOf(line) : null;
    if (useNumbers) {
      if (!m || !m[2]?.trim()) continue; // 標題或空行
      clause = m[1];
      body = m[2].trim();
    } else {
      para += 1;
      clause = String(para);
      body = line;
    }
    if (prefix) clause = `${prefix}.${clause}`;
    // 同一條號出現兩次時，接續編號
    let n = 0;
    while (used.has(`${clause}-${n + 1}`)) n++;
    for (const text of splitParts(body)) {
      n += 1;
      const sid = `${clause}-${n}`;
      used.add(sid);
      out.push({ sid, section: clause.split(".")[0], text });
      if (out.length >= MAX_SENTENCES) return out;
    }
  }
  return out;
}
