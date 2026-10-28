# 待修 bug

## 1. 手動開的 session 接續中斷的那一輪，鏈不會往下排

- 發現：2026-10-28，一條 6 輪的鏈停在第 4 輪。
- 經過：第 4 輪 session `b3aa0691` 撞到**週額度**，只寫了 `handoff-round-4.md`，沒寫 `round-4.md`；limit-relay 記「內建自動續跑放行（沒有接手工作）」，沒開接手 session。
- 之後使用者手動開新 session `483520d4`，請它讀交接檔接著做第 4 輪。
- 結果：`483520d4` 做完、寫好 `round-4.md`，Stop 也不會開第 5 輪。

### 原因
- `onStop` 用 `state/sessions/<session_id>.json` 找所屬的鏈；這個檔只在兩種情況建立：
  - `onUserPromptSubmit` 建鏈時（第 1 輪）。
  - `onSessionStart` 看到環境變數 `ITER_CHAIN_JOB`（工具開的下一輪）或 `LIMIT_RELAY_JOB`（limit-relay 接手）。
- 手動開的 session 兩個環境變數都沒有，不會被認成第 4 輪，Stop 直接 return。
- 上游原因：limit-relay 只處理 5 小時限額，週額度撞到時不建接手 job，所以也不會帶 `LIMIT_RELAY_JOB`。

### 目前繞法
- 那一輪寫好 `round-4.md` 之後，手動跑 `node ~/.claude/iter-chain/cli.js next <鏈 id>`（`next` 只看輪次檔在不在，不看 session）。

### 修法方向（待決定）
- Stop 找不到 session 檔時，退而找「同 cwd、狀態 running、最後一輪 running、且該輪輪次檔剛出現」的鏈；輪次檔路徑含鏈 id，誤判機率低。
- 或在 SessionStart（`source: startup`）時，若同 cwd 有 running 的鏈卡在某輪且沒輪次檔，注入一行提示：接續這一輪請寫 `round-<k>.md`，並登記 session。
- 另外：limit-relay 是否該支援週額度接手（等重置時間太長，可能只記 job 不自動開）。
