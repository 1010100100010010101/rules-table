// 拍照上傳規則書：一次辨識一頁，結果交給房主檢查、修改後才開房。
// 辨識出的文字不會直接成為規則書，所以 AI 抄錯也能在開房前被人改掉。
import OCR_PROMPT from "../prompts/ocr.md";
import { callModel } from "./model";
import type { AppEnv } from "./env";

export const MAX_IMAGE_CHARS = 6_000_000; // data URL 長度上限，約 4.5 MB 的圖片
const DATA_URL_RE = /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/;

export type OcrResult =
  | { ok: true; text: string; unclear: number }
  | { ok: false; status: number; error: string; message: string };

export function checkImage(image: unknown): string | null {
  if (typeof image !== "string" || !image) return "沒有收到圖片";
  if (image.length > MAX_IMAGE_CHARS) return "圖片太大，請重拍或裁小一點";
  if (!DATA_URL_RE.test(image)) return "只支援 JPG、PNG、WebP 圖片";
  return null;
}

// 整理模型輸出：去掉 Markdown 圍欄、多餘空行
export function cleanOcr(raw: string): string {
  return raw
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/```\s*$/, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l, i, a) => l || (i > 0 && a[i - 1]))
    .join("\n")
    .trim();
}

export async function ocrPage(image: string, env: AppEnv): Promise<OcrResult> {
  let r;
  try {
    r = await callModel(
    env,
    OCR_PROMPT,
    [
      { type: "text", text: "請抄寫這一頁規則書。" },
      { type: "image_url", image_url: { url: image, detail: "high" } },
    ],
    {
      maxTokens: 4000,
      timeoutMs: 90000,
      model: env.VISION_MODEL_ID,
      baseUrl: env.VISION_BASE_URL,
      apiKey: env.VISION_API_KEY,
    },
  );
  } catch {
    return { ok: false, status: 504, error: "timeout", message: "辨識超時，請重拍清楚一點或分成兩張" };
  }
  if (r.status === 0) return { ok: false, status: 503, error: "no_key", message: "伺服器還沒設定模型金鑰" };
  if (r.status === 400) return { ok: false, status: 502, error: "no_vision", message: "目前設定的模型不能看圖，請改用貼上文字" };
  if (r.status === 429) return { ok: false, status: 429, error: "upstream_busy", message: "AI 服務忙碌中，請稍後再試" };
  if (r.status !== 200 || !r.text) return { ok: false, status: 502, error: "upstream", message: "辨識失敗，請再試一次" };
  const text = cleanOcr(r.text);
  if (!text || text === "NOT_RULES") {
    return { ok: false, status: 422, error: "not_rules", message: "這張照片看不到規則文字，請對準規則書重拍" };
  }
  return { ok: true, text: text.slice(0, 8000), unclear: (text.match(/〔看不清〕/g) || []).length };
}
