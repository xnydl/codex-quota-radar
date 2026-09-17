#!/usr/bin/env node
// codex-quota-radar:读本机 codex 日志 sqlite 里每条 /responses 响应回的 x-codex 配额头,
// 显示 用了%/窗口/几秒后恢复/plan/是否已429。零 MITM、零 key、纯本地。
//
// 用法:
//   node radar.mjs                当前配额快照(冲顶预警)
//   node radar.mjs --watch [sec]  实时刷(默认 15s)
//   node radar.mjs --history [N]  最近 N 条 used% 时间线 + 24h 内 429 次数
//   node radar.mjs --json         机读输出(供 hook/prompt)
// 退出码:当前任一限速族 used%>=100 → 退 2(可当闸)。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const WARN = Number(process.env.CODEX_QUOTA_WARN || 80);   // 黄
const DB = pickDb();

function pickDb() {
  if (process.env.CODEX_LOGS_DB) return process.env.CODEX_LOGS_DB;
  const dir = path.join(HOME, '.codex');
  let cands = [];
  try { cands = fs.readdirSync(dir).filter((f) => /^logs.*\.sqlite$/.test(f)); } catch {}
  if (!cands.length) { console.error(`找不到 codex 日志 sqlite(~/.codex/logs*.sqlite)。设 CODEX_LOGS_DB 指定。`); process.exit(1); }
  // 选最新修改的
  cands.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  return path.join(dir, cands[0]);
}

function q(sql) {
  const out = execFileSync('/usr/bin/sqlite3', ['-readonly', '-json', DB, sql], { maxBuffer: 64 * 1024 * 1024 });
  const s = out.toString('utf8').trim();
  return s ? JSON.parse(s) : [];
}

// 从日志行抽所有 x-codex-* 头 → map
function parseHeaders(body) {
  const m = {};
  const re = /"(x-codex-[a-z0-9-]+)":\s*"([^"]*)"/g;
  let g;
  while ((g = re.exec(body))) m[g[1]] = g[2];
  return m;
}

function humanMin(min) {
  min = Number(min);
  if (!min) return `${min}m`;
  if (min % 10080 === 0) return `${min / 10080}w`;
  if (min % 1440 === 0) return `${min / 1440}d`;
  if (min % 60 === 0) return `${min / 60}h`;
  return `${min}m`;
}
function humanSec(sec) {
  sec = Number(sec);
  if (!sec) return '0s';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), mi = Math.floor((sec % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, mi && `${mi}m`].filter(Boolean).join('') || `${sec}s`;
}
function atLocal(epoch) {
  epoch = Number(epoch);
  if (!epoch) return '-';
  return new Date(epoch * 1000).toLocaleString();
}

// 从 header map 归出限速族
function families(h) {
  const stems = Object.keys(h)
    .filter((k) => k.endsWith('-used-percent'))
    .map((k) => k.replace('-used-percent', ''));
  return stems.map((stem) => {
    const label = stem.replace('x-codex-', '');
    const used = Number(h[`${stem}-used-percent`] ?? -1);
    return {
      label,
      used,
      window: humanMin(h[`${stem}-window-minutes`]),
      resetAfter: humanSec(h[`${stem}-reset-after-seconds`]),
      resetAt: atLocal(h[`${stem}-reset-at`]),
    };
  }).filter((f) => f.used >= 0 && !f.label.includes('over-secondary'));
}

function latestResponse() {
  const rows = q(`SELECT ts, feedback_log_body AS b FROM logs
    WHERE feedback_log_body LIKE '%backend-api/codex/responses%'
      AND feedback_log_body LIKE '%x-codex-primary-used-percent%'
    ORDER BY id DESC LIMIT 1;`);
  return rows[0] || null;
}
function last429() {
  const rows = q(`SELECT ts FROM logs
    WHERE feedback_log_body LIKE '%backend-api/codex/responses%status=429%'
    ORDER BY id DESC LIMIT 1;`);
  return rows[0]?.ts || null;
}
function count429(sinceSec) {
  const rows = q(`SELECT count(*) AS n FROM logs
    WHERE feedback_log_body LIKE '%backend-api/codex/responses%status=429%' AND ts > ${sinceSec};`);
  return rows[0]?.n || 0;
}

function snapshot() {
  const r = latestResponse();
  if (!r) { console.error('日志里还没有带配额头的 /responses 记录。先用 codex 发一条。'); process.exit(1); }
  const h = parseHeaders(r.b);
  const fams = families(h);
  const worst = Math.max(...fams.map((f) => f.used), 0);
  return { ts: r.ts, plan: h['x-codex-plan-type'], activeLimit: h['x-codex-active-limit'],
    creditsUnlimited: h['x-codex-credits-has-credits'], creditsBalance: h['x-codex-credits-balance'],
    fams, worst };
}

function colorUsed(u) {
  const s = `${u}%`;
  if (u >= 100) return `\x1b[41m\x1b[97m ${s} \x1b[0m`;   // 红底
  if (u >= WARN) return `\x1b[33m${s}\x1b[0m`;             // 黄
  return `\x1b[32m${s}\x1b[0m`;                            // 绿
}

function render(snap) {
  const age = Math.round(Date.now() / 1000 - snap.ts);
  console.log(`\x1b[1mcodex 配额雷达\x1b[0m  plan=${snap.plan} tier=${snap.activeLimit}  数据 ${age}s 前`);
  console.log(`db: ${DB}`);
  console.log('─'.repeat(72));
  console.log('限速族'.padEnd(26) + '用了'.padEnd(16) + '窗口'.padEnd(8) + '恢复剩余'.padEnd(12) + '恢复时刻');
  for (const f of snap.fams.sort((a, b) => b.used - a.used)) {
    console.log(
      f.label.padEnd(24) + '  ' +
      colorUsed(f.used).padEnd(24) +
      f.window.padEnd(8) +
      f.resetAfter.padEnd(12) +
      f.resetAt,
    );
  }
  console.log('─'.repeat(72));
  const l429 = last429();
  if (l429) {
    const ago = Math.round(Date.now() / 1000 - l429);
    console.log(`最近 429: ${new Date(l429 * 1000).toLocaleString()}(${humanSec(ago)}前) | 24h 内 429 次数: ${count429(Math.round(Date.now() / 1000 - 86400))}`);
  } else {
    console.log('最近 429: 无记录');
  }
  if (snap.worst >= 100) console.log('\x1b[41m\x1b[97m 已限速!等上表最近的「恢复时刻」,或切账号。 \x1b[0m');
  else if (snap.worst >= WARN) console.log(`\x1b[33m 逼近上限(${snap.worst}%)。省着用或准备切号。\x1b[0m`);
  else console.log(`\x1b[32m 余量健康(峰值 ${snap.worst}%)。\x1b[0m`);
}

function history(n) {
  const rows = q(`SELECT ts, feedback_log_body AS b FROM logs
    WHERE feedback_log_body LIKE '%backend-api/codex/responses%x-codex-primary-used-percent%'
    ORDER BY id DESC LIMIT ${n};`);
  console.log(`时间`.padEnd(22) + 'status'.padEnd(8) + 'primary%'.padEnd(10) + '5h/bengalfox%');
  for (const r of rows.reverse()) {
    const h = parseHeaders(r.b);
    const st = (r.b.match(/status=(\d+)/) || [])[1] || '?';
    const prim = h['x-codex-primary-used-percent'] ?? '-';
    const beng = h['x-codex-bengalfox-primary-used-percent'] ?? '-';
    console.log(new Date(r.ts * 1000).toLocaleString().padEnd(22) + String(st).padEnd(8) + `${prim}%`.padEnd(10) + `${beng}%`);
  }
  console.log(`\n24h 内 429 次数: ${count429(Math.round(Date.now() / 1000 - 86400))}`);
}

// ---- main ----
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valAfter = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[i + 1] : d; };

if (has('--json')) {
  const snap = snapshot();
  console.log(JSON.stringify({ ...snap, last429: last429(), count429_24h: count429(Math.round(Date.now() / 1000 - 86400)) }, null, 2));
  process.exit(snap.worst >= 100 ? 2 : 0);
} else if (has('--history')) {
  history(Number(valAfter('--history', 12)));
} else if (has('--watch')) {
  const sec = Number(valAfter('--watch', 15));
  const loop = () => { process.stdout.write('\x1b[2J\x1b[H'); try { render(snapshot()); } catch (e) { console.error(e.message); } };
  loop(); setInterval(loop, sec * 1000);
} else {
  const snap = snapshot();
  render(snap);
  process.exit(snap.worst >= 100 ? 2 : 0);
}
