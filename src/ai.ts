// 把核心流程接上真正的提示詞檔與模型服務
import ARBITRATE from "../prompts/arbitrate.md";
import TURN_GRAPH from "../prompts/turn_graph.md";
import TRANSLATE from "../prompts/translate.md";
import { callModel, type ModelEnv } from "./model";
import { arbitrateWith, graphWith, translateWith } from "./arbitrate-core";
import type { ArbInput } from "./input";
import type { Sentence } from "./split";
import type { Lang } from "./i18n";

export function arbitrate(input: ArbInput, sentences: Sentence[], env: ModelEnv, lang?: Lang) {
  return arbitrateWith((s, u, o) => callModel(env, s, u, o), ARBITRATE, input, sentences, lang);
}

export function generateGraph(sentences: Sentence[], env: ModelEnv, lang?: Lang) {
  return graphWith((s, u, o) => callModel(env, s, u, o), TURN_GRAPH, sentences, lang);
}

export function translate(text: string, to: Lang, env: ModelEnv) {
  return translateWith((s, u, o) => callModel(env, s, u, o), TRANSLATE, text, to);
}
