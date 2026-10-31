// iter-chain 測試：單輪 session 用 ;;;@ 轉成鏈時，指令不能送到模型，第 1 輪要能收尾並接續
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iter-chain-test-'));
process.env.ITER_CHAIN_STATE_DIR = path.join(tmp, 'state');
process.env.ITER_CHAIN_CONFIG_JSON = JSON.stringify({ dryRun: true, launchModes: ['auto'] });
const L = require('./lib');
const HOOK = path.join(__dirname, 'hook.js');
const SECRET = '關掉護眼模式確認顏色';
let failed = 0;
let seq = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✔ ${name}`);
  } catch (e) {
    failed++;
    console.log(`✘ ${name}\n  ${e.message}`);
  }
}

function hook(input) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8', env: process.env });
  return r.stdout ? JSON.parse(r.stdout) : null;
}

// 逐字稿紀錄的形狀照實際的 jsonl
const prompt = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const say = (text) => ({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
const toolUse = () => ({ type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } });
const toolResult = () => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
const turnEnd = () => ({ type: 'system', subtype: 'turn_duration', durationMs: 1000 });
const interrupted = () => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
const noise = () => ({ type: 'last-prompt', lastPrompt: 'x' });

const WORKING = [prompt('修 bug'), toolUse(), toolResult()];
const IDLE = [prompt('修 bug'), say('修好了，改了 a.js'), turnEnd()];

// 建一個專案和單輪 session
function session(records) {
  const id = ++seq;
  const cwd = path.join(tmp, `p${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  const transcript_path = path.join(tmp, `t${id}.jsonl`);
  if (records) fs.writeFileSync(transcript_path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { session_id: `s${id}`, cwd, transcript_path, permission_mode: 'auto' };
}

const submit = (s, text) => hook({ ...s, hook_event_name: 'UserPromptSubmit', prompt: text });
const stop = (s) => hook({ ...s, hook_event_name: 'Stop' });
const chainOf = (s) => L.loadChain(L.readJson(L.sessionFile(s.session_id))?.chainId);

test('工作中打 ;;;@：擋下，模型收不到指令也沒有注入', () => {
  const s = session(WORKING);
  const r = submit(s, `;;;@ ${SECRET}`);
  assert.strictEqual(r?.decision, 'block');
  assert.strictEqual(r.hookSpecificOutput, undefined);
  assert.strictEqual(chainOf(s).rounds[0].status, 'running');
  assert.strictEqual(chainOf(s).items[0].text, SECRET);
});

test('工作中打 ;;;@：回合結束時告訴模型寫輪次檔，不透露後面的指令，只講一次', () => {
  const s = session(WORKING);
  submit(s, `;;;@ ${SECRET}`);
  const r = stop(s);
  assert.strictEqual(r?.decision, 'block');
  assert.ok(r.reason.includes(L.roundFile(chainOf(s), 1)));
  assert.ok(!r.reason.includes(SECRET));
  assert.strictEqual(stop(s), null);
});

test('工作中打 ;;;@：模型寫好輪次檔後接續第 2 輪', () => {
  const s = session(WORKING);
  submit(s, `;;;@ ${SECRET}`);
  stop(s);
  fs.writeFileSync(L.roundFile(chainOf(s), 1), '## 摘要\n- 修好了');
  const r = stop(s);
  assert.ok(r?.systemMessage.includes('第 2 輪'));
  const c = chainOf(s);
  assert.strictEqual(c.rounds[1].instruction, SECRET);
  assert.strictEqual(c.rounds[1].status, 'launched');
});

test('工作中打 ;;;@ 後第 1 輪撞限額：接手的 session 已看過規則，Stop 不再講一次', () => {
  const s = session(WORKING);
  submit(s, `;;;@ ${SECRET}`);
  const jobs = path.join(tmp, 'jobs');
  fs.mkdirSync(jobs, { recursive: true });
  fs.writeFileSync(path.join(jobs, 'j1.json'), JSON.stringify({ sid: s.session_id }));
  const s2 = { ...s, session_id: `${s.session_id}-relay` };
  process.env.LIMIT_RELAY_JOB = 'j1';
  process.env.ITER_CHAIN_RELAY_JOBS = jobs;
  const r = hook({ ...s2, hook_event_name: 'SessionStart' });
  delete process.env.LIMIT_RELAY_JOB;
  delete process.env.ITER_CHAIN_RELAY_JOBS;
  assert.ok(r.hookSpecificOutput.additionalContext.includes('round-1.md'));
  assert.strictEqual(stop(s2), null);
});

test('閒著時打 ;;;@：擋下，工具代寫輪次檔並直接開第 2 輪', () => {
  const s = session(IDLE);
  const r = submit(s, `;;;@ ${SECRET}`);
  assert.strictEqual(r?.decision, 'block');
  assert.ok(r.reason.includes('第 2 輪'));
  const c = chainOf(s);
  assert.strictEqual(c.rounds[0].status, 'done');
  assert.strictEqual(c.rounds[1].instruction, SECRET);
  assert.strictEqual(c.rounds[1].status, 'launched');
  assert.ok(fs.readFileSync(L.roundFile(c, 1), 'utf8').includes('修好了，改了 a.js'));
});

test('閒著時打 ;;;@ 看結果的輪次：第 1 輪沒寫「下一輪」，不能被當成「無」略過', () => {
  const s = session(IDLE);
  submit(s, ';;;@ ;;;?2 改善效能');
  const c = chainOf(s);
  assert.strictEqual(c.rounds[1].type, 'dyn');
  assert.ok(c.rounds[1].instruction.includes('改善效能'));
});

test('被 Esc 打斷後算閒著', () => {
  const s = session([...IDLE, prompt('再改'), toolUse(), interrupted()]);
  submit(s, `;;;@ ${SECRET}`);
  assert.strictEqual(chainOf(s).rounds[1]?.status, 'launched');
});

test('逐字稿裡沒有對話算閒著', () => {
  const s = session([noise()]);
  submit(s, `;;;@ ${SECRET}`);
  assert.strictEqual(chainOf(s).rounds[1]?.status, 'launched');
});

test('讀不到逐字稿：判斷不出來時當成工作中，不提早開下一輪', () => {
  const s = session(null);
  const r = submit(s, `;;;@ ${SECRET}`);
  assert.strictEqual(r?.decision, 'block');
  assert.strictEqual(chainOf(s).rounds.length, 1);
});

test('尾端雜項紀錄不影響判斷', () => {
  const s = session([...IDLE, noise(), noise()]);
  submit(s, `;;;@ ${SECRET}`);
  assert.strictEqual(chainOf(s).rounds[1]?.status, 'launched');
  const w = session([...WORKING, noise()]);
  submit(w, `;;;@ ${SECRET}`);
  assert.strictEqual(chainOf(w).rounds.length, 1);
});

test('逐字稿最後一行超過讀取範圍：判斷不出來時當成工作中，不提早開下一輪', () => {
  const s = session([...IDLE, prompt('再改'), { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x'.repeat(3 * 1024 * 1024) }] } }]);
  submit(s, `;;;@ ${SECRET}`);
  assert.strictEqual(chainOf(s).rounds.length, 1);
});

test('已屬於鏈的 session 打 ;;;@：照舊擋下插入，不重複提醒', () => {
  const s = session(WORKING);
  submit(s, 'A ;;; B');
  const r = submit(s, `;;;@ ${SECRET}`);
  assert.strictEqual(r?.decision, 'block');
  assert.strictEqual(chainOf(s).items.length, 2);
  assert.strictEqual(stop(s), null);
});

test('一般的 A ;;; B 照舊注入規則、不擋', () => {
  const s = session(WORKING);
  const r = submit(s, 'A ;;; B');
  assert.strictEqual(r.decision, undefined);
  assert.ok(r.hookSpecificOutput.additionalContext.includes('round-1.md'));
});

fs.rmSync(tmp, { recursive: true, force: true });
if (failed) {
  console.log(`\n${failed} 個測試失敗`);
  process.exit(1);
}
console.log('\n全部通過');
