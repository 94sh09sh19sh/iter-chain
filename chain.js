// 迭代鏈流程：產生注入給模型的文字、決定下一輪、開新 session
'use strict';
const fs = require('fs');
const L = require('./lib');

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

// crosscheck 整合：載不到就當沒裝
function crosscheck() {
  try {
    return require('../crosscheck/lib');
  } catch {
    return null;
  }
}

// 本輪指令含 crosscheck 觸發字串（且 crosscheck 開著）
function usesCrosscheck(text) {
  const X = crosscheck();
  const cfg = X?.loadConfig();
  return Boolean(cfg?.enabled && X.parseTrigger(String(text || ''), cfg));
}

// 這個 session 的 crosscheck job 還沒 done 或 cancel
function crosscheckRunning(sid) {
  return crosscheck()?.jobOfSession(sid)?.status === 'running';
}

// 每輪結束要寫的輪次檔；下一輪要看結果決定時才多要「下一輪」一節；cc 表示本輪有 crosscheck job 要等
function rules(chain, r, cc = usesCrosscheck(r.instruction)) {
  const next = chain.items[chain.pos];
  const lines = [
    `完成規則：本輪做完並驗證後${cc ? '、crosscheck 跑完 done 之後' : ''}，最後一步用 Write 建立 ${L.roundFile(chain, r.k)}，內容：`,
    '## 摘要',
    '條列 10 行內：做了什麼、改了哪些檔、還沒解決的問題',
  ];
  if (next?.type === 'dyn') lines.push('## 下一輪', `一段可以直接執行的下一輪指令${next.guide ? `（使用者給的方向：${next.guide}）` : ''}；已經沒有值得做的就只寫「無」`);
  lines.push(next ? '沒做完不要建立這個檔。建立後工具會自動開新 session 做下一輪，你直接結束回覆，不用提這件事。' : '這是最後一輪；沒做完不要建立這個檔。');
  return lines.join('\n');
}

function summaryOf(chain, k, cfg) {
  const text = readText(L.roundFile(chain, k));
  return (L.section(text, '摘要') || text.trim()).slice(0, cfg.summaryMaxChars);
}

// 限額接手的第 1 輪沒有使用者那則訊息，跟後面各輪一樣直接給本輪指令
function contextFor(chain, r, cfg, note = '', cc = undefined) {
  const head = r.k === 1 && !note
    ?`[iter-chain] 使用者這則訊息是迭代鏈 ${chain.id}（最多 ${chain.total} 輪）。這個 session 只做第 1 段（第一個 ${chain.delimiter} 之前）；後面各段工具會排到新 session，不要動手，也不要先替後面幾輪做準備。`
    : `[iter-chain] 迭代鏈 ${chain.id} 第 ${r.k} 輪（最多 ${chain.total} 輪）。這個 session 是工具開的，只做本輪指令：\n${r.instruction}`;
  const prev = r.k > 1 ? summaryOf(chain, r.k - 1, cfg) : '';
  return [head, note, prev && `上一輪摘要（${L.roundFile(chain, r.k - 1)}）：\n${prev}`, rules(chain, r, cc)].filter(Boolean).join('\n\n');
}

// 權限模式不在 launchModes 時只排好不開，等使用者用 cli.js next 手動開
function launch(chain, r, cfg) {
  if (!cfg.launchModes.includes(chain.permissionMode)) {
    r.status = 'pending';
    L.saveChain(chain);
    L.log(`[${chain.id}] 第 ${r.k} 輪已排好；權限模式 ${chain.permissionMode} 不自動開，用 cli.js next ${chain.id} 手動開`);
    return null;
  }
  r.status = 'launched';
  r.launchedAt = Date.now();
  L.saveChain(chain);
  const via = L.openTab(chain, r.k, cfg);
  L.log(`[${chain.id}] 第 ${r.k} 輪已用 ${via} 開新 session`);
  return via;
}

// 上一輪的輪次檔寫好後呼叫：跳過不需要的「看結果」輪，排出下一輪；回傳給使用者看的訊息
function advance(chain, cfg) {
  const prev = chain.rounds[chain.rounds.length - 1];
  prev.status = 'done';
  prev.doneAt = Date.now();
  const nextText = L.section(readText(L.roundFile(chain, prev.k)), '下一輪');
  let skipped = 0;
  while (chain.items[chain.pos]?.type === 'dyn' && L.isNone(nextText)) {
    chain.pos++;
    skipped++;
  }
  if (skipped) L.log(`[${chain.id}] 第 ${prev.k} 輪認為沒有下一輪可做，略過 ${skipped} 個看結果的輪次`);
  const item = chain.items[chain.pos];
  if (!item) {
    chain.status = 'done';
    L.saveChain(chain);
    L.log(`[${chain.id}] 迭代鏈完成，共 ${prev.k} 輪`);
    return `iter-chain：迭代鏈 ${chain.id} 完成，共 ${prev.k} 輪；紀錄在 ${chain.dir}`;
  }
  chain.pos++;
  // 方向另起一行、不加括號，裡面的 crosscheck 觸發字串前後才會是空白
  const instruction = item.type === 'fixed' ? item.text : `${nextText}${item.guide ? `\n使用者給的方向：\n${item.guide}` : ''}`;
  const r = { k: prev.k + 1, type: item.type, instruction, status: 'pending', createdAt: Date.now() };
  chain.rounds.push(r);
  const via = launch(chain, r, cfg);
  return via ? `iter-chain：第 ${prev.k} 輪完成，第 ${r.k} 輪已在新分頁開始` : `iter-chain：第 ${prev.k} 輪完成；權限模式 ${chain.permissionMode} 不自動接續，用 node ~/.claude/iter-chain/cli.js next ${chain.id} 開第 ${r.k} 輪`;
}

module.exports = { contextFor, advance, launch, usesCrosscheck, crosscheckRunning };
