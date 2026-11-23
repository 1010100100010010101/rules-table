// 把核心流程接上真正的提示詞檔與模型服務
import ARBITRATE from "../prompts/arbitrate.md";
import TURN_GRAPH from "../prompts/turn_graph.md";
import { callModel, type ModelEnv } from "./model";
import { arbitrateWith, graphWith } from "./arbitrate-core";
import type { ArbInput } from "./input";
import type { Sentence } from "./split";

export function arbitrate(input: ArbInput, sentences: Sentence[], env: ModelEnv) {
  return arbitrateWith((s, u, o) => callModel(env, s, u, o), ARBITRATE, input, sentences);
}

export function generateGraph(sentences: Sentence[], env: ModelEnv) {
  return graphWith((s, u, o) => callModel(env, s, u, o), TURN_GRAPH, sentences);
}
