// 呼叫模型的唯一入口。任何 OpenAI 相容的服務都能用（DeepSeek、華為雲 MaaS⋯），
// 換供應商只要改 wrangler.jsonc 的 MODEL_BASE_URL、MODEL_ID 和 secret MODEL_API_KEY。

export interface ModelEnv {
  MODEL_API_KEY?: string;
  MODEL_BASE_URL: string;
  MODEL_ID: string;
}

export type ModelResult = { status: number; text: string | null; usage: any; error: any };

export async function callModel(
  env: ModelEnv,
  system: string,
  user: string,
  opts: { maxTokens?: number; timeoutMs?: number } = {},
): Promise<ModelResult> {
  if (!env.MODEL_API_KEY) return { status: 0, text: null, usage: null, error: "no_key" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30000);
  try {
    const r = await fetch(`${env.MODEL_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${env.MODEL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.MODEL_ID,
        max_tokens: opts.maxTokens ?? 2000,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    const data: any = await r.json().catch(() => null);
    return {
      status: r.status,
      text: data?.choices?.[0]?.message?.content ?? null,
      usage: data?.usage ?? null,
      error: r.ok ? null : data,
    };
  } finally {
    clearTimeout(timer);
  }
}
