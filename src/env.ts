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
}
