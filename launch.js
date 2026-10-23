// 在新的終端機分頁裡啟動 Claude Code，並用環境變數告訴 SessionStart hook 這是哪條鏈的第幾輪
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const L = require('./lib');

const PROMPT = '請執行 SessionStart 注入的 iter-chain 本輪指令。';

function findClaude() {
  const names = ['claude.exe', 'claude.cmd', 'claude'];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const n of names) {
      const p = path.join(dir, n);
      if (fs.existsSync(p)) return p;
    }
  }
  return path.join(require('os').homedir(), '.local', 'bin', 'claude.exe');
}

const [id, k] = process.argv.slice(2);
const chain = L.loadChain(id);
if (!chain) {
  console.error(`iter-chain：找不到迭代鏈 ${id}`);
  process.exit(1);
}

const exe = findClaude();
const args = chain.permissionMode && chain.permissionMode !== 'default' ? ['--permission-mode', chain.permissionMode, PROMPT] : [PROMPT];
console.log(`iter-chain：迭代鏈 ${id} 第 ${k} 輪（${chain.cwd}）\n`);
// 不讓 limit-relay 的接手標記和上層 session 的環境變數傳下去
const env = { ...process.env, ITER_CHAIN_JOB: `${id}:${k}` };
delete env.LIMIT_RELAY_JOB;
delete env.CLAUDECODE;
const child = spawn(exe, args, { cwd: chain.cwd, stdio: 'inherit', shell: exe.endsWith('.cmd'), env });
child.on('error', (e) => {
  L.log(`[${id}] 第 ${k} 輪啟動 claude 失敗：${e.message}`);
  console.error(`啟動 claude 失敗：${e.message}`);
});
child.on('exit', (code) => process.exit(code ?? 0));
