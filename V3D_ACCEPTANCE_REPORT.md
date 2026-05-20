# V3-δ 最后验收报告 (2026-05-19 13:11)

**测试 subagent**: a9e735e483b4be8da
**Token**: 2/2 chat（1 primeSummary + 1 手动引用测试）
**Console**: 0 errors / 0 warnings

---

## 总分

- **严格 15 项**：12 PASS / 1 FAIL（agent prompt 遵循）/ 1 SKIP（abort 测试 token 预算）/ 1 INDETERMINATE（合成验证）
- **PR 代码维度**：14 / 15（v3-δ 代码本身全 PASS，FAIL 是 agent prompt 遵循）

---

## ✅ v3-δ 代码层面全 PASS

| 模块 | 状态 |
|---|---|
| 引用回链 post-process | ✅ DOM/CSS/click/flash/safe-fail 全过 |
| thread.messages 持久化 | ✅ IDB 写 + 刷新 hydrate 完整 |
| 笔记导出实化 | ✅ Blob+download 工作，文件名 sanitize OK，内容含 PDF/对话/高亮 |
| 整体无回归 | ✅ CardMenu hidden / toolbar 动态 / caching hash 稳定 |

---

## ⚠️ 两个发现要鸭鸭决断

### 1. agent prompt 遵循（P0 #1 FAIL，非代码 bug）

DeepSeek 在中文复杂回复中**不稳定遵循** `〔p.N〕` 格式——实测它用 `p.6 / p.7` 普通格式输出。代码 post-process 健康，但**用户实际感受不到回链功能**。

修法选项：
- A. system_prompt.md 加 few-shot 例子（"例如：作者主张...〔p.5〕"）
- B. message 末尾追加 "请记得用〔p.N〕标注页码"
- C. 容错正则也接受 `(p.N)` / `p.N` 形式

### 2. prime 重复触发（P0 #7 Regression）

刷新页面 → hydrate thread.messages → primeSummary 又自动跑一次 → 浪费 1 次 LLM 调用 + 污染导出文件 thread。

修法：loadPdf 内 hydrate 完后检查 thread.messages 是否已含 primeSummary，跳过自动 prime。

---

## 关键证据

**导出 .md 实际生成内容（前 12 行）**：
```
# 主题: 默认主题
> 导出时间: 2026-05-19 13:11
> Palette: 🔴 看不懂 / 🟢 已掌握 / 🔵 课题相关 / 🟣 质疑 / 🟡 重点 / ⚪ 待查
---
## 📄 PDF 1: 2412.13678
### 主对话（不绑高亮）
**你**: 请给这篇论文一个 100 字以内的核心总结...
**Agent**: **What**: 提出 Clio...
```

**Cite-link 合成验证**: click data-page="3" → scrollTop 0→2190 + `.page-flash` class 添加 ✅
超界 999 click → console.debug `[cite-link] page out of range: 999 total=46` + 无副作用 ✅
caching hash 仍稳定: `messages[0] role=system len=70 hash=18288ccf topic=default` ✅

---

## 建议

**条件可发布**——v3-δ 代码 PR 合格。两个建议先解决：
- 🔴 prime 重复修复（blocker，每刷新浪费钱）
- 🟡 agent 引用格式遵循（non-blocker 但用户感知不到回链）
