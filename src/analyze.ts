// 單機版（不開房間）的 /api/analyze
import { arbitrate } from "./ai";
import { checkInput, cleanText } from "./input";
import type { ModelEnv } from "./model";
import type { Sentence } from "./split";
import { normLang } from "./i18n";

export async function analyzeRoute(body: any, sentences: Sentence[], env: ModelEnv): Promise<Response> {
  const lang = normLang(body?.lang);
  const chk = checkInput(body, lang);
  if (!chk.ok) return Response.json({ error: chk.error, message: chk.message }, { status: chk.status });

  // 本機房規：最多 20 條，編成 H1、H2⋯
  const house: string[] = Array.isArray(body?.house_rules)
    ? body.house_rules.slice(0, 20).map((t: any) => cleanText(t, 120)).filter(Boolean)
    : [];
  const all: Sentence[] = [...sentences, ...house.map((text, i) => ({ sid: `H${i + 1}`, section: "H", text }))];

  const r = await arbitrate(chk.input, all, env, lang);
  if (!r.ok) return Response.json({ error: r.error, message: r.message }, { status: r.status });
  return Response.json(r.data);
}
