# pi DP-Based Compaction Extension

[中文文档](./README.zh-CN.md)

A pi extension that replaces the default compaction strategy with a **cache-aware dynamic programming (DP) economic model**, inspired by the [bash-agent compaction decision algorithm](https://github.com/lloydzhou/bash-agent/wiki/%E5%8A%A8%E6%80%81%E5%8E%8B%E7%BC%A9%E5%86%B3%E7%AD%96%EF%BC%9A%E4%BD%95%E6%97%B6%E5%8E%8B%E7%BC%A9%EF%BC%9F%E4%BF%9D%E7%95%99%E5%A4%9A%E5%B0%91%EF%BC%9F).

## Core Idea

**Default pi compaction strategy:**
- Triggers when `contextTokens > contextWindow - reserveTokens`
- Keeps a fixed amount of recent messages (`keepRecentTokens`)

**This extension's DP strategy:**
- Enumerates candidate keep-counts *k* (how many recent messages to retain)
- For each *k*, computes a **5-term net benefit**:
  1. **Future savings**: Cache cost saved by not carrying old history in subsequent requests
  2. **Cache invalidation**: One-time cost of cache miss due to the new summary prefix
  3. **Compression request cost**: Input/output cost of the summary LLM call itself
  4. **Information distortion penalty**: Loss of detail from summarization
  5. **Quality improvement benefit**: Better output quality from shorter context
- Only compacts if the best net benefit is **> 0**
- Cut points align to **user message boundaries**, never splitting an assistant/tool turn

## Installation

### Via npm (Recommended)

Install from the npm registry (available in all sessions):

```bash
pi install npm:pi-better-compact
```

Or install locally in the current project only:

```bash
pi install -l npm:pi-better-compact
```

### Via Git

Install directly from GitHub:

```bash
pi install git:github.com/takltc/pi-better-compact
```

Or locally:

```bash
pi install -l git:github.com/takltc/pi-better-compact
```

### Manual Install

1. Copy the extension file to pi's extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions
cp src/dp-compact.ts ~/.pi/agent/extensions/
```

### Disable Built-in Auto-Compact

After installing, disable pi's built-in auto-compact (in `~/.pi/agent/settings.json` or project `.pi/settings.json`):

```json
{
  "compaction": {
    "enabled": false,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

Then launch pi — the extension loads automatically.

## Usage

- **Auto-trigger**: After each `agent_end`, the extension checks context usage. When it crosses `CHECK_THRESHOLD` (default 60%), it triggers compaction, but the DP model inside `session_before_compact` decides whether to actually execute.
- **Manual trigger**: You can still use `/compact [instructions]` manually.
- **Check status**: `/dp-status` shows current DP parameters and session statistics.
- **Evaluate decision**: `/dp-eval` runs the DP evaluation immediately, showing whether compaction is worthwhile and the optimal keep count.

## Parameter Tuning

Adjust DP parameters via environment variables:

| Environment Variable | Default | Description |
|----------------------|---------|-------------|
| `DP_P_INPUT` | 3.0 | Uncached input price ($/MTok) |
| `DP_P_CACHE` | 0.3 | Cached input price ($/MTok) |
| `DP_P_OUT` | 15.0 | Output price ($/MTok) |
| `DP_V` | 5000 | Fixed prefix tokens (system prompt, tools, etc.) |
| `DP_S` | 500 | Estimated summary output tokens |
| `DP_L` | 0 | Requests per turn used to estimate future requests (auto-estimated when 0) |
| `DP_BASELINE_E` | 8 | Baseline for estimated remaining user turns |
| `DP_E_FIXED` | 0 | Fixed E (skips dynamic estimation when > 0) |
| `DP_R` | 0.8 | Single-summary information retention rate |
| `DP_BETA` | 0.03 | Information distortion penalty coefficient |
| `DP_QUALITY_PENALTY` | 0.2 | Long-context quality decay penalty coefficient |
| `DP_MIN_KEEP_RATIO` | 0.12 | Minimum keep ratio for candidate messages |
| `DP_FORCE_THRESHOLD` | 0.9 | Force compaction when context usage exceeds this |
| `DP_CHECK_THRESHOLD` | 0.6 | Auto-check threshold — evaluate DP when usage exceeds this |

Example:

```bash
export DP_P_INPUT=2.0
export DP_P_CACHE=0.2
export DP_FORCE_THRESHOLD=0.85
pi
```

## File Structure

```
src/
└── dp-compact.ts    # Main extension file
```
