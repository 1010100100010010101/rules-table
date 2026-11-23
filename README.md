# 規則仲裁桌

桌遊吵規則時，全桌手機進同一個房間：兩人各說一句規則，AI 指出規則書哪一句支持誰。依據的原句由程式依編號從規則書取出，AI 不能改寫。規則書沒寫的，全桌投票定成房規。

## 功能

- **拍照上傳規則書**：一頁一張，最多 8 頁。AI 逐字抄成文字，房主對照照片改好、補上〔看不清〕的地方才能開房。照片不保存。
- **共享房間**：房主開房，其他人輸入 6 碼房號或打開連結加入。可以當玩家或只看。
- **裁定**：分兩方對質和直接提問。結果分成明文、推論（要全桌同意）、規則衝突、規則書沒寫、說法不清和非規則問題。
- **房規投票**：規則書沒寫或互相衝突時發起投票。通過後寫入 H1、H2…，優先於規則書。
- **私下問**：只有自己看得到，也可以公開給全桌。
- **流程**：AI 把規則書整理成回合地圖，房主確認後開始第一回合引導。擲骰會自動選分支。
- **工具**：虛擬骰子（由伺服器擲出，全桌看到同一個結果）和玩家順序。
- **補充來源**：房主可以貼 FAQ 或勘誤（F1…）。
- **單機版**：`/solo.html`。

## 本機測試

```bash
npm install
npx wrangler dev
```

金鑰放在 `.dev.vars`，格式見 `.dev.vars.example`。這個檔不要提交。

## 部署

```bash
npx wrangler secret put MODEL_API_KEY   # 第一次部署，或換金鑰時
npx wrangler deploy
```

要換模型（例如華為 MaaS），只需改 `wrangler.jsonc` 裡的 `MODEL_BASE_URL`、`MODEL_ID`，再重設 `MODEL_API_KEY`。

拍照辨識預設沿用同一個模型（`deepseek-flash` 能看圖）。如果換成不能看圖的模型，另外設定 `VISION_MODEL_ID`、`VISION_BASE_URL`（vars）和 `VISION_API_KEY`（secret）。

## 限制

- 拍照辨識每個 IP 每分鐘最多 10 頁，每張照片上傳前會縮到最長邊 2000px。
- 每台裝置每分鐘最多 6 次 AI 呼叫，全站每天上限 `DAILY_LIMIT` 次，每個房間每小時最多 40 次。
- 房間最後一次活動後 48 小時自動刪除，房主也可以手動結束。
- 一個房間最多 12 位玩家、25 張裁定卡，規則書最多 20000 字。
- 市售遊戲的規則書不放進這個程式庫，由房主開房時自己貼上。

## 結構

```
src/index.ts         路由
src/room.ts          RoomDO（WebSocket、儲存、自動刪除）
src/room-core.ts     房間邏輯（投票、引導、骰子）
src/arbitrate-core.ts  裁定與回合地圖：呼叫模型 → 檢查 → 取原句
src/ocr.ts           拍照辨識
src/split.ts         切句與編號
src/validate.ts      裁定格式檢查
src/graph-validate.ts  回合地圖檢查
src/usage.ts         用量限制
prompts/*.md         系統提示
public/              前端
```
