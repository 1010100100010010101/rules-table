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

// ---------- 沒有條號的規則書：依標題、縮排、空行分段 ----------
const BULLET = /^[－\-–—•·‧・●○◆◇■□▪※＊*]\s*/;
const HEADING = /^[^\s，,。：:！？；]{1,10}[：:]/; // 「抵押：」「遊戲進行：」
const ENDS_SENTENCE = /[。！？；!?;：:」』）)\]】]$/;
const ENDS_COMMA = /[，、,]$/;

function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === "　") n += 2;
    else if (ch === " ") n += 1;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

type Item = { text: string; bullet: boolean; indent: number };

/**
 * 把沒有條號的文字分成「段」，每段是幾個項目：
 * - 新的一段：不縮排的「XX：」標題，或空行之後不縮排、不是項目符號的行
 * - 縮排的行、「－」開頭的項目，都屬於上面那一段
 * - 被硬換行切斷的句子接回去：上一行以逗號結尾，或上一行是項目且這一行縮排得比它深
 * 整份文字沒有縮排、空行和標題時（例如從網頁複製），退回每一行一段。
 */
function sectionsOf(rawLines: string[]): Item[][] {
  const lines = rawLines.map((l) => l.replace(/\s+$/, ""));
  const first = lines.findIndex((l) => l.trim());
  const lastIdx = lines.length - 1 - [...lines].reverse().findIndex((l) => l.trim());
  const structured =
    lines.some((l) => l.trim() && indentOf(l) > 0) ||
    lines.some((l, i) => !l.trim() && i > first && i < lastIdx) ||
    lines.filter((l) => HEADING.test(l.trim())).length >= 2;

  const sections: Item[][] = [];
  let blank = true;
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) {
      blank = true;
      continue;
    }
    const indent = indentOf(raw);
    const bullet = BULLET.test(t);
    const heading = !bullet && indent === 0 && HEADING.test(t);
    const cur = sections[sections.length - 1];
    const last = cur?.[cur.length - 1];
    // 中文硬換行：上一行沒講完（逗號結尾、項目的縮排續行，或這一行開頭只有一兩個字就接逗號，例如「價，任何玩家⋯」）
    const continues =
      !!last && !blank && !bullet && !heading && !ENDS_SENTENCE.test(last.text) &&
      (ENDS_COMMA.test(last.text) || (last.bullet && indent > last.indent) || /^[^，,、。\s]{1,2}[，,、]/.test(t));
    const newSection = !cur || heading || (indent === 0 && !bullet && (blank || !structured));

    if (continues) {
      last.text += t;
    } else if (newSection) {
      sections.push([{ text: t, bullet, indent }]);
    } else {
      const text = bullet ? t.replace(BULLET, "") : t;
      if (text) cur.push({ text, bullet, indent });
    }
    blank = false;
  }
  return sections;
}

/**
 * 把規則書切成帶編號的句子。
 * - 大部分行以條號開頭（例如「4.2 ⋯」或「第 4 條 ⋯」）時，用條號編號：4.2-1、4.2-2。
 * - 沒有條號時，依標題與縮排分段（見 sectionsOf），段內依序編號：3-1、3-2⋯
 * prefix 用於補充來源（例如 "F1"），編號會變成 F1.3-1。
 */
export function splitSentences(raw: string, prefix = ""): Sentence[] {
  const rawLines = raw.replace(/^﻿/, "").split(/\r?\n/);
  const lines = rawLines.map((l) => l.trim()).filter(Boolean);
  const matchOf = (l: string) => l.match(ARTICLE) ?? l.match(CLAUSE);
  const numbered = lines.filter((l) => matchOf(l)).length;
  const useNumbers = lines.length > 0 && numbered / lines.length >= 0.5;

  // 每一組是「條號 + 這一條的文字（可能有好幾項）」
  const groups: { clause: string; bodies: string[] }[] = [];
  if (useNumbers) {
    for (const line of lines) {
      const m = matchOf(line);
      if (!m || !m[2]?.trim()) continue; // 標題或空行
      groups.push({ clause: m[1], bodies: [m[2].trim()] });
    }
  } else {
    sectionsOf(rawLines).forEach((items, i) => groups.push({ clause: String(i + 1), bodies: items.map((it) => it.text) }));
  }

  const out: Sentence[] = [];
  const used = new Set<string>();
  for (const g of groups) {
    const clause = prefix ? `${prefix}.${g.clause}` : g.clause;
    // 同一條號出現兩次時，接續編號
    let n = 0;
    while (used.has(`${clause}-${n + 1}`)) n++;
    for (const text of g.bodies.flatMap(splitParts)) {
      n += 1;
      const sid = `${clause}-${n}`;
      used.add(sid);
      out.push({ sid, section: clause.split(".")[0], text });
      if (out.length >= MAX_SENTENCES) return out;
    }
  }
  return out;
}
