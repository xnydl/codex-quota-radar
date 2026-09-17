---
name: codex-quota-radar
description: 看 Codex 到底还剩多少配额、几秒后恢复、是不是被限速了 —— 修「codex 降智/变笨/像小模型、429/Too Many Requests、overload 排队、突然不干活」的排查与预警。读本机 codex 日志 sqlite 里每条响应回的 x-codex 配额头,零抓包、零 key、纯本地。触发词:codex 降智、codex 变笨、codex 429、codex 限速、codex overload、codex 配额、还能用多少、几点恢复、quota、rate limit、给 codex 挂个配额雷达。含快照/实时刷/历史时间线/机读闸。
---

# codex-quota-radar —— Codex 配额雷达

## 结论先行(本机日志实测,不是博客转述)

在 **ChatGPT 登录态 codex**(端点 `chatgpt.com/backend-api/codex/responses`)里:

- **不存在 292 调度令牌**。日志里 `status=292` 出现 **0** 次;/responses 只有 200 / 429。网传「292 采集+注入跨 IP 保智」在这里**打不动**。
- 「降智 / 限速 / overload」的**真实机制是普通配额限速**,而且 codex **每条响应都把配额状态写在响应头里**,并落进本机 sqlite。读它即可,不用抓包、不用装 CA、不用住宅 IP。

## 真实的配额头(每条 /responses 响应回)

| 头 | 含义 |
|---|---|
| `x-codex-plan-type` | 套餐(pro/…) |
| `x-codex-active-limit` | 当前档(premium/…) |
| `x-codex-primary-used-percent` | **主限速**用了百分之几(窗口 `-window-minutes`,实测 10080=**周**) |
| `x-codex-primary-reset-after-seconds` / `-reset-at` | 主限速多久 / 何时恢复 |
| `x-codex-secondary-*` | 次限速族(同结构) |
| `x-codex-bengalfox-primary-*` | 另一族,窗口 300=**5 小时**滚动 |
| `x-codex-bengalfox-secondary-*` | 窗口 10080=周 |
| `x-codex-credits-has-credits` / `-balance` / `-unlimited` | 额度信用 |

**429 恰好发生在某个族 `used-percent` 冲到 100 的那一刻。** 谁先到 100 谁先限你 —— 通常是 5h 滚动窗(bengalfox-primary)或周窗(primary)。

`x-codex-turn-state`(值 `gAAAAAB…` 是 Fernet 加密 blob)是**服务端会话态**,只在响应里出现、请求侧从不回传,不是可搬运的凭据 —— 别碰它。

## 用法

```bash
node scripts/radar.mjs              # 配额快照 + 冲顶预警(峰值≥100 退出码 2)
node scripts/radar.mjs --watch 15  # 每 15s 实时刷
node scripts/radar.mjs --history 12 # 最近 12 条 used% 时间线 + 24h 内 429 次数
node scripts/radar.mjs --json       # 机读(供 hook/prompt;限速中退 2)
```

阈值:`CODEX_QUOTA_WARN=80`(默认,≥80% 黄、≥100% 红)。db 自动选 `~/.codex/logs*.sqlite` 最新的,可用 `CODEX_LOGS_DB` 覆盖。

## 快照读法

```
codex 配额雷达  plan=pro tier=premium  数据 56s 前
限速族                用了     窗口   恢复剩余   恢复时刻
primary              69%      1w    2d6h8m    9/19 21:33
bengalfox-primary    0%       5h    5h        9/17 20:24
最近 429: 9/9 15:50(8d前) | 24h 内 429 次数: 0
 余量健康(峰值 69%)。
```

- **数据 N 前**:雷达读的是「最近一条 codex 响应」的头 —— 你久没用 codex,数字就旧。想要最新,先随便发一条 codex。
- **红了(某族=100%)**:就是被限了。等那族「恢复时刻」,或切账号(见下),或降 `model_reasoning_effort`/换更省的模型少烧配额。

## 被限速了怎么办(真实可行的腿)

1. **等**:看红的那族 `-reset-at`,到点自动恢复。5h 窗恢复快、周窗慢。
2. **切账号**:codex 是 ChatGPT 登录态(`~/.codex/auth.json` 的 `account_id`+token),换个已登录账号即换一套配额。切号在 codex/ChatGPT app 侧做,本 skill 不碰你的登录态。
3. **省配额**:`~/.codex/config.toml` 降 `model_reasoning_effort`(high→medium→low)、少开并行会话。

## 当闸用(可选)

重活前先探配额,满了就别派:

```bash
node scripts/radar.mjs --json >/dev/null || echo "codex 已限速,缓一缓"
# 退出码 2 = 当前某族 used%>=100
```

## 边界(诚实说)

- **多账号对比做不到**:一份 codex 安装的 sqlite 只记当前登录态的用量,不带 account_id 维度。雷达反映的是「最近那条响应对应的账号」。
- **实时性 = 最近一次 codex 请求**:雷达不主动打 API(不烧你配额),只读已落库的响应头。要最新数就先用一下 codex。
- **头字段是 OpenAI 私有约定**,它改名/改窗口本 skill 就要跟着调正则(`scripts/radar.mjs` 里 `x-codex-` 那条)。
