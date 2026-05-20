# PDF Viewer 重构方案

> 由 architect subagent 起草 · 等鸭鸭拍板后交给 dev 实施
> 范围：仅 PDF 展示层（`app.js` 的 `pdfRenderer` 区 + `index.html` 阅读页 DOM + `style.css` `.pdf-*` 类）
> 不动：server.py / system_prompt.md / chat 流程 / .env / .claude/agents/

---

## 一、当前实现的问题

代码定位：`app.js` 第 106–124 行（`renderPage`），`index.html` 第 33–43 行（`.reader-left`），`style.css` 第 119–131 行（`.pdf-container`）。

| # | 问题 | 现象 | 根因 |
|---|------|------|------|
| 1 | **文字不可选** | 用户在 PDF 上拖动鼠标没有任何反应 | 只画了 canvas，没有 text layer。整页是位图。 |
| 2 | **不能复制/不能划线** | 阻塞了产品口号"划线即追问、高亮即笔记" | 同上。划线高亮的前提是有可选文字的 DOM。 |
| 3 | **字体糊** | 即使加了 `devicePixelRatio`，缩放/打印仍然马赛克 | 整页位图本质上是栅格化；只有 text layer 才是矢量文字（浏览器原生抗锯齿）。 |
| 4 | **翻页是"重画"不是"翻"** | `renderPage` 里 `els.pdfContainer.replaceChildren()` 把整个容器清空再画 | 每次翻页都新建 canvas、丢弃旧的，没有连续滚动、没有相邻页预渲染。 |
| 5 | **无搜索 / 无缩略图 / 无目录** | 长论文找一段全靠肉眼+按方向键 | 没用 PDF.js 官方的 `PDFFindController` 和 `PDFThumbnailViewer`。 |
| 6 | **缩放只有写死的 scale: 1.4** | 不同屏幕大小、视力差异完全没适配 | 代码里 hard-coded `page.getViewport({ scale: 1.4 })`。无 fit-width / fit-page / 手势缩放。 |
| 7 | **无 annotation layer** | PDF 里的超链接、表单字段、原生注释看不见也点不了 | 没挂 `AnnotationLayerBuilder`。 |
| 8 | **大 PDF 内存压力** | 一篇 50 页论文翻完 = 渲染了 50 个全分辨率 canvas（虽然每次只留 1 个，但首次 `extractAllText` 也是串行 50 次 IO） | 没有 virtualized rendering（只渲染可见+缓冲）。 |

口语版："现在做的不是 PDF viewer，是 PDF 截图轮播器。"

---

## 二、GitHub 调研结论

### 1. `mozilla/pdf.js`（官方 viewer，权威参考）

- **多页管理**：`PDFViewer` 类管 `_pages: PDFPageView[]`，三种 `ScrollMode`（VERTICAL/HORIZONTAL/PAGE）+ 两种 `SpreadMode`（单页/双页）。
- **Text layer**：`PDFPageView` 通过 `textLayerMode` 参数自动构建。底层 `TextLayer` 类把 PDF.js 的 text content 渲染成绝对定位 div，**用浏览器原生 Selection API** 处理选区，跨页选区由 viewer 协调。
- **Virtualized**：`PDFPageViewBuffer` 默认缓存 10 页，`_getVisiblePages()` 配合 `update()` 把 buffer 动态调到 `2 * 可见页数 + 1`。
- **Canvas**：**每页一个独立 canvas**。`enableDetailCanvas` 支持高倍率局部细节渲染。`maxCanvasPixels/maxCanvasDim` 防溢出。
- **关键模块**：`PDFViewer` + `EventBus` + `PDFLinkService` + `PDFFindController`（搜索） + `PDFThumbnailViewer`（缩略图）。
- **CDN 可达**：cdnjs 的 `pdf.js@4.6.82` **同时提供** `pdf.min.mjs`、`pdf.worker.min.mjs`、**`pdf_viewer.mjs`、`pdf_viewer.css`**。无需 npm/打包。

### 2. `wojtekmaj/react-pdf`（高 star vanilla-ish PDF.js 封装）

- 默认 `renderTextLayer=true`、`renderAnnotationLayer=true`，需要分别引 `TextLayer.css` 和 `AnnotationLayer.css`。
- 每页一个 canvas（`canvasRef` 暴露）。
- 提供 `<Thumbnail>`、`<Outline>` 组件。
- **结论**：它的"心智模型"= PDF.js 官方 viewer 的 React 壳。我们不要 React，**直接用 PDF.js 官方 viewer 模块即可获得同等能力**。

### 3. `hypothesis/client`（PDF 标注神器，对划线高亮借鉴）

- **挂法**：用 `MutationObserver` 监听 PDF.js viewer 的 `data-loaded` 状态，每页渲染完后重新 anchor 注释。
- **高亮层**：**叠在 text layer 之上**。给 text layer 加 CSS 类 `has-transparent-text-layer` 让文字透明，高亮 div 显在文字位置上。
- **锚定**：三类 selector — `PageSelector`（页号）、`TextQuoteSelector`（文字内容引用）、`ShapeSelector`（矩形/点）。`describe()` 把选区→selector，`anchor()` 反向把 selector→DOM range。
- **跨页限制**：`getAnnotatableRange()` 显式只接受**单页内**选区。跨页直接拒绝。
- **结论**：v2 划线高亮，**抄它的 anchor 模型**（页号 + 文字引用 + 矩形 fallback），不抄它的 React/preact 框架。

---

## 三、推荐方案

### 核心决策

| 决策 | 选择 | 理由 |
|------|------|------|
| **要不要换 PDF 库** | **不换**。继续 PDF.js | 已经在用，官方 viewer 模块直接 CDN 可取，零迁移成本。换库 = 违反宪法 #2 不增实体。 |
| **Text layer 怎么做** | **用 PDF.js 官方 `TextLayer` API** | 自己实现 = 重造轮子。官方 API 已处理浏览器差异、跨页选区、复制时的换行修复。 |
| **连续滚动 vs 分页** | **连续滚动（VERTICAL ScrollMode）** | 论文阅读场景：跨页引用、表格图横跨两页常见。分页翻动会打断思路。鸭鸭原产品口号是"划线即追问"——连续滚动让划线选段不被页边界打断（虽然 Hypothesis 模型仍单页 anchor，但视觉连续）。 |
| **整体架构** | **用 PDF.js 官方 `PDFViewer` 组件**（不是自己用 `page.render` 拼） | 一行 `new PDFViewer({container})` 拿到：连续滚动 + virtualized + text layer + annotation layer + 缩放管理 + 跨页选区。自己拼相当于把官方 viewer 的 ~3000 行核心逻辑再写一遍。 |
| **搜索** | **用 `PDFFindController`** | 官方组件，配合 EventBus，~5 行集成。 |
| **缩略图** | **用 `PDFThumbnailViewer`（v3 才上）** | 官方组件，但占屏幕空间。先 v1+v2 不上，等真有需求再加。 |
| **缩放手势** | **v1 给 fit-width / fit-page / +/- 按钮，v2 加 Ctrl+滚轮，v3 加 touch pinch** | 官方 viewer 已暴露 `currentScale` / `currentScaleValue`，按钮 3 行代码。手势是渐进增强。 |
| **CDN vs 本地** | **继续 CDN**（`pdf_viewer.mjs` + `pdf_viewer.min.css`） | 宪法 #2：CDN > 本地。和现有 `pdf.min.mjs` 同源同版本。 |
| **要不要引构建工具/框架** | **不引** | 宪法 #2。vanilla JS 完全够用，官方 viewer 模块就是 ES module。 |

### 架构图（v1 完成后）

```
index.html
 └─ <div id="viewerContainer">            ← 滚动容器（CSS overflow:auto）
      └─ <div id="viewer" class="pdfViewer">  ← PDFViewer 把每页 PDFPageView 挂这里
           └─ .page * N                   ← 每页：canvas + textLayer + annotationLayer
                ├─ <canvas>
                ├─ <div class="textLayer">
                └─ <div class="annotationLayer">

app.js 的 pdfRenderer 区改写：
- 初始化一次：eventBus + linkService + pdfViewer + findController
- loadPdf 后：pdfViewer.setDocument(pdf); linkService.setDocument(pdf)
- 翻页：pdfViewer.currentPageNumber = n（自动滚到该页）
- 监听 eventBus 的 'pagechanging' 更新 state.currentPage
- 监听 'textlayerrendered' 触发 v2 的高亮重渲染
```

### 拆分阶段

#### v1 · 基础体验提升（让 PDF 看着像 PDF）

**目标**：换用官方 viewer 模块，立刻拿到：连续滚动 + 可选文字 + 矢量清晰 + virtualized + annotation layer + 缩放控制。

改动：
- `index.html`：`.pdf-container` 内层结构改成 `<div id="viewerContainer"><div id="viewer" class="pdfViewer"></div></div>`；新增缩放按钮（fit-width / − / + / fit-page）。
- `index.html`：新增 `<link rel="stylesheet" href="https://cdnjs.cloudflare.com/.../pdf_viewer.min.css">`。
- `app.js`：`pdfRenderer` 区重写。删掉旧 `renderPage` 的手动 canvas 逻辑，改用 `PDFViewer` 实例。保留 `extractAllText`（喂给 LLM 的逻辑不变）。
- `style.css`：调整 `.pdf-container` → `#viewerContainer` 滚动容器样式；轻量 override pdf_viewer.css 让风格融入 Perplexity 极简风。

不动：chat 流程、state shape（仍 `currentPage`/`totalPages`/`pdfText`/`pdfTitle`）、键盘事件意图（← → 翻页改成"跳到上/下页"，调 `pdfViewer.currentPageNumber`）。

#### v2 · 划线高亮（兑现产品口号）

**目标**：选中文字→气泡按钮 [高亮 / 提问]→颜色分类→记录到 state→画在 text layer 之上。

改动：
- `app.js`：新增 `highlightLayer` 区。监听 `document.selectionchange`，判断 selection 是否在某页 `textLayer` 内（参考 Hypothesis 的 `getAnnotatableRange`），是则显示浮动 toolbar。
- 高亮渲染：选中 range → `range.getClientRects()` → 每个 rect 转成相对于该 page 容器的坐标 → 画 absolute div（半透明色块）插入到该 page 的 textLayer 同级。监听 PDF.js `pagesinit`/`pagerendered` 在重新渲染时重画。
- 锚定模型（抄 Hypothesis）：`{ page: n, quote: "...原文片段...", prefix: "前 32 字", suffix: "后 32 字" }`。重新打开同一 PDF 时用 `pdfText` 全文 + quote 重新定位。
- "划线即追问"：toolbar 点"问"→ 把选中文字塞进 chat input、自动带 `[PAGE:n] "<quote>"` 上下文。

跨页选区：v2 学 Hypothesis 直接拒绝（toolbar 不显示），简化实现。

#### v3 · sidebar + search + 可选 thumbnails

**目标**：长论文导航。

改动：
- 接入 `PDFFindController` + 搜索输入框（Ctrl/⌘+F 触发）。
- 左侧可折叠 sidebar：缩略图列表（`PDFThumbnailViewer`）+ 目录（`pdf.getOutline()`）。
- 高亮列表面板：v2 的所有高亮按页码排序列出，点击跳转。

---

## 四、工程量估算

| 阶段 | 估算改动 | 风险点 |
|------|----------|--------|
| **v1** | `app.js` 改 ~80 行（`pdfRenderer` 区基本重写）；`index.html` 改 ~10 行；`style.css` 加 ~30 行 override | pdf_viewer.css 的样式可能和现有 Perplexity 风冲突，需要 override。CDN 加载 viewer 模块要确认浏览器对 dynamic import + worker 的支持。 |
| **v2** | `app.js` 新增 ~150 行（selection 监听 + 浮动 toolbar + 锚定 + 重渲染）；`style.css` 加 ~40 行（高亮色板 + toolbar）；`index.html` 加 ~10 行 toolbar 模板 | 锚定鲁棒性：相同 quote 在 PDF 里多次出现要靠 prefix/suffix 消歧。重新加载同一 PDF 时锚定可能失败（rare），要有降级。 |
| **v3** | `app.js` 加 ~100 行；`index.html` 加 ~30 行 sidebar；`style.css` 加 ~60 行 | sidebar 显隐布局重排，可能挤压 chat 列。需鸭鸭确认布局。 |

总计 v1+v2+v3 ≈ 500 行净增（含 HTML/CSS）。对照宪法 #2，每行都是为了核心产品价值（可选/划线/搜索），无 over-engineering。

---

## 五、需要鸭鸭拍板的决策点

### Q1 · 连续滚动 vs 单页翻页 — 阅读节奏

我推荐**连续滚动**（论文有跨页表/图，思路连续）。但如果鸭鸭觉得"一页一页读、读完一页停下来想"更像她设想的"伴读"节奏，可以选**单页模式**（PDF.js 的 `ScrollMode.PAGE`）。

- **A. 连续滚动**（默认）：上下滚动无缝；翻页按钮 = 滚到下一页顶。
- **B. 单页**：每屏 1 页；翻页按钮 = 切换页面（类 Kindle）。
- **C. 都给**（toolbar 一个切换按钮）：增加 ~10 行代码，但多了配置项。

### Q2 · v2 划线高亮：单页限制接受吗？

Hypothesis 的方案是**跨页选区直接拒绝**（toolbar 不弹出）。我推荐照抄。

替代：跨页选区也支持，但锚定/重渲染复杂度翻倍。**接受单页限制吗？**

### Q3 · v3 之前要不要先上"基础搜索"

`PDFFindController` 集成成本极低（~30 行）。如果鸭鸭觉得 v2 完成后没搜索很难找东西，可以把搜索从 v3 提到 v1.5 或 v2.5。

- **A. 严格按 v1 → v2 → v3 走**（搜索在 v3 才有）
- **B. v1 就带搜索**（v1 略变大，但论文阅读没搜索很难受）
- **C. 等 v1+v2 上线鸭鸭实际用过再说**

### Q4 · 缩略图 sidebar 默认开还是默认关

PDF.js 官方 viewer 默认是开的（左侧 thumbnails）。但 sidebar 会挤压 chat 列。

- **A. 默认关，按钮触发**（推荐，保持 chat 列宽度）
- **B. 默认开，可折叠**
- **C. 不做缩略图，只做目录大纲（`pdf.getOutline()`），更省地方**

### Q5 · 中间状态怎么验收

v1 完成后会**看上去很像换了个 viewer**，但 chat 流程没变。

- **A. v1 上线后鸭鸭亲自验收一轮**（用真实论文跑），过了再做 v2
- **B. v1 + v2 一起做完再验收**（鸭鸭看到完整"划线→追问"才有感觉）
- 我推荐 **A**：宪法 #6 敏捷 + 小步快跑。v1 自身就是大幅体验提升，独立可演示。

---

## 六、实施前提醒（给 dev）

- **不动 system_prompt.md** 和 chat 协议（`messages` / `pdf_text` 入参不变）
- **保留 `state.pdfText`** 的 `extractAllText` 逻辑——它是 LLM 上下文的根。viewer 换了但全文抽取不变。
- **保留 `[CURRENT_PAGE: N]` 注入逻辑** —— 监听 `eventBus.on('pagechanging', ...)` 更新 `state.currentPage` 即可。
- **prompt caching**：`pdf_text` 内容不变 → 缓存仍命中。viewer 重构不影响宪法 #1。
- **错误处理**：`PDFViewer` 初始化失败要有降级（极端情况下回退到当前的 canvas 单页渲染），符合宪法 #4。
