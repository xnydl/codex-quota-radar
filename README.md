# codex-quota-radar

看 **Codex** 到底还剩多少配额、几秒后恢复、是不是被限速了 —— 修「codex 降智 / 变笨 / 像小模型、429 / Too Many Requests、overload 排队、突然不干活」的排查与预警。

纯本地:读本机 codex 日志 sqlite 里每条响应回的 `x-codex-*` 配额头。**零抓包、零 API key、零 CA、零住宅 IP。**

> 顺带证伪了网传的「HTTP 292 调度令牌保智」—— 官方 ChatGPT 登录态 Codex 日志里 `status=292` 为 **0**,实打请求也没有;博客说的 `current_turn_state` 不存在。真正的 `x-codex-turn-state` 只是同一轮 sticky routing,下一轮就清空,不是 1 小时保智凭据。降智/限速的真相是配额头。详见 [SKILL.md](SKILL.md)。

## 它读什么

codex 每条 `/responses` 响应都回一批配额头,codex 自带的 Rust tracing 把它落进 `~/.codex/logs*.sqlite`(表 `logs`)。本工具只读这些行,不发任何请求:

- `x-codex-primary-used-percent`(周窗)、`x-codex-bengalfox-primary-*`(5h 滚动窗)、`secondary` 族、`credits` 族
- `x-codex-*-reset-after-seconds` / `-reset-at`(何时恢复)、`x-codex-plan-type` / `x-codex-active-limit`

**429 恰好发生在某族 `used-percent` 冲到 100 的那一刻。**

## 依赖

- macOS / Linux
- `node` >= 18
- `sqlite3`(macOS 自带 `/usr/bin/sqlite3`)
- 用过 ChatGPT 登录态的 **Codex**(`~/.codex/logs*.sqlite` 存在)

## 用法

```bash
node scripts/radar.mjs              # 配额快照 + 冲顶预警(峰值≥100 退出码 2)
node scripts/radar.mjs --watch 15  # 每 15s 实时刷
node scripts/radar.mjs --history 12 # 最近 12 条 used% 时间线 + 24h 内 429 次数
node scripts/radar.mjs --json       # 机读(供 hook/prompt;限速中退 2)
```

环境变量:

- `CODEX_QUOTA_WARN`(默认 `80`)—— ≥80% 黄、≥100% 红。
- `CODEX_LOGS_DB` —— 覆盖自动选库(默认取 `~/.codex/logs*.sqlite` 最新的)。

## 快照示例

```
codex 配额雷达  plan=pro tier=premium  数据 56s 前
限速族                用了     窗口   恢复剩余   恢复时刻
primary              69%      1w    2d6h8m    9/19 21:33
bengalfox-primary    0%       5h    5h        9/17 20:24
最近 429: 9/9 15:50(8d前) | 24h 内 429 次数: 0
 余量健康(峰值 69%)。
```

> **数据 N 前**:雷达读的是「最近一条 codex 响应」的头。久没用 codex,数字就旧;想要最新先随便发一条 codex(工具不主动打 API,不烧你配额)。

## 装成 Claude Code / Codex skill

克隆后软链进 skills 目录即可被 skill 系统发现:

```bash
git clone https://github.com/xnydl/codex-quota-radar.git
ln -s "$(pwd)/codex-quota-radar" ~/.claude/skills/codex-quota-radar
```

之后对 Claude Code 说「用 codex-quota-radar」或「codex 还剩多少配额」触发。

## 被限速了怎么办

1. **等** —— 看红的那族 `-reset-at`,到点自动恢复(5h 窗快、周窗慢)。
2. **切账号** —— codex 是 ChatGPT 登录态,换个已登录账号即换一套配额。
3. **省配额** —— 降 `~/.codex/config.toml` 的 `model_reasoning_effort`、少开并行会话。

## 边界

- **多账号对比做不到**:一份 codex 安装的 sqlite 只记当前登录态用量,不带 account_id 维度。
- **头字段是 OpenAI 私有约定**,它改名/改窗口就要跟着调 `scripts/radar.mjs` 里 `x-codex-` 那条正则。

## License

MIT
