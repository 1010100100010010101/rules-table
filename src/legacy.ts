import { DurableObject } from "cloudflare:workers";

// 範本最早建立的 Durable Object。已經部署過的類別不能直接刪除（要另寫刪除 migration），
// 所以保留一個空殼，不再使用。
export class MyDurableObject extends DurableObject {}
