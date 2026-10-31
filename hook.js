// iter-chain 的 hook 入口：UserPromptSubmit、SessionStart、Stop
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./lib');
const C = require('./chain');

const out = (obj) => process.stdout.write(JSON.stringify(obj));

// 改鏈指令只改這個 session 所屬的鏈（取消掉的不算）；改別的鏈用 cli.js
function ownChain(input) {
  const sess = L.readJson(L.sessionFile(input.session_id));
  const chain = sess && L.loadChain(sess.chainId);
  return chain?.status === 'cancelled' ? null : chain;
}

const block = (reason) => out({ decision: 'block', reason });

// 改鏈指令直接在 hook 處理完並擋下，不送給模型、不花 token
function onEdit(input, cmd, cfg) {
  const chain = ownChain(input);
  if (chain) return block(C.edit(chain, cmd, cfg));
  if (cmd.op !== 'insert') return block(`iter-chain：這個 session 不屬於迭代鏈；用 ${cfg.delimiter}@ 指令 轉成多輪，改別的鏈用 node ~/.claude/iter-chain/cli.js`);
  if (cmd.k && cmd.k !== 2) return block(`iter-chain：這個 session 是第 1 輪，插入的輪次只能從第 2 輪開始`);
  convert(input, cmd, cfg);
}

// 單輪 session 轉成鏈的第 1 輪。指令不能讓模型看到，不然它會跟著做，上下文就混在一起了：
// 模型還在工作：等回合結束 Stop 再叫它寫輪次檔（tellConverted）
// 模型閒著：不會再有 Stop，這一輪視為做完，工具代寫輪次檔並排下一輪
function convert(input, cmd, cfg) {
  const chain = create(input, cfg, { first: '原本的單輪對話（限額接手時照交接內容接續）', items: cmd.items.slice(0, cfg.maxRounds - 1) }, true);
  const { idle, text } = L.lastTurn(input.transcript_path);
  if (!idle) return block(`iter-chain：迭代鏈 ${chain.id}，最多 ${chain.total} 輪${autoNote(chain, cfg)}；這則指令沒有送給模型，這個回合結束後才接續`);
  chain.rounds[0].askedNext = false;
  fs.writeFileSync(L.roundFile(chain, 1), text || '（單輪 session 轉成鏈，沒有回覆內容）');
  block(C.advance(chain, cfg));
}

// 使用者輸入含分隔字串時建立迭代鏈，這個 session 只做第 1 段
function onUserPromptSubmit(input, cfg) {
  const cmd = L.parseEdit(String(input.prompt || ''), cfg);
  if (cmd) return input.cwd && onEdit(input, cmd, cfg);
  const plan = L.parsePrompt(String(input.prompt || ''), cfg);
  if (plan && input.cwd) start(input, cfg, plan);
}

const autoNote = (chain, cfg) => (cfg.launchModes.includes(chain.permissionMode) ? '，每輪完成後自動開新分頁' : `；權限模式 ${chain.permissionMode} 不會自動接續（要 ${cfg.launchModes.join('/')}）`);

// 建立迭代鏈，這個 session 是第 1 輪；converted 表示由單輪 session 轉成的
function create(input, cfg, plan, converted = false) {
  const id = `${Date.now().toString(36)}`;
  const chain = {
    id,
    cwd: input.cwd,
    dir: L.prepareDir(input.cwd, id),
    delimiter: cfg.delimiter,
    permissionMode: input.permission_mode || 'default',
    status: 'running',
    total: 1 + plan.items.length,
    items: plan.items,
    pos: 0,
    rounds: [{ k: 1, type: 'fixed', instruction: plan.first, sid: input.session_id, status: 'running', startedAt: Date.now(), askedNext: plan.items[0].type === 'dyn', converted }],
    createdAt: Date.now(),
  };
  L.saveChain(chain);
  L.writeJson(L.sessionFile(input.session_id), { chainId: id, k: 1 });
  L.log(`[${id}] 建立迭代鏈，最多 ${chain.total} 輪，權限模式 ${chain.permissionMode}，${chain.cwd}`);
  return chain;
}

function start(input, cfg, plan) {
  const chain = create(input, cfg, plan);
  out({
    systemMessage: `iter-chain：迭代鏈 ${chain.id}，最多 ${chain.total} 輪${autoNote(chain, cfg)}`,
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: C.contextFor(chain, chain.rounds[0], cfg) },
  });
}

// 認出「工具開的下一輪」或「limit-relay 接手的同一輪」，注入本輪指令
function onSessionStart(input, cfg) {
  let chain = null;
  let r = null;
  let note = '';
  let relaySid = null;
  const tag = process.env.ITER_CHAIN_JOB;
  if (tag) {
    const [id, k] = tag.split(':');
    chain = L.loadChain(id);
    r = chain?.rounds.find((x) => x.k === Number(k) && x.status === 'launched') || null;
  }
  if (!r && process.env.LIMIT_RELAY_JOB) {
    const job = L.readJson(path.join(L.RELAY_JOBS, `${process.env.LIMIT_RELAY_JOB}.json`));
    relaySid = job?.sid;
    const old = job && L.readJson(L.sessionFile(job.sid));
    chain = old && L.loadChain(old.chainId);
    r = chain?.rounds.find((x) => x.k === old.k && x.status === 'running') || null;
    note = '這一輪的上一個 session 因用量限額中斷，請配合 limit-relay 交接內容接續，不要重做已完成的部分。';
  }
  if (!chain || !r || chain.status !== 'running') return;
  r.status = 'running';
  r.sid = input.session_id;
  r.startedAt = Date.now();
  r.askedNext = C.asksNext(chain);
  r.told = true;
  L.saveChain(chain);
  L.writeJson(L.sessionFile(input.session_id), { chainId: chain.id, k: r.k });
  L.log(`[${chain.id}] 第 ${r.k} 輪由 session ${String(input.session_id).slice(0, 8)} 執行${note ? '（限額接手）' : ''}`);
  // 本輪指令含 crosscheck 觸發字串時：工具開的新輪建立 job；限額接手的把原 session 還在跑的 job 轉過來
  let cc = '';
  if (C.usesCrosscheck(r.instruction)) {
    try {
      const X = require('../crosscheck/lib');
      cc = note ? X.handOver(relaySid, input) : X.fromIterChain(input, r.instruction);
    } catch (e) {
      L.log(`[${chain.id}] crosscheck 整合錯誤：${e.stack || e}`);
    }
  }
  // 沒有 job 可等（建立失敗、原 job 已結束）時，完成規則不要求等 crosscheck
  out({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: [C.contextFor(chain, r, cfg, note, Boolean(cc)), cc].filter(Boolean).join('\n\n') } });
}

// 這個 session 登記過的那一輪，且輪次檔已寫好
function ownRound(input) {
  const sess = L.readJson(L.sessionFile(input.session_id));
  const chain = sess && L.loadChain(sess.chainId);
  if (!chain || chain.status !== 'running') return null;
  const r = chain.rounds[chain.rounds.length - 1];
  if (r.k !== sess.k || r.status !== 'running' || !fs.existsSync(L.roundFile(chain, r.k))) return null;
  return chain;
}

// 中斷的那一輪由使用者手動開的 session 接續時沒有登記（例：撞週額度，limit-relay 不接手）：
// 同專案底下、最後一輪還沒完成、輪次檔卻已寫好的鏈，就由這個 session 認領
function adopt(input) {
  if (!input.cwd) return null;
  const chain = L.listChains()
    .filter((c) => c.status === 'running' && L.isInside(input.cwd, c.cwd))
    .sort((a, b) => b.createdAt - a.createdAt)
    .find((c) => {
      const r = c.rounds[c.rounds.length - 1];
      return ['running', 'launched'].includes(r.status) && fs.existsSync(L.roundFile(c, r.k));
    });
  if (!chain) return null;
  const r = chain.rounds[chain.rounds.length - 1];
  if (r.sid && r.sid !== input.session_id) r.prevSid = r.sid;
  r.sid = input.session_id;
  r.status = 'running';
  L.saveChain(chain);
  L.writeJson(L.sessionFile(input.session_id), { chainId: chain.id, k: r.k });
  L.log(`[${chain.id}] 第 ${r.k} 輪輪次檔由未登記的 session ${String(input.session_id).slice(0, 8)} 寫好，認領後接續`);
  return chain;
}

// 工作中轉成鏈的第 1 輪：模型不知道要寫輪次檔，回合結束時讓它繼續並告訴它，只講一次（還在等使用者回覆時它會直接結束，規則留在上下文）
function tellConverted(input, cfg) {
  const sess = L.readJson(L.sessionFile(input.session_id));
  const chain = sess && L.loadChain(sess.chainId);
  const r = chain?.rounds[chain.rounds.length - 1];
  if (chain?.status !== 'running' || !r.converted || r.told || r.k !== sess.k || r.status !== 'running') return false;
  r.told = true;
  L.saveChain(chain);
  block(C.contextFor(chain, r, cfg));
  return true;
}

// 每次回合結束都會觸發；只有本輪的輪次檔已經寫好才往下排，其他情況（中途停下、問問題）什麼都不做
function onStop(input, cfg) {
  let chain = ownRound(input);
  if (!chain && tellConverted(input, cfg)) return;
  chain ||= adopt(input);
  if (!chain) return;
  const r = chain.rounds[chain.rounds.length - 1];
  // 輪次檔提早寫了但 crosscheck 還沒 done：先不接續，等 done 之後的 Stop；本輪沒打觸發字串就不看（避免同 session 的舊 job 卡住）
  if (C.usesCrosscheck(r.instruction) && C.crosscheckRunning(input.session_id)) return L.log(`[${chain.id}] 第 ${r.k} 輪輪次檔已寫，crosscheck 還沒跑完，先不接續`);
  out({ systemMessage: C.advance(chain, cfg) });
}

function main() {
  const cfg = L.loadConfig();
  const input = L.readStdin();
  if (!cfg.enabled || !input.session_id) return;
  L.ensureDirs();
  if (cfg.debug) L.writeJson(path.join(L.DIRS.debug, `${input.hook_event_name}.json`), input);
  switch (input.hook_event_name) {
    case 'UserPromptSubmit':
      return onUserPromptSubmit(input, cfg);
    case 'SessionStart':
      return onSessionStart(input, cfg);
    case 'Stop':
      return onStop(input, cfg);
  }
}

try {
  main();
} catch (e) {
  L.log(`hook 錯誤：${e.stack || e}`);
}
