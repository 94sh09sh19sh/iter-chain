# iter-chain

在終端機一次打好多輪指令，每輪由全新的 session 執行（不共用上下文），上一輪做完自動開下一輪，中途不用盯。

## 輸入語法（分隔字串預設 `;;;`，沒打就完全不啟用）
- `A ;;; B ;;; C`：固定清單，依序做 A、B、C。
- `A ;;;*3`：A 做完再重複 3 輪；`A ;;;*2 B`：之後把 B 做 2 輪。
- `A ;;;?5 方向`：A 之後最多 5 輪「看上一輪結果決定」；每輪自己寫出下一輪指令，寫「無」就提早結束這一段。`方向` 可省略；`;;;?` 不寫數字就是 1 輪。
- 可以混用：`A ;;; B ;;;?3 改善效能 ;;; 最後更新文件`。
- 第一個分隔字串前要有文字；分隔字串後面沒東西時不啟用。

## 流程
1. UserPromptSubmit：偵測到分隔字串就建立迭代鏈，告訴目前的 session 只做第 1 段。
2. 每輪做完，模型把 10 行內的摘要寫到 `<專案>/.iter-chain/<鏈 id>/round-<k>.md`；下一輪是「看結果」時，多寫一節「## 下一輪」。
3. Stop：只有輪次檔寫好才往下排；中途停下或在問你問題時什麼都不做。本輪指令有 crosscheck 觸發字串、job 還沒 done 時也先不排，等 done 之後那次 Stop 再排（本輪沒打觸發字串就不看 job，同 session 的舊 job 不會卡住鏈）。
4. 開新的 Windows Terminal 分頁，用原本的權限模式啟動 `claude`；SessionStart 注入本輪指令、上一輪摘要和完成規則。
5. 某一輪撞到限額時，limit-relay 照常接手；iter-chain 從 `LIMIT_RELAY_JOB` 認出是同一輪，接手的 session 做完寫好輪次檔，鏈就繼續。原 session 有還在跑的 crosscheck job 時，一併轉給接手的 session。
6. `;;;?` 的方向會另起一行接在下一輪指令後面，所以方向裡的 crosscheck 觸發字串（例：`;;;?3 改善效能 %%2`）每輪都會生效。

## token 成本
- 判斷和開分頁都在 hook 裡做，不花 token。
- 每輪額外花：注入的規則約 150 token、上一輪摘要、寫輪次檔一次。

## 設定（config.json）
- 個人設定寫在同目錄的 `config.local.json`，只寫要改的鍵，會蓋過 `config.json`；更新工具時不會被覆蓋，也不會進 repo。
- `enabled`：總開關。
- `delimiter`：分隔字串。
- `defaultDynamicMax`：`;;;?` 沒寫數字時的輪數（預設 1）。
- `maxRounds`：一條鏈最多幾輪（預設 20）。
- `summaryMaxChars`：注入上一輪摘要的字數上限。
- `launchModes`：只有這些權限模式會自動開下一輪（預設只有 `auto`）；其他模式只排好，用 `next` 手動開。
- `terminal`：`wt` 或 `cmd`。
- `debug`：把每個 hook 的輸入存到 `state/debug/`。

## 指令
- `node cli.js status`：最近 10 條鏈和各輪狀態。
- `node cli.js log [行數]`：事件紀錄（`state/chain.log`）。
- `node cli.js next <鏈 id>`：手動開下一輪（非 auto 模式，或輪次檔寫好但沒觸發到接續時）。
- `node cli.js cancel <鏈 id|all>`：不再接續；進行中的那一輪不受影響。

## 停用
- 暫停：`config.local.json` 寫 `{"enabled": false}`。
- 移除：刪掉 `~/.claude/settings.json` 裡指向 `iter-chain/hook.js` 的 UserPromptSubmit、SessionStart、Stop 三個 hook。

## 已知限制
- 第 1 輪的 session 仍然看得到整則訊息（包括後面各段），只是被要求不要動手。
- 做完的舊分頁不會自動關，閒著不花 token，可以自己關。
- 某一輪沒做完（模型卡住、要你決定）就不會寫輪次檔，鏈會停在那裡；處理完請它寫輪次檔，或用 `next`。
- 輪次檔的「## 下一輪」漏寫時當作「無」處理。
- 跟 crosscheck 並用：本輪指令含觸發字串時，完成規則會要求 done 之後才寫輪次檔。crosscheck job 停在 running（沒跑 done）時鏈會停住；用 crosscheck 的 `cancel` 收掉 job，再用 `next` 接續。
