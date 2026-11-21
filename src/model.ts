export interface ModelEnv {
  MODEL_API_KEY: string;
  MODEL_BASE_URL: string;
  MODEL_ID: string;
}

export async function callModel(env: ModelEnv, system: string, user: string) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000); // 20 秒逾時
  try {
    const r = await fetch(`${env.MODEL_BASE_URL}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Authorization": `Bearer ${env.MODEL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.MODEL_ID,
        max_tokens: 800,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    const data: any = await r.json();
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