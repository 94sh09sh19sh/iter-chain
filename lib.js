// iter-chain 共用函式：路徑、設定、狀態檔、記錄、指令解析、開新分頁
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = __dirname;
// ITER_CHAIN_STATE_DIR 只給測試用，避免弄髒正式狀態
const STATE = process.env.ITER_CHAIN_STATE_DIR || path.join(ROOT, 'state');
const DIRS = {
  chains: path.join(STATE, 'chains'),
  sessions: path.join(STATE, 'sessions'),
  debug: path.join(STATE, 'debug'),
};
const LOG_FILE = path.join(STATE, 'chain.log');
const RELAY_JOBS = process.env.ITER_CHAIN_RELAY_JOBS || path.join(os.homedir(), '.claude', 'limit-relay', 'state', 'jobs');

const DEFAULT_CONFIG = {
  enabled: true,
  delimiter: ';;;',
  defaultDynamicMax: 1,
  maxRounds: 20,
  summaryMaxChars: 1500,
  launchModes: ['auto'],
  terminal: 'wt',
  dryRun: false,
  debug: false,
};

function ensureDirs() {
  for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return fallback;
  }
}

// 先寫暫存檔再改名，避免多個 hook 同時寫入時讀到半個檔案
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function loadConfig() {
  // ITER_CHAIN_CONFIG_JSON 只給測試用，可以臨時覆寫設定
  let env = {};
  try {
    env = JSON.parse(process.env.ITER_CHAIN_CONFIG_JSON || '{}');
  } catch {}
  // config.json 是 repo 的預設值；config.local.json 是本機個人設定，部署不會覆蓋
  return { ...DEFAULT_CONFIG, ...readJson(path.join(ROOT, 'config.json'), {}), ...readJson(path.join(ROOT, 'config.local.json'), {}), ...env };
}

function log(msg) {
  try {
    ensureDirs();
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

const chainFile = (id) => path.join(DIRS.chains, `${id}.json`);
const sessionFile = (sid) => path.join(DIRS.sessions, `${sid}.json`);
const loadChain = (id) => (id ? readJson(chainFile(id)) : null);

function saveChain(chain) {
  chain.updatedAt = Date.now();
  writeJson(chainFile(chain.id), chain);
}

function listChains() {
  try {
    return fs.readdirSync(DIRS.chains).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(DIRS.chains, f))).filter(Boolean);
  } catch {
    return [];
  }
}

const roundFile = (chain, k) => path.join(chain.dir, `round-${k}.md`);

// dir 是 base 本身或它底下的資料夾；Windows 不分大小寫
function isInside(dir, base) {
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const rel = path.relative(norm(base), norm(dir));
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

// 把「A ;;; B ;;;?3 方向 ;;;*2」拆成第 1 輪和之後排定的各輪；沒有分隔字串就回傳 null
//   ;;;      下一段是固定指令
//   ;;;?N    接下來最多 N 輪看上一輪結果決定，後面的文字是方向（可省略）
//   ;;;*N    把後面的文字（省略時用上一段）再做 N 輪
function parsePrompt(prompt, cfg) {
  const esc = cfg.delimiter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${esc}(?:([?*])(\\d*))?`, 'g');
  const parts = [];
  let last = 0;
  let mark = null;
  let m;
  while ((m = re.exec(prompt))) {
    parts.push({ mark, text: prompt.slice(last, m.index).trim() });
    mark = { kind: m[1] || '', n: m[2] ? Number(m[2]) : 0 };
    last = re.lastIndex;
  }
  if (!parts.length || !parts[0].text) return null;
  parts.push({ mark, text: prompt.slice(last).trim() });

  const items = [];
  let lastFixed = parts[0].text;
  let group = 0;
  for (const { mark: mk, text } of parts.slice(1)) {
    if (mk.kind === '?') {
      group++;
      for (let i = 0; i < (mk.n || cfg.defaultDynamicMax); i++) items.push({ type: 'dyn', group, guide: text });
    } else if (mk.kind === '*') {
      const t = text || lastFixed;
      for (let i = 0; i < (mk.n || 1); i++) items.push({ type: 'fixed', text: t });
      lastFixed = t;
    } else if (text) {
      items.push({ type: 'fixed', text });
      lastFixed = text;
    }
  }
  if (!items.length) return null;
  return { first: parts[0].text, items: items.slice(0, cfg.maxRounds - 1) };
}

// 中途插入的輪次：前面補一段佔位再用 parsePrompt 拆，所以也能用 ;;;? ;;;* 排多輪
function parseItems(text, cfg) {
  return parsePrompt(`_ ${cfg.delimiter} ${text}`, { ...cfg, maxRounds: Infinity })?.items || null;
}

// 開頭就是分隔字串的訊息是改鏈指令（parsePrompt 不會把它當成新鏈）：
//   ;;;          列出各輪
//   ;;;+ 文字    補充指令，之後每輪都看得到
//   ;;;- 3 5-7   刪除未執行的輪次
//   ;;;@3 指令   插入成第 3 輪，原本的往後移；不寫數字就加在最後（不屬於鏈的 session 會轉成鏈的第 1 輪）
function parseEdit(prompt, cfg) {
  const p = String(prompt).trim();
  if (!p.startsWith(cfg.delimiter)) return null;
  const rest = p.slice(cfg.delimiter.length).trim();
  if (!rest) return { op: 'show' };
  if (!/^[+\-@]/.test(rest)) return null;
  let m;
  if ((m = rest.match(/^\+\s*([\s\S]+)$/))) return { op: 'note', text: m[1].trim() };
  if ((m = rest.match(/^-\s*([\d\s,、~-]+)$/))) {
    const ks = [];
    for (const t of m[1].split(/[\s,、]+/).filter(Boolean)) {
      const r = t.match(/^(\d+)(?:[-~](\d+))?$/);
      if (!r) return { op: 'usage' };
      for (let k = Number(r[1]); k <= Number(r[2] || r[1]); k++) ks.push(k);
    }
    return ks.length ? { op: 'drop', ks } : { op: 'usage' };
  }
  if ((m = rest.match(/^@(\d*)\s*([\s\S]+)$/))) {
    const items = parseItems(m[2].trim(), cfg);
    return items ? { op: 'insert', k: m[1] ? Number(m[1]) : null, items } : { op: 'usage' };
  }
  return { op: 'usage' };
}

// 從輪次檔取出某個「## 標題」底下的內容
function section(text, title) {
  const m = String(text).match(new RegExp(`^##\\s*${title}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'm'));
  return m ? m[1].trim() : '';
}

const isNone = (t) => !t || /^(無|沒有|none)[。.]?$/i.test(t.trim());

// 專案底下的 .iter-chain 放輪次檔；git 專案寫進 .git/info/exclude，不會被提交
function prepareDir(cwd, id) {
  const dir = path.join(cwd, '.iter-chain', id);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const ex = path.join(cwd, '.git', 'info', 'exclude');
    if (fs.existsSync(path.dirname(ex))) {
      const cur = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : '';
      if (!cur.split(/\r?\n/).includes('.iter-chain/')) fs.appendFileSync(ex, `${cur && !cur.endsWith('\n') ? '\n' : ''}.iter-chain/\n`);
    }
  } catch {}
  return dir;
}

// WindowsApps 底下的 wt.exe 是應用程式別名，existsSync 會回 false，要用 lstat 判斷
function isAlias(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

// 開新的終端機分頁執行 launch.js；dryRun 時只記錄不開
function openTab(chain, k, cfg) {
  const args = [path.join(ROOT, 'launch.js'), chain.id, String(k)];
  if (cfg.dryRun) {
    log(`[${chain.id}] [dryRun] 第 ${k} 輪：node ${args.join(' ')}`);
    return 'dryRun';
  }
  const title = `iter ${k} ${path.basename(chain.cwd)}`;
  const wt = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'wt.exe');
  if (cfg.terminal === 'wt' && isAlias(wt)) {
    spawn(wt, ['-w', '0', 'new-tab', '--title', title, '-d', chain.cwd, process.execPath, ...args], { detached: true, stdio: 'ignore' }).unref();
    return 'wt';
  }
  // 沒有 Windows Terminal 時改開一般的 cmd 視窗
  const q = (x) => `"${x}"`;
  const cmdline = `/c start ${q(title)} /d ${q(chain.cwd)} ${q(process.execPath)} ${args.map(q).join(' ')}`;
  spawn('cmd.exe', [cmdline], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true, windowsHide: true }).unref();
  return 'cmd';
}

module.exports = {
  ROOT, STATE, DIRS, LOG_FILE, RELAY_JOBS, DEFAULT_CONFIG,
  ensureDirs, readJson, writeJson, loadConfig, log, readStdin,
  chainFile, sessionFile, loadChain, saveChain, listChains, roundFile, isInside,
  parsePrompt, parseItems, parseEdit, section, isNone, prepareDir, openTab,
};
