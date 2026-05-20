# Co-Read · GitHub 竞品调研 (2026-05-19)

> Architect subagent · 调研产出 · **doc only · 未动代码**
> 范围：4 类 PDF 相关 GitHub repo, 11 个有效样本
> 目的：找出"读 + 理解 + 整理 + 输出"四环节的可借鉴点 + 守住 co-read 独有的差异化

---

## 总览

调研了 **11 个 GitHub repo**（覆盖 4 类）：
- A 类（纯 PDF Viewer）：3 个
- B 类（PDF 标注工具）：2 个
- C 类（AI + PDF chat）：3 个
- D 类（研究/笔记型工具）：3 个

提炼出 **12 条可借鉴亮点**、识别 **4 条独有优势**（不能被竞品带偏）、给鸭鸭 **3 条具体建议**。

**一句话总评**：co-read 在「**颜色 = AI 指令**」「**主题级 caching**」两个方向**完全独有**，但在「**缩略图 sidebar 导航**」「**精确文本定位（findController）**」「**跨论文/主题级搜索**」三处明显落后于成熟竞品——值得在 v3 之后选一两个补齐。**不要走** paper-qa 的"全自动 agent 搜索 + 自动总结"路线（脱离研究者亲自读的核心 Mission）。

---

## A. 纯 PDF 阅读器 / Viewer

### A1. mozilla/pdf.js (53.3k stars)

- **它做的事**：Mozilla 官方的纯 JS PDF 解析+渲染库，Firefox 内置 viewer 的来源；提供完整 viewer demo（侧栏、搜索、outline、缩略图、连续滚动、debug 工具）。
- **我们已有的**：直接用了 pdf.js 作为底层渲染（V3_DESIGN 已说明）；连续滚动模式已采用。
- **我们可以学的**：
  1. **缩略图 sidebar**——pdf.js 的 default viewer 左侧有缩略图列。鸭鸭读 30 页论文翻页找回某张图非常痛苦，缩略图 sidebar 是低成本高价值。
  2. **Outline / TOC sidebar**——PDF 自带 outline 时直接展示成可点目录树。论文有 outline 的不多但有的话很省事。
  3. **PDF.js findController API**——V3_DESIGN G2 已经识别这是 v3.1 升级精确定位的关键。可参考 pdf.js viewer.js 里 `PDFFindController` 的用法。
- **不学的**：default viewer 那套臃肿的工具栏（旋转、打印、附件 panel、属性 panel 等）—— 与"读论文"无关，YAGNI。
- **链接**：https://github.com/mozilla/pdf.js

### A2. agentcooper/react-pdf-highlighter (1.4k stars)

- **它做的事**：React + TypeScript 写的 PDF 标注组件，提供 TextHighlight、AreaHighlight、Popover 三种 primitive；用 scaled coordinates 持久化锚定（与缩放/分辨率无关）。
- **我们已有的**：v2-b 已有自实现的 highlight rect overlay；坐标系用页内相对坐标。
- **我们可以学的**：
  1. **AreaHighlight（截图式标注）**——选一块矩形区域（不是文本）。鸭鸭读论文有大量图表/公式想标但 PDF text layer 选不中。AreaHighlight 用 canvas 截图保存矩形坐标 + 缩略图。**这是 v3.1 / v4 候选**。
  2. **scaled coordinates** 实现细节——把 absolute pixel rect 除以 viewport.width/height 存储成 [0,1] 比例。viewer 缩放/不同 dpi 都不会错位。**v2-b 我们怎么存的，需要验证是否已用 scaled。**（行动项见末尾）
- **不学的**：React 整体技术栈——co-read 是 vanilla JS。但可以"读源码学算法"。
- **链接**：https://github.com/agentcooper/react-pdf-highlighter

### A3. react-pdf-viewer/react-pdf-viewer (2.6k stars, **已归档 2026-03**)

- **它做的事**：React 封装 pdf.js 的商业 viewer，plugin 架构（thumbnail / search / bookmark / fullscreen / dark mode 等都是 plugin）。
- **我们已有的**：fullscreen / 搜索 / 缩放都有；plugin 架构没有，但 v2-b 单文件 1200 行也不需要。
- **我们可以学的**：
  1. **plugin 形态的思维**——把"缩略图 / 大纲 / 搜索"做成可独立开关的小模块，不强塞工具栏。鸭鸭如果只关心阅读，工具就藏起来。
  2. **dark mode**——默认深色，研究者夜读护眼。CSS 几行变量就能做。**建议加进 v3+**。
- **不学的**：plugin 架构这种 enterprise 抽象（CLAUDE.md 约束 #2 非必要勿增实体），inline 几个 helper 函数就够。该项目商业化导致 archived 也是个警示——别走商业 viewer 路线。
- **链接**：https://github.com/react-pdf-viewer/react-pdf-viewer

---

## B. PDF 标注工具

### B1. hypothesis/client (705 stars)

- **它做的事**：学术界 web annotation 经典实现；浏览器扩展 + 嵌入 widget，支持 web 页面 / PDF / 视频统一锚定模型；标注存到 Hypothesis 云端服务，支持公开 / 私有 / 群组讨论流。
- **我们已有的**：本地 IndexedDB 存标注；color-tagged 高亮；单 PDF 内的 thread 讨论。
- **我们可以学的**：
  1. **fuzzy text anchoring**（基于他们论文：Web Annotation TextQuoteSelector + TextPositionSelector 多重 fallback）——选区不只存 page+rect，还存 `exact / prefix / suffix` 文本片段。**PDF 后续被替换/版本升级时旧标注仍能找到**。鸭鸭如果某天换一个新版本论文，老标注不丢。
  2. **侧边栏 thread UI 形态**——hypothesis sidebar 是右侧固定面板，每条标注一张卡 + 嵌套讨论。**和我们 thread 设计已经很像**，可以对照他们的 UI 细节学学（如选中高亮时 sidebar 卡片自动滚到对应位置、双向定位）。
- **不学的**：群组协作 / 公开标注 / 用户系统——超出 alpha 阶段 mission，不做协作（V3_DESIGN H 节已声明）。
- **链接**：https://github.com/hypothesis/client

### B2. logseq/logseq (43k stars)

- **它做的事**：知识管理工具，PDF 标注是其中一块——高亮直接生成一个**块（block）**到日记/笔记里，反向回链到 PDF 页码。
- **我们已有的**：颜色高亮 + thread 围绕高亮；笔记 .md 是 v3+ 的 export 工作。
- **我们可以学的**：
  1. **高亮 → 笔记块的双向绑定**——logseq 每个高亮自动生成一个带 `[[PDF/papername#page=5]]` 反向链接的块；点块跳回 PDF 位置。这就是 co-read PRODUCT_HIGHLIGHTS 🔗 "Trace-Back Citations" 的另一个方向：**从笔记反查 PDF**。V3_DESIGN 的 〔p.N〕只解决 AI 回答→PDF；logseq 解决 笔记→PDF。两个方向都很重要。
  2. **块（block）作为最小思考单位**——co-read 现在的最小单位是 thread + 高亮；logseq 是 block。可能 v3+ 导出 .md 时一条高亮 + 围绕它的对话 = 一个 block。
- **不学的**：整套图数据库 + graph view + 双向链接全家桶。**严重过度工程**，鸭鸭只要 .md 输出，不要图谱。
- **链接**：https://github.com/logseq/logseq

---

## C. AI + PDF chat

### C1. mayooear/ai-pdf-chatbot-langchain (16.5k stars, **已归档 2026-03**)

- **它做的事**：LangChain/LangGraph + Supabase pgvector，做 PDF RAG chatbot；流式响应 + "View Sources" 显示检索到的 chunk。
- **我们已有的**：D 策略（全文进 prompt）+ 流式 + DeepSeek 缓存命中。我们**不做** RAG。
- **我们可以学的**：
  1. **"View Sources" 这个 UI affordance**——回答下方有一个折叠区，点开看 LLM 引用的具体 chunk。我们的 〔p.N〕已经做到回链，但可以补一个"显示 LLM 这次到底看了哪几页"的小角标？**实际上 D 策略下 LLM 看的是全文，没意义**。所以这条**不学**。
- **不学的**：**整个 RAG 路线本身**。RAG 的代价：①向量库依赖（Supabase / pgvector）②embedding 调用 token 成本 ③retrieval recall 损失 ④失去"prompt caching 全文"的能力（每次 retrieval 的 chunk 不同 → 前缀不稳 → cache miss）。**这与 PRODUCT_HIGHLIGHTS 💰 cache-native 经济学根本冲突**。这个 16.5k stars 项目归档了，某种意义上印证：研究者读 30 页论文不需要 RAG，直接全文塞 prompt + 缓存才是 co-read 的 sweet spot。
- **链接**：https://github.com/mayooear/ai-pdf-chatbot-langchain

### C2. nutlope/pdftochat (1.4k stars)

- **它做的事**：Together AI + Chroma Cloud + Next.js 的 chatpdf，混合检索（Qwen 密集 + SPLADE 稀疏 + RRF 融合）。
- **我们已有的**：和我们模型选型有重合（Together / Qwen 也是我们候选），但我们走 D 策略不走 RAG。
- **我们可以学的**：
  1. **landing page + 引导文案设计**——pdftochat 的 landing 简洁有力。co-read landing 「不是再做一个 ChatPDF」也是这个调性，可以**对照他们 README 截图找 UI 灵感**（卡片间距、CTA 按钮位置）。
- **不学的**：RAG（同 C1）、Clerk 用户系统（co-read 本地 alpha）、Vercel Postgres（co-read 不需要后端持久层）。
- **链接**：https://github.com/nutlope/pdftochat

### C3. bhaskatripathi/pdfGPT (7.2k stars)

- **它做的事**：Python + Gradio + 自实现的语义检索（Universal Sentence Encoder + KNN），回答里**带 `[页码]` 标记**。
- **我们已有的**：V3_DESIGN D 节已经设计 〔p.N〕 回链协议。
- **我们可以学的**：
  1. **`[页码]` 引用范式被 LLM 社区广泛验证**——pdfGPT 早期就这么做，pdftochat 后来跟进，paper-qa 也用 in-text citation。我们的 〔p.N〕方向**完全在最佳实践上**。可以更激进点，**让 LLM 在多句话里多次回链**（V3_DESIGN D.4 prompt 已经有示例，对的）。
  2. **150 词 chunk 这个粒度**——pdfGPT 切 150 词 chunk 做检索。我们走 D 策略不切 chunk，但这个数字可以作为未来 v4/v5 引入选择性 RAG 时的参考。**当前不做**。
- **不学的**：Gradio UI（功能丰富但工具感太强，不适合阅读场景）。
- **链接**：https://github.com/bhaskatripathi/pdfGPT

---

## D. 研究/笔记型工具

### D1. Future-House/paper-qa (8.5k stars)

- **它做的事**：科研文献 RAG，三阶段 agent（Paper Search / Gather Evidence / Generate Answer），自动从 Semantic Scholar / Crossref / Unpaywall 抓 DOI 元数据，**每个回答都带 in-text citation**。Apache-2.0。
- **我们已有的**：单 PDF + 颜色思考 + 〔p.N〕回链。
- **我们可以学的**：
  1. **DOI / 元数据自动获取**——鸭鸭上传一篇 arxiv PDF，co-read 可以自动抓 title / authors / year，**省得手动改文件名**。当前我们的 `pdfKey` 是 `file:name:size`，title 用 `deriveTitleFromKey` 粗糙处理（V3_DESIGN E.2）。可以**v3.1 加一个"从 PDF 第一页提取标题 + 从文件名抓 arxiv id" 的轻量增强**。
  2. **多论文（contradicting evidence）综合**——paper-qa 能跨多篇论文回答"A 和 B 论文对 X 的结论是否一致？"。**鸭鸭未来开"主题"装 6 篇论文时这就是杀手 feature**。V3 已经为此搭好了容器（Topic = 多 PDF），剩下的是阅读页 UI 暴露"切到主题视图问跨论文问题"这个入口。**强候选 v3.2 / v4**。
- **不学的**：
  - Agent 自动检索 + 自动总结的"全自动"姿态——co-read mission 是**辅助研究者亲自读**，不是替代。"我没读这论文，paper-qa 替我读" 在 ChatPDF/perplexity 世界已经够了；co-read 的差异化是"我亲自读，AI 陪我读"。**不要走 paper-qa 的 agent 全自动路线**，会偏离 mission。
  - 重技术栈（agent / 多轮 retrieval / rerank）——co-read 一个 server.py 一锅煮的极简优势会消失。
- **链接**：https://github.com/Future-House/paper-qa

### D2. zotero/zotero (14.2k stars)

- **它做的事**：学术文献管理界 gold standard。内置 PDF reader + 标注 + note editor + 跨文献 collections + 标签 + 插件生态。
- **我们已有的**：单 PDF + 高亮 + 单主题。
- **我们可以学的**：
  1. **collections + tags 双轴整理**——zotero 让一篇论文同时属于多个 collection + 带多个 tag。**co-read 的 Topic 是单属（一个 PDF 只能在一个 Topic 里，V3_DESIGN P4 验收已声明）**。这是个权衡：单属保证 caching 边界清晰；多属带来灵活性但 caching 域复杂化。**当前保持单属是正确的**，但 v4+ 可能需要"复制到另一主题（深拷贝标注）"的小工具。
  2. **note editor 的 markdown export 格式**——zotero 的笔记导出有现成约定（注释行 + 引文 + 链接）。**鸭鸭 v3+ 设计导出 .md 格式时可对照参考**（V3_DESIGN G6 占位）。
- **不学的**：
  - 桌面 app 路线——co-read 是 web，更轻量。
  - 整个文献库管理（DOI 库、引用样式、bibtex）——超 scope。
  - 插件生态——v3 alpha 不需要。
- **链接**：https://github.com/zotero/zotero

### D3. madawei2699/myGPTReader (4.4k stars)

- **它做的事**：Slack bot 形态的 GPT 文档阅读助手，支持 webpage / PDF / DOCX / YouTube。
- **我们已有的**：纯 PDF + 网页 viewer，更聚焦。
- **我们可以学的**：
  1. **多源输入的可能性**——研究者也读 webpage 综述 + arxiv html 版。**v4+ 可考虑 web URL 当作"伪 PDF"接入**——但 v3 alpha 不做（V3_DESIGN H 节边界）。
- **不学的**：Slack bot 形态——研究阅读是沉浸式视觉任务，Slack 流不适合。
- **链接**：https://github.com/madawei2699/myGPTReader

---

## 按 co-read 产品 Mission "读 + 理解 + 整理 + 输出" 提炼借鉴清单

| 环节 | 可借鉴的点 | 来自 | 实施难度 | 价值 | 优先级 |
|---|---|---|---|---|---|
| **读** | 缩略图 sidebar | mozilla/pdf.js | 低（pdf.js 内置 API） | 高（30 页论文导航刚需） | **高** |
| **读** | PDF outline / TOC sidebar | mozilla/pdf.js | 低 | 中（有 outline 的论文才有用） | 中 |
| **读** | dark mode | react-pdf-viewer | 极低（CSS 变量） | 中（夜读护眼） | 中 |
| **读** | AreaHighlight（图表/公式截图标注） | react-pdf-highlighter | 中 | 中（论文图表多） | 中 |
| **读** | 精确文本定位 findController | mozilla/pdf.js | 中 | 高 | 已在 V3_DESIGN G2 列为 v3.1 |
| **读** | fuzzy text anchoring（标注耐 PDF 版本升级） | hypothesis/client | 高 | 中（PDF 替换是低频场景） | 低 |
| **理解** | "View Sources" 折叠区显示 AI 看了哪些 chunk | mayooear / nutlope | - | - | **不做**（与 D 策略冲突） |
| **理解** | in-text citation `〔p.N〕` 范式 | pdfGPT / paper-qa | - | - | 已在 V3_DESIGN D 节做了 |
| **理解** | 多论文/跨主题综合提问 | paper-qa | 中 | 高（V3 容器铺好了路） | **强候选 v3.2** |
| **整理** | 高亮 → 笔记块双向绑定 | logseq | 中 | 高（PRODUCT_HIGHLIGHTS 闭环关键） | 高（v3+ 导出 .md 时一并设计） |
| **整理** | DOI / 元数据自动提取 | paper-qa / zotero | 低（arxiv id 正则 + PDF metadata） | 中（省手动改文件名） | 中 |
| **输出** | 笔记 .md 导出格式参考 zotero 约定 | zotero | 低 | 高（v3+ 必须做） | 已在 V3_DESIGN G6 占位 |

---

## 我们的独特优势（保持，不要被竞品带偏）

### 1. 颜色 = AI 行为指令（PRODUCT_HIGHLIGHTS 🎨）

**调研中无一家有此设计**。竞品中颜色都只是"视觉分类"：
- react-pdf-highlighter：颜色只是 highlight 的 prop，不影响 AI 行为
- logseq：高亮就是 block，颜色不带语义
- hypothesis：颜色不绑 prompt 行为
- 所有 ChatPDF 类：没有颜色概念

**这是 co-read 真正的 differentiation——颜色是 prompt 的低带宽语义信号。** 守住，不要被竞品 UI 带偏成"6 色挑色器"。

### 2. 主题级冻结色板 + 跨论文 caching（PRODUCT_HIGHLIGHTS 🎯 + 💰）

**调研中无一家把 prompt caching 当 first-class 设计。** paper-qa / nutlope 都走 RAG（chunk 检索 → 前缀不稳 → 没 cache hit）。zotero / logseq 不调 LLM。**co-read 是唯一把"用户认知容器（主题）= caching 边界" 这一抽象统一的产品**。V3_DESIGN C.2 表格说得很清楚，这是技术红利。

### 3. Trace-Back Citations 〔p.N〕回链（PRODUCT_HIGHLIGHTS 🔗）

**这个范式行业普遍**（pdfGPT、paper-qa、nutlope 都做）。但**我们做得更轻量**——D 策略全文在 prompt 里、不切 chunk，所以 〔p.N〕的页码是 LLM 直接读到的（不是检索回的），更准。竞品的 source 是 retrieved chunk 的元数据，准确度受 retrieval recall 限制。

### 4. Vanilla JS + 单 server.py 极简栈

**16.5k stars 的 mayooear 项目用了 Next.js + LangChain + LangGraph + Supabase + Turborepo monorepo，归档了**。43k 的 logseq 一个 graph DB 包打天下。co-read 现在 1 个 server.py + 1 个 app.js（v3 后 ~2400 行）—— alpha 阶段单人开发的甜区。**别加框架**。

---

## 给鸭鸭的 3 个建议（按价值密度）

### 1. 立即做（低成本高价值，v3 上线后立刻补）

**加缩略图 sidebar**（来自 mozilla/pdf.js）。

- 实施成本：pdf.js 自带 `PDFThumbnailViewer` 组件，~80 行胶水代码就能集成左侧固定面板 + 当前页高亮。
- 价值：鸭鸭读 30 页论文翻页找回某张图非常痛苦。这是阅读体验明显短板（V3_DESIGN 没提，但每个竞品都有）。
- 建议在 v3-β 主题 UI 完成后、v3-γ caching 之前插一个 v3-β2 (~100 行) 把缩略图加上。**别等到 v3.1**。

### 2. 可以做（中成本中价值，下个迭代 v3.2 / v4）

**多论文/跨主题综合提问**（来自 paper-qa）。

- 实施成本：UI 层在 Topic 页加一个"问跨论文问题"输入框；后端把当前 Topic 下所有 PDF 全文拼成一个超长 prompt 发出去（DeepSeek 长上下文够；6 篇论文 ~100k token 还在窗口内）。
- 价值：**V3 把容器搭好了但没暴露入口** —— 一旦暴露，这是 co-read 区别于 ChatPDF 类的杀手 feature。"6 篇论文在我的色板语言下整体讨论"独此一家。
- 风险：长 context 成本（即使 90% 缓存，第一次跨论文问也要 ~10k 输入 token）→ 需要文案明确告知用户。
- 建议**v3 上线 + 鸭鸭实际用 2-3 个主题之后**再做，避免凭空设计。

### 3. 暂时不做（高成本 / 偏离 Mission）

**全自动 RAG / agent 检索**（来自 paper-qa / mayooear）。

- 不做理由：①cache-native 经济学的根基是 D 策略前缀稳定；切 chunk + retrieval = 前缀不稳定 = 缓存几乎全失效，PRODUCT_HIGHLIGHTS 💰 整个营销话术作废。②mission 是"辅助亲自读"不是"替代读"——agent 自动检索就成了 paper-qa / perplexity 的复刻。③mayooear 16.5k stars 归档了，是个警钟。
- **如果未来 PDF 上传超 100 页 / 一个 Topic 超 20 篇 → context window 装不下 → 才考虑选择性 RAG（不是替换 D 策略，是 D + R 混合）**。这是 v5+ 的事。

---

## 行动项 / 给主 Claude 的待办

1. **验证 v2-b 的 highlight rect 是否已用 scaled coordinates**——A2 react-pdf-highlighter 的 best practice 是除以 viewport 存 [0,1]。如果 v2-b 存的是 absolute px，缩放后会错位。**请 dev/test 在 v2-b 上跑一次"放大 2x 后老高亮还对齐吗"的 e2e 验证**。
2. **v3-β2 插入缩略图 sidebar**（建议 1）——等鸭鸭确认 v3 G1~G8 后，在 J 节实施顺序里加一个 v3-β2 节，~100 行。
3. **v3+ 导出 .md 格式设计时对照 zotero / logseq 的笔记格式约定**（V3_DESIGN G6 占位项）。
4. **多论文综合提问入口**记入 v3.2 / v4 候选清单（建议 2）。

---

## 一句话总评

**co-read 在"颜色思考 + cache-native + 主题容器"三个方向超过竞品；在"缩略图导航 + 跨论文综合 + DOI 元数据"三个方向还可学；但不要走"全自动 agent RAG"的路（偏离亲自读论文的研究流闭环）。**
