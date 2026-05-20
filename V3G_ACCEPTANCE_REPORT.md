# V3-γ 数据驱动化 + caching 验收报告 (2026-05-19 12:53)

**测试 subagent**: a766fb22cfc50d0af
**Token**: 3/3 chat 预算（3 次 primeSummary 自动）
**Console**: 0 errors, 1 warn（正是验证 #4 故意触发的预期 warn）

---

## 总分 **13 / 13 PASS** 🎉

| 组 | 通过 | 关键证据 |
|---|---|---|
| P0 toolbar 动态化 | 3/3 | 默认 6 btn / 自定义 4 色 4 btn / 切主题刷新 |
| P0 createAnnotation 校验 | 2/2 | 越界 color reject + warn |
| P0 migration v3 | 2/2 | default.pdfKeys 补好 + migrationVersion=3 |
| P0 reader topic dot | 1/1 | 颜色按 palette[0].color |
| P0 **caching 验证** | 3/3 | **跨 PDF 同主题 hash 完全一致** |
| P2 无回归 | 2/2 | CardMenu hidden + Step 2 PRESET_COLORS |

---

## 🎯 caching 关键数据（**产品价值核心证据**）

| 场景 | role | len | hash | topic |
|---|---|---|---|---|
| 默认主题 PDF1 (Clio) | system | 70 | `18288ccf` | default |
| 默认主题 PDF2 (Transformer) | system | 70 | `18288ccf` ⭐ | default |
| 自定义主题 PDF (Clio) | system | 54 | `277aa062` | 7c47e7c0-... |

⭐ **跨 PDF 同主题 hash 完全一致** = paletteRules 前缀字节稳定 = 跨论文 prompt cache 命中前置条件 ✅
跨主题 hash 不同 = "改 palette = cache 失效"设计成立 ✅

---

## 关键代码位置（v3-γ 改动 130 行）

- `app.js:739-801` migration v3 入口 + migratePdfKeysToDefault
- `app.js:939-962` renderColorPalette 动态化
- `app.js:1021-1055` createAnnotation palette 校验
- `app.js:1242-1261` caching debug log djb2 hash
- `app.js:1603-1614` PRESET_COLORS 10 色池
- `app.js:1870-1888` updateReaderTopicHint dot color
- `app.js:2140-2146` Step 2 新行 PRESET_COLORS 循环
- `style.css:618` `.card-menu[hidden]{display:none!important}`（P0 hidden bug 主 Claude 修）

---

## test 给主 Claude 的建议

1. **可派 v3-δ**，13/13 全过
2. caching debug log 默认开启，鸭鸭可在 console 自查命中；保留 `__coreadCachingDebug=false` 开关可关
3. **未来端到端 cache 验证**：当前 hash 仅前端 paletteRules 字节稳定；server.py 的 `SYSTEM_PROMPT + pdf_text` 整体字节稳定性 v3-δ 可考虑加 server 端 log（不是必须）
