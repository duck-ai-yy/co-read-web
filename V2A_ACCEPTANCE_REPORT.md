# V2-a 验收报告 (2026-05-19 00:15)

**测试 subagent**: a06908abe5aa2e26a
**样本**: arxiv 2412.13678 (Clio, 46 页) + 1706.03762 (Transformer, 15 页 — 切论文测)
**Server**: 127.0.0.1:5050 PID 64393 (deepseek)
**方法**: Playwright MCP + 直读 IndexedDB + 静态读源验证事件名

---

## 总分 **17 / 19** （1 FAIL P1#5 跨 3+ 页选区；1 SKIP P2#11 图片区）

| 组 | 通过 | 备注 |
|---|---|---|
| P0 核心 happy | 3/3 | 选→色板→高亮→引用→气泡→删除全闭环 |
| P1 跨页 / 持久 | 4/5 | **跨 3+ 页 fail（架构 bug）**，其余都过 |
| P2 边缘 + 无回归 | 8/9 | 叠色 / 复制 / Enter+IME / 搜索 / abort 全过；1 skip |
| P3 视觉/DOM | 2/2 | console.errors=0，6 色全验 |

---

## ❌ P1#5 跨 3+ 页选区 — 架构 bug

**复现**：滚到 p.2 顶（p.1-5 textLayer 全部已渲染），Range API 选 p.2 中部→p.4 中部（7342 字符），点 🟣

**期望**：3 页都有 rect，引用 `[p.2-4 · 🟣]`

**实际**：**只 p.2 有 28 rect**；中间页（p.3）和终点页（p.4）丢失；引用变成 `[p.2 · 🟣]`

**根因**：`app.js:344-345` 的 `describeSelection` 用 `document.elementFromPoint(cx, cy)` 把 rect 分配到 page。视口外坐标 → `elementFromPoint` 返回 null → `if (!el) continue` 丢弃。

实测：203 个有效 rect 中，27 个落在 p.2（视口内），176 个 `elementFromPoint=null`。每页 ~860px、container ~940px → 视口最多装下 1 整页 + 边角，跨 3+ 页或中间整页不可见时必然丢失。

**修复**（test 给出明确方向）：用所有 `.page[data-page-number]` 的 `getBoundingClientRect()` 列表做点包含判定，替换 `elementFromPoint`。pdf.js virtualization 不销毁 `.page` DOM，查表稳定。

---

## ✅ 关键证据（dev 自报风险都验过）

**Dev 自报"textlayerrendered 事件名可能拼错"虚惊一场**：
- 静态 grep `pdf_viewer.mjs` 4.6.82 源 → `textlayerrendered` 字面量存在
- 动态 scroll 来回 3 次 → highlight layer 始终 15 rect 完好
- 46 页规模 PDF.js 默认 viewer 不销毁 textLayer，补画路径根本未触发

**IndexedDB 实测**（`coread.annotations["url:https://arxiv.org/pdf/2412.13678"]`）：
```js
[
  { id:"04a5f74c…", color:"blue", pages:[{page:2,...},{page:3,...}], text:"this paper exclude..." },
  { id:"…", color:"yellow", pages:[{page:2,...}] },
  { id:"…", color:"gray",   pages:[{page:2,...}] },
]
```

**DOM 样本**（百分比定位，缩放自适应）：
```html
<div class="highlight-layer">
  <div class="hl-rect color-blue"
       data-ann-id="04a5f74c-…"
       style="left: 17.649%; top: 88.4596%; width: 68.0909%; height: 1.62225%;"></div>
</div>
```

---

## 截图

- `v2a-palette.png` — P0#1 色板浮出
- `v2a-highlight.png` — P0#2 红高亮 + 引用入 textarea
- `v2a-multi-colors.png` — P2#9 四色叠加 p.2

---

## v1 无回归确认

PDF 复制 ✅ | 搜索 ⌘F ✅ | Enter / Shift+Enter / IME ✅ | 流式 ✅ | abort ✅ | backHome ✅ | `textLayerMode=1` 没被回退 ✅

---

## test 给主 Claude 的建议

1. **P1#5 跨页 bug 修复**：换 `elementFromPoint` → `.page` 列表点包含。修在 v2-b。
2. **dev.md 加一笔**：`textlayerrendered` 事件名已验证存在，下次 dev 不用再担心（46 页规模不触发补画路径）。
3. **建议挂 `eventBus` 到 `window.__coread`**：便于 test/debug dispatch 事件（极小代价）—— 但当前不必要。
4. **时序细节**：`loadAnnotations(pdfKey).then(...)` 异步填 annotations，未来 dev 加 sync 逻辑要注意此时序。
