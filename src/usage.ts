import { DurableObject } from "cloudflare:workers";

// 全站共用的用量計數器：每個來源每分鐘上限＋全站每日上限
export class UsageDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS daily (day TEXT PRIMARY KEY, n INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS minute (k TEXT NOT NULL, m INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (k, m));
    `);
  }

  async take(key: string, perMinute: number, perDay: number) {
    const now = Date.now();
    const day = new Date(now + 8 * 3600e3).toISOString().slice(0, 10); // 以台北時間算「今天」
    const m = Math.floor(now / 60000);
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM minute WHERE m < ?", m - 1);

    const d: any = sql.exec("SELECT n FROM daily WHERE day = ?", day).toArray()[0];
    if (d && d.n >= perDay) return { ok: false, reason: "daily", retryAfter: 0 };

    const r: any = sql.exec("SELECT n FROM minute WHERE k = ? AND m = ?", key, m).toArray()[0];
    if (r && r.n >= perMinute) {
      return { ok: false, reason: "minute", retryAfter: 60 - Math.floor((now % 60000) / 1000) };
    }

    sql.exec("INSERT INTO minute (k, m, n) VALUES (?, ?, 1) ON CONFLICT(k, m) DO UPDATE SET n = n + 1", key, m);
    sql.exec("INSERT INTO daily (day, n) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1", day);
    return { ok: true, reason: null, retryAfter: 0 };
  }

  // 只檢查頻率、不算進每日模型額度（用在開房）
  async gate(key: string, perMinute: number) {
    const now = Date.now();
    const m = Math.floor(now / 60000);
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM minute WHERE m < ?", m - 1);
    const r: any = sql.exec("SELECT n FROM minute WHERE k = ? AND m = ?", key, m).toArray()[0];
    if (r && r.n >= perMinute) return { ok: false, retryAfter: 60 - Math.floor((now % 60000) / 1000) };
    sql.exec("INSERT INTO minute (k, m, n) VALUES (?, ?, 1) ON CONFLICT(k, m) DO UPDATE SET n = n + 1", key, m);
    return { ok: true, retryAfter: 0 };
  }
}
