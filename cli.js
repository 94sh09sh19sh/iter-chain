// iter-chain 管理指令：status、log、next、cancel
'use strict';
const fs = require('fs');
const L = require('./lib');
const C = require('./chain');

const [cmd = 'status', arg] = process.argv.slice(2);
const when = (t) => (t ? new Date(t).toLocaleString('zh-TW', { hour12: false }) : '-');

function status() {
  const cfg = L.loadConfig();
  console.log(`啟用：${cfg.enabled ? '是' : '否'}｜分隔字串：${cfg.delimiter}｜自動接續的權限模式：${cfg.launchModes.join('/')}`);
  const chains = L.listChains().sort((a, b) => b.createdAt - a.createdAt).slice(0, 10);
  if (!chains.length) return console.log('迭代鏈：無');
  for (const c of chains) {
    console.log(`- ${c.id}｜${c.status}｜最多 ${c.total} 輪｜${when(c.createdAt)}｜${c.cwd}`);
    for (const r of c.rounds) console.log(`    第 ${r.k} 輪｜${r.type === 'dyn' ? '看結果' : '固定'}｜${r.status}｜${String(r.instruction).replace(/\s+/g, ' ').slice(0, 40)}`);
  }
}

// 手動推進：開出排好但沒自動開的輪次，或補做輪次檔已寫好但沒觸發到的接續
function next() {
  const c = L.loadChain(arg);
  if (!c) return console.log(`找不到迭代鏈 ${arg}`);
  if (c.status !== 'running') return console.log(`迭代鏈狀態是 ${c.status}，不需要推進`);
  const cfg = L.loadConfig();
  const r = c.rounds[c.rounds.length - 1];
  if (r.status === 'pending') {
    const via = C.launch(c, r, { ...cfg, launchModes: [c.permissionMode] });
    return console.log(`已用 ${via} 開第 ${r.k} 輪`);
  }
  if (fs.existsSync(L.roundFile(c, r.k))) return console.log(C.advance(c, cfg));
  console.log(`第 ${r.k} 輪狀態是 ${r.status}，輪次檔還沒寫（${L.roundFile(c, r.k)}）`);
}

function cancel() {
  let n = 0;
  for (const c of L.listChains()) {
    if (c.status !== 'running' || (arg !== 'all' && c.id !== arg)) continue;
    c.status = 'cancelled';
    L.saveChain(c);
    n++;
  }
  console.log(`已取消 ${n} 條迭代鏈（進行中的那一輪不受影響，只是不再接續）`);
}

function log() {
  const n = Number(arg) || 30;
  try {
    console.log(fs.readFileSync(L.LOG_FILE, 'utf8').trim().split('\n').slice(-n).join('\n'));
  } catch {
    console.log('還沒有紀錄');
  }
}

const cmds = { status, next, cancel, log };
if (cmds[cmd]) cmds[cmd]();
else console.log('用法：node cli.js [status|log [行數]|next <id>|cancel <id|all>]');
