export type Sentence = { sid: string; section: string; text: string };

export function splitSentences(raw: string): Sentence[] {
  const out: Sentence[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+(?:\.\d+)*)\s*(.+)$/);
    if (!m) continue;
    const [, clause, body] = m;
    const parts = body.split(/(?<=[。！？；])/).map(s => s.trim()).filter(Boolean);
    parts.forEach((text, i) =>
      out.push({ sid: `${clause}-${i + 1}`, section: clause.split(".")[0], text })
    );
  }
  return out;
}