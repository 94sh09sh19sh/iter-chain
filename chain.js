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

// 下一項是看結果的輪次時，本輪要多寫「下一輪」一節；開始一輪時記到 r.askedNext，之後插入看結果的輪次時要用
const asksNext = (chain) => chain.items[chain.pos]?.type === 'dyn';

// 每輪結束要寫的輪次檔；下一輪要看結果決定時才多要「下一輪」一節；cc 表示本輪有 crosscheck job 要等
function rules(chain, r, cc = usesCrosscheck(r.instruction)) {
  const next = chain.items[chain.pos];
  const lines = [
    `完成規則：本輪做完並驗證後${cc ? '、crosscheck 跑完 done 之後' : ''}，最後一步用 Write 建立 ${L.roundFile(chain, r.k)}，內容：`,
    '## 摘要',
    '條列 10 行內：做了什麼、改了哪些檔、還沒解決的問題',
  ];
  if (asksNext(chain)) lines.push('## 下一輪', `一段可以直接執行的下一輪指令${next.guide ? `（使用者給的方向：${next.guide}）` : ''}；已經沒有值得做的就只寫「無」`);
  lines.push('中途停下要交接時，交接內容寫明接續的人做完要建立這個檔。');
  lines.push(next ? '沒做完不要建立這個檔。建立後工具會自動開新 session 做下一輪，你直接結束回覆，不用提這件事。' : '這是最後一輪；沒做完不要建立這個檔。');
  return lines.join('\n');
}

function summaryOf(chain, k, cfg) {
  const text = readText(L.roundFile(chain, k));
  return (L.section(text, '摘要') || text.trim()).slice(0, cfg.summaryMaxChars);
}

// 限額接手的第 1 輪沒有使用者那則訊息，跟後面各輪一樣直接給本輪指令
function contextFor(chain, r, cfg, note = '', cc = undefined) {
  const head = r.converted && !note
    ? `[iter-chain] 使用者用 ${chain.delimiter}@ 把這個 session 改成迭代鏈 ${chain.id} 的第 1 輪（最多 ${chain.total} 輪）。第 1 輪就是這個 session 原本的工作，照常做完（已經做完就直接寫輪次檔，還在等使用者回覆就直接結束回覆）；後面各輪工具會排到新 session，不要動手。`
    : r.k === 1 && !note
    ?`[iter-chain] 使用者這則訊息是迭代鏈 ${chain.id}（最多 ${chain.total} 輪）。這個 session 只做第 1 段（第一個 ${chain.delimiter} 之前）；後面各段工具會排到新 session，不要動手，也不要先替後面幾輪做準備。`
    : `[iter-chain] 迭代鏈 ${chain.id} 第 ${r.k} 輪（最多 ${chain.total} 輪）。這個 session 是工具開的，只做本輪指令：\n${r.instruction}`;
  const notes = chain.notes?.length ? `使用者中途補充的指令（每輪都適用）：\n${chain.notes.map((n) => `- ${n}`).join('\n')}` : '';
  const prev = r.k > 1 ? summaryOf(chain, r.k - 1, cfg) : '';
  return [head, note, notes, prev && `上一輪摘要（${L.roundFile(chain, r.k - 1)}）：\n${prev}`, rules(chain, r, cc)].filter(Boolean).join('\n\n');
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

// 上一輪的輪次檔寫好後呼叫；回傳給使用者看的訊息
function advance(chain, cfg) {
  const prev = chain.rounds[chain.rounds.length - 1];
  prev.status = 'done';
  prev.doneAt = Date.now();
  return schedule(chain, cfg);
}

// 最後一輪已完成時排出下一輪：跳過不需要的「看結果」輪
function schedule(chain, cfg) {
  const prev = chain.rounds[chain.rounds.length - 1];
  const nextText = L.section(readText(L.roundFile(chain, prev.k)), '下一輪');
  // 上一輪開始時下一項還不是看結果的輪次（之後才插入），沒被要求寫「下一輪」，改由這一輪自己決定
  const self = prev.askedNext === false;
  let skipped = 0;
  while (chain.items[chain.pos]?.type === 'dyn' && !self && L.isNone(nextText)) {
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
  const dynText = self ? '看上一輪摘要，自己決定這一輪最值得做的事並執行。' : nextText;
  const instruction = item.type === 'fixed' ? item.text : `${dynText}${item.guide ? `\n使用者給的方向：\n${item.guide}` : ''}`;
  const r = { k: prev.k + 1, type: item.type, instruction, status: 'pending', createdAt: Date.now() };
  chain.rounds.push(r);
  const via = launch(chain, r, cfg);
  return via ? `iter-chain：第 ${prev.k} 輪完成，第 ${r.k} 輪已在新分頁開始` : `iter-chain：第 ${prev.k} 輪完成；權限模式 ${chain.permissionMode} 不自動接續，用 node ~/.claude/iter-chain/cli.js next ${chain.id} 開第 ${r.k} 輪`;
}

// 還沒開始的輪次是 items[from..]，依序是第 base+1 輪起；最後一輪只排好沒開（pending）也算還沒開始
function future(chain) {
  const last = chain.rounds[chain.rounds.length - 1];
  const pending = last?.status === 'pending';
  return { pending, base: chain.rounds.length - (pending ? 1 : 0), from: pending ? chain.pos - 1 : chain.pos };
}

const brief = (t) => String(t || '').replace(/\s+/g, ' ').slice(0, 40);
const kind = (x) => (x.type === 'dyn' ? '看結果' : '固定');

// 各輪清單：已開始的、還沒開始的、補充指令
function plan(chain) {
  const { pending, base, from } = future(chain);
  const lines = chain.rounds.slice(0, base).map((r) => `  第 ${r.k} 輪｜${kind(r)}｜${r.status}｜${brief(r.instruction)}`);
  chain.items.slice(from).forEach((it, i) => lines.push(`  第 ${base + 1 + i} 輪｜${kind(it)}｜${i === 0 && pending ? '已排好' : '未執行'}｜${brief(it.type === 'fixed' ? it.text : it.guide)}`));
  for (const n of chain.notes || []) lines.push(`  補充：${brief(n)}`);
  return lines.join('\n');
}

// 使用者中途改鏈：補充指令、刪除或插入還沒開始的輪次；回傳給使用者看的訊息
function edit(chain, cmd, cfg) {
  const head = `iter-chain：迭代鏈 ${chain.id}`;
  const usage = `${head}\n用法：${chain.delimiter}（列出）｜${chain.delimiter}+ 補充指令｜${chain.delimiter}- 3 5-7（刪除）｜${chain.delimiter}@3 指令（插入成第 3 輪；不寫數字加在最後）`;
  if (cmd.op === 'show') return `${head}｜${chain.status}\n${plan(chain)}`;
  if (cmd.op === 'usage') return usage;
  // 已完成的鏈只能在最後加輪次，加了就重新開始接續
  const reopen = chain.status === 'done' && cmd.op === 'insert';
  if (chain.status !== 'running' && !reopen) return `${head} 狀態是 ${chain.status}，不能修改`;
  if (cmd.op === 'note') {
    (chain.notes ||= []).push(cmd.text);
    L.saveChain(chain);
    L.log(`[${chain.id}] 加入補充指令：${brief(cmd.text)}`);
    return `${head} 已加入補充指令，之後開始的每一輪都會看到\n${plan(chain)}`;
  }
  const { pending, base, from } = future(chain);
  const count = chain.items.length - from;
  let done;
  if (cmd.op === 'drop') {
    const bad = cmd.ks.filter((k) => k <= base || k > base + count);
    if (bad.length) return `${head} 第 ${bad.join('、')} 輪不是還沒開始的輪次（可刪 ${base + 1}–${base + count}）\n${plan(chain)}`;
    const idx = [...new Set(cmd.ks)].map((k) => from + k - base - 1).sort((a, b) => b - a);
    for (const i of idx) chain.items.splice(i, 1);
    done = `已刪除第 ${[...new Set(cmd.ks)].sort((a, b) => a - b).join('、')} 輪`;
  } else {
    const k = cmd.k ?? base + count + 1;
    if (k <= base || k > base + count + 1) return `${head} 只能插入成第 ${base + 1}–${base + count + 1} 輪\n${plan(chain)}`;
    const room = cfg.maxRounds - 1 - chain.items.length;
    if (room <= 0) return `${head} 已達上限 ${cfg.maxRounds} 輪（maxRounds），不能再插入`;
    const items = cmd.items.slice(0, room);
    chain.items.splice(from + k - base - 1, 0, ...items);
    done = `已插入 ${items.length} 輪成為第 ${k}${items.length > 1 ? `–${k + items.length - 1}` : ''} 輪${items.length < cmd.items.length ? `（超過 maxRounds ${cfg.maxRounds}，捨棄 ${cmd.items.length - items.length} 輪）` : ''}`;
  }
  chain.total = 1 + chain.items.length;
  L.log(`[${chain.id}] ${done}`);
  // 排好沒開的那一輪退回清單、已完成的鏈重新開始，都要重排下一輪
  let next = '';
  if (pending || reopen) {
    if (pending) chain.rounds.pop();
    chain.pos = from;
    chain.status = 'running';
    next = `\n${schedule(chain, cfg)}`;
  } else L.saveChain(chain);
  return `${head} ${done}${next}\n${plan(chain)}`;
}

module.exports = { asksNext, contextFor, advance, launch, plan, edit, usesCrosscheck, crosscheckRunning };
