import type { UsageDO } from "./usage";
import type { RoomDO } from "./room";

export interface AppEnv {
  ASSETS: Fetcher;
  USAGE: DurableObjectNamespace<UsageDO>;
  ROOM: DurableObjectNamespace<RoomDO>;
  MODEL_API_KEY?: string;
  MODEL_BASE_URL: string;
  MODEL_ID: string;
  DAILY_LIMIT?: string;
  // 拍照辨識用的視覺模型；沒設就沿用上面三個（deepseek-flash 本身能看圖）
  VISION_MODEL_ID?: string;
  VISION_BASE_URL?: string;
  VISION_API_KEY?: string;
}
