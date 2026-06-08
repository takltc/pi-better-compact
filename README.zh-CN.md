# pi DP-Based Compaction Extension

[English Documentation](./README.md)

参考 [bash-agent 动态压缩决策](https://github.com/lloydzhou/bash-agent/wiki/%E5%8A%A8%E6%80%81%E5%8E%8B%E7%BC%A9%E5%86%B3%E7%AD%96%EF%BC%9A%E4%BD%95%E6%97%B6%E5%8E%8B%E7%BC%A9%EF%BC%9F%E4%BF%9D%E7%95%99%E5%A4%9A%E5%B0%91%EF%BC%9F) 实现的 pi 插件，用缓存感知的 DP 经济模型替代原有的固定阈值 compact。

## 核心思想

原有 pi 的 compact 策略：
- 当 `contextTokens > contextWindow - reserveTokens` 时触发压缩
- 固定保留最近 `keepRecentTokens` 的消息

本扩展的 DP 策略：
- 枚举候选保留量 k（保留最近多少条消息）
- 对每个 k 计算五项净收益：
  1. **后续节省**：压缩后后续请求少携带旧历史 token 的缓存价节省
  2. **缓存失效**：新摘要前缀导致的一次性缓存失效成本
  3. **压缩请求成本**：summary call 本身的输入/输出成本
  4. **信息失真惩罚**：摘要丢失细节带来的信息损失
  5. **质量改善收益**：缩短长上下文带来的质量提升
- 只有最优净收益 > 0 时才压缩
- 切点对齐到 user message 边界，避免从 assistant/tool 片段中间截断

## 安装

### 通过 `pi install` 安装（推荐）

全局安装（所有会话可用）：

```bash
pi install git:github.com/takltc/pi-better-compact
```

或仅在当前项目本地安装：

```bash
pi install -l git:github.com/takltc/pi-better-compact
```

### 手动安装

1. 复制扩展文件到 pi 扩展目录：

```bash
mkdir -p ~/.pi/agent/extensions
cp src/dp-compact.ts ~/.pi/agent/extensions/
```

### 禁用内置自动压缩

安装完成后，禁用 pi 内置 auto-compact（在 `~/.pi/agent/settings.json` 或项目 `.pi/settings.json`）：

```json
{
  "compaction": {
    "enabled": false,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

然后启动 pi，扩展会自动加载。

## 使用

- **自动触发**：扩展在每次 `agent_end` 后检查上下文使用量。当超过 `CHECK_THRESHOLD`（默认 60%）时，自动触发 compact，但 `session_before_compact` 中的 DP 模型会决定是否真正执行。
- **手动触发**：仍然可以用 `/compact [instructions]` 手动触发。
- **查看状态**：`/dp-status` 显示当前 DP 参数和会话统计。
- **评估决策**：`/dp-eval` 立即运行 DP 评估，显示是否值得压缩及最优保留量。

## 参数调优

通过环境变量调整 DP 参数：

| 环境变量 | 默认值 | 说明 |
|---------|-------|------|
| `DP_P_INPUT` | 3.0 | 未命中缓存的输入价格 ($/MTok) |
| `DP_P_CACHE` | 0.3 | 命中缓存的输入价格 ($/MTok) |
| `DP_P_OUT` | 15.0 | 输出价格 ($/MTok) |
| `DP_V` | 5000 | 固定前缀 token（system prompt、tools 等） |
| `DP_S` | 500 | 预计 summary 输出 token |
| `DP_BASELINE_E` | 8 | 预计剩余用户输入轮数基准 |
| `DP_E_FIXED` | 0 | 固定 E（>0 时跳过动态估算） |
| `DP_R` | 0.8 | 单次摘要信息保留率 |
| `DP_BETA` | 0.03 | 信息失真惩罚系数 |
| `DP_QUALITY_PENALTY` | 0.2 | 长上下文质量衰减惩罚系数 |
| `DP_MIN_KEEP_RATIO` | 0.12 | 最少保留消息行比例 |
| `DP_FORCE_THRESHOLD` | 0.9 | 强制压缩阈值（context 使用率超过此值） |
| `DP_CHECK_THRESHOLD` | 0.6 | 自动检查阈值（context 使用率超过此值时检查） |

示例：

```bash
export DP_P_INPUT=2.0
export DP_P_CACHE=0.2
export DP_FORCE_THRESHOLD=0.85
pi
```

## 文件结构

```
src/
└── dp-compact.ts    # 扩展主文件
```
