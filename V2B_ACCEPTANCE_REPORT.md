# V2-b 验收报告 (2026-05-19)

**测试 subagent**: a6477b84eea2bdecd
**样本**: arxiv 2412.13678 (Anthropic Clio, 46 页)
**Server**: PID 64393 alive, HTTP 200
**Token**: 3 / 4 条 chat 预算内
**Console**: errors=0 · warnings=0（全 session）

---

## 总分 **22 / 22 PASS** 🎉

| 组 | 通过 | 关键证据 |
|---|---|---|
| P0 鸭鸭报的 5 bug | 5/5 | loading mask 全屏 z-999 / 色板 1.7ms / 删除 1.4ms / thread 化 / 删除联动 |
| P1 跨页 + thread | 5/5 | p.2-4 共 197 rect / sendThreadId 锁住 abort 回滚 |
| P1 边缘 case | 4/4 | 切论文重置 / main 首发 / label 不溢出 |
| P2 v2-a 无回归 | 6/6 | 复制 / IME / 搜索 / 叠色 / abort / IDB 持久 |
| P3 视觉 | 2/2 | 0 errors / 单击 rect 仅浮气泡（dev 设计 by intent） |

---

## P0 性能数据（鸭鸭"瞬间感"的客观度量）

| 项 | 实测 | Target | 结果 |
|---|---|---|---|
| 色板 mouseup → 显示 | **1.7ms** | < 50ms | ✅ |
| 删除 click → DOM remove | **1.4ms** | < 50ms | ✅ |
| Loading mask 覆盖 | 77459ms~80654ms（3.2s 解析期） | 用户全程看见 | ✅ |

---

## thread 化关键验证

**P1#6 跨 3 页选区**：选区 7153 字符；`ann.pages = [p.2(77 rects), p.3(68 rects), p.4(52 rects)]`；DOM 完全一致；引用 `[p.2-4 · 🟣]` 正确

**P1#9 流式中切 thread**：在 purple thread 发长 chat → streaming=true → 500ms 内（首 token 未到）切 main → AbortController.abort() → catch 走 user pop 分支 → `purple.messages=0` / `currentThreadId=main` / `streaming=false`

**P1#10 切 thread 清 textarea 例外保留**：
- 案 A：chatInput="hello-draft" 切 main → 清空 "" ✅
- 案 B：已在 purple chatInput="preserve-me-draft" 点 hl-rect 气泡引用 → switchThread early-return → textarea 保留 "preserve-me-draft" + 追加引用块 ✅

---

## UX 决策待鸭鸭拍板

**单击 hl-rect 行为**：dev 选了"仅浮气泡，不切 thread；只有显式点 ↪引用 / 删除按钮才有动作"。

- 优点：阅读时不打扰、不抢焦点；动作=意图
- 反方：用户可能期待"单击 = 我回这段讨论"，需要两步（rect → ↪）才能切

**建议鸭鸭亲手玩一下感受手感再拍板。**

---

## 截图

- `v2b-loading.png` — loading mask 关闭瞬态
- `v2b-palette.png` — 色板浮出
- `v2b-crosspage.png` — 跨页 p.2-4 紫色高亮

---

## test 给主 Claude 的建议

1. **可以放心进 v2-c**——v2-b 6 件事全修好，v2-a 无回归
2. 不建议 v2-b 微调；UX 决策若要改留 v2-c 一起
3. Loading mask 解析太快 ~3.2s，截屏抓不到"显示中"，真实使用无感。极慢网络/超大 PDF (>200 页) 才能看出价值
4. **v2-c 必做**：`thread.messages` 持久化到 IDB（当前 reload 丢失），刷新原地恢复要带上
