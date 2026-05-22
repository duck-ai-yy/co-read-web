# V3 设计 Doc · 主题容器 + 色板冻结 + 引用回链

> PM · 2026-05-19
> 状态：**design only · 未动代码**
> 范围：以 v2-b（22/22 PASS）为基线，定义 v3 的三件大事

---

## 0. TL;DR（一段话）

v3 把 co-read 从"一篇 PDF 的伴读"升级成"**研究流容器**"：顶层引入**主题（Topic）**——一组论文 + 一套创建时锁定的色板 + 一份导出笔记。色板冻结让一个主题内所有论文共享同一个 system prefix → **跨论文 caching 命中**；同时 agent 输出强制带 `〔p.N〕` 回链，前端 marked.js 渲染成可点链接，点击 = 跳页 + 闪烁定位。**主要风险**：数据迁移（v2-b 已有 IndexedDB annotations）+ system_prompt.md 要不要拆（颜色定义从 prompt 移到注入）——这两件待定（我来拍）。

---

## A. 数据模型

### A.1 IndexedDB schema 升级

当前（v2-b）只有 1 个 store：
```
DB: coread (v1)
└── annotations [key=pdfKey, value=annotation[]]
```

v3 升级到 v2，新增 3 个 store + 改 1 个：
```
DB: coread (v2)
├── topics [key=topicId, value=Topic]              ★ 新
├── pdfs   [key=pdfKey,  value=PdfMeta]            ★ 新（轻量元数据：title / topicId / lastOpened）
├── annotations [key=pdfKey, value=Annotation[]]    △ value 内每条 ann 加 topicId 字段
└── threads [key=pdfKey, value=Thread[]]            ★ 新（v2-b 遗留：thread 持久化）
```

IDB 升级用 `onupgradeneeded` 检查 `oldVersion`，从 1→2 时跑迁移函数（见 E 节）。

### A.2 类型定义（伪 TypeScript）

```ts
// Topic = 研究流容器
type Topic = {
  id: string;              // uuid
  name: string;            // 用户起的名字，<= 60 字符
  palette: PaletteEntry[]; // 创建时定义，之后冻结（不允许 mutate）
  paletteFrozenAt: string; // ISO 时间戳；UI 用此字段判断是否锁
  createdAt: string;
  pdfKeys: string[];       // 该主题下的 PDF（顺序 = 添加顺序）
  // v3+ 预留（不在 MVP）：exportNoteMarkdown / lastExportAt
};

type PaletteEntry = {
  key: string;        // 'red' | 'green' | ... 也可用户改成 'critique' 等任意 slug
  emoji: string;      // '🔴'
  label: string;      // '不懂 / 请详解'
  color: string;      // '#fca5a5'  hex，渲染高亮用
  promptHint: string; // 注入到 system 的颜色规则文本
};

type PdfMeta = {
  pdfKey: string;     // 沿用 v2-b（file:name:size / url:URL）
  title: string;
  topicId: string;    // 反向索引，去 topic 一次跳转
  addedAt: string;
  lastOpenedAt?: string;
};

// 现有 Annotation 扩展（加 topicId 冗余字段，便于跨 topic 查询）
type Annotation = {
  id: string;
  topicId: string;    // ★ 新增（v2-b 数据迁移时填）
  pdfKey: string;     // ★ 新增（v2-b 数据迁移时填——之前是 IDB key，不在 value 里）
  color: string;      // 必须 ∈ topic.palette.map(p => p.key)
  text: string;
  pages: { page: number; text: string; rects: Rect[] }[];
  createdAt: string;
};

// Thread 持久化（v2-c 任务，被 v3 一并吸收）
type Thread = {
  id: string;          // 'main' 或 annotation.id
  pdfKey: string;
  annotationId: string | null;
  anchorPage: number | null;
  anchorColor: string | null;
  label: string;
  quotedText: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  createdAt: number;
};
```

### A.3 默认色板（建议值）

> 完全兼容现 6 色语义。用户在新建主题时可改 emoji / label / 增删 / 改 promptHint。

```json
[
  {"key":"red","emoji":"🔴","label":"不懂 / 请详解","color":"#fca5a5",
   "promptHint":"用户对此处不懂 → 详细解释，假设无基础"},
  {"key":"green","emoji":"🟢","label":"赞同 / 简短确认","color":"#86efac",
   "promptHint":"用户赞同此处 → 简短确认或补充延伸"},
  {"key":"blue","emoji":"🔵","label":"与课题相关 / 联想","color":"#93c5fd",
   "promptHint":"用户标记此处与其研究课题相关 → 联想应用场景"},
  {"key":"purple","emoji":"🟣","label":"质疑 / 找弱点","color":"#d8b4fe",
   "promptHint":"用户质疑此处 → 扮演批判视角找此论点的弱点"},
  {"key":"yellow","emoji":"🟡","label":"标重点 / 仅记录","color":"#fde047",
   "promptHint":"用户标重点 → 仅记录，不主动展开"},
  {"key":"gray","emoji":"⚪","label":"待查 / 留存","color":"#d1d5db",
   "promptHint":"用户标待查 → 仅留存，后续追问再展开"}
]
```

颜色 hex 取 Tailwind 300-400 段，保证 PDF 上 30% 透明度叠色后仍可读。

---

## B. UI 流程图

### B.1 3 层导航

```
+----------------------------------------------------------+
|  Landing                                                  |
|   "不是再做一个 ChatPDF。"                                |
|   [+ 新建主题]   [继续上次：主题 X]                       |
|   ---------                                              |
|   主题列表（卡片网格）：                                  |
|   +--------+ +--------+ +--------+                       |
|   | LLM 综述| | RAG 评估| | Agent  |                      |
|   | 6 篇   | | 3 篇    | | 12 篇  |                      |
|   | 🔴🟢🔵🟣| | 🔴🟡🟣  | |自定义4色|                      |
|   +--------+ +--------+ +--------+                       |
+----------------------------------------------------------+
              ↓ 点卡片
+----------------------------------------------------------+
|  主题页 · "LLM 综述"                                      |
|   ← 返回   [+ 添加论文]  [导出笔记 (v3+)]                 |
|   ---------                                              |
|   论文列表：                                              |
|   ▸ 2412.13678  Clio: Privacy-Preserving...    最近读     |
|   ▸ 2401.04088  Mixtral of Experts             3 天前     |
|   ▸ 2403.05530  Gemini 1.5                      上周      |
|   ---------                                              |
|   色板（只读，显示当前主题的色板规则）：                  |
|   🔴 不懂 · 🟢 赞同 · 🔵 课题 · 🟣 质疑 · 🟡 重点 · ⚪ 待查 |
+----------------------------------------------------------+
              ↓ 点某篇论文
+----------------------------------------------------------+
|  阅读页（v2-b 结构 + 1 处调整）                           |
|   ← 主题  论文标题   [⌕ 搜] [- / -]                      |
|   -------------+--------------------                     |
|    PDF + 高亮  |   thread + chat                          |
|                |   * 顶部 1 行小提示："色板：主题 LLM 综述"|
|                |     hover 显示完整色板（提示不可改）    |
+----------------------------------------------------------+
```

**关键设计**：阅读页色板按钮**不动**，但 hover 色板时多一行 tooltip：「定义于主题创建时，不可修改」。这是隐性的"冻结提示"，比加锁图标轻。

### B.2 新建主题流程

```
Landing → 点 [+ 新建主题]
  ↓
+-----------------------------------------+
|  新建主题 · Step 1/2 起名               |
|  名字: [_______________________]        |
|  e.g. "LLM 综述" / "我的博士开题"        |
|  [取消]                  [下一步 →]      |
+-----------------------------------------+
  ↓
+-----------------------------------------+
|  新建主题 · Step 2/2 定义色板（基于默认）|
|  ⚠ 锁定后不可修改。                      |
|  ---------                              |
|  +----------------------------------+   |
|  | 🔴 [_red______] [不懂_______]    |   |
|  | #fca5a5  prompt提示:             |   |
|  | +------------------------------+ |   |
|  | | 用户对此处不懂 → 详细解释... | |   |
|  | +------------------------------+ |   |
|  |                          [- 删除]|   |
|  +----------------------------------+   |
|  ... 5 条类似                            |
|  [+ 加一种颜色]                          |
|  ---------                              |
|  [取消]   [恢复默认]   [创建主题 →]      |
+-----------------------------------------+
```

**MVP 简化**：emoji 用 emoji-mart picker 太重（30KB+），先固定 6 个默认 emoji 不让改，只让改 label + color + promptHint + 增删行。后续 v4 再加 emoji picker。

> **决策点 G3**：emoji 这一期到底允不允许改？

---

## C. Caching 策略

### C.1 system message 拼接顺序

v2-b 现状（server.py L53-55）：
```
system_content = SYSTEM_PROMPT + "\n\n## 当前论文全文\n\n" + pdf_text
```

v3 改成 3 段：
```
system_content =
    SYSTEM_PROMPT_BASE          // system_prompt.md（不含具体颜色定义，见 G5）
  + "\n\n## 颜色规则\n"
  + palette_rules               // 当前 topic 的色板 → 文本（稳定）
  + "\n\n## 当前论文全文\n\n"
  + pdf_text
```

`palette_rules` 由 topic.palette 生成，格式：
```
- 🔴 不懂 / 请详解：用户对此处不懂 → 详细解释，假设无基础
- 🟢 赞同 / 简短确认：用户赞同此处 → 简短确认或补充延伸
...
```

### C.2 跨论文 caching 命中条件

DeepSeek / Qwen / Kimi 的 cache 是**前缀完全匹配**（hash 前 N 个 token）。所以命中条件：

| 切换场景 | system_prompt | palette_rules | pdf_text | 缓存命中 |
|---|---|---|---|---|
| 同一篇论文 + 同主题，多轮对话 | ✅ | ✅ | ✅ | **完全命中**（v2-b 已实现） |
| 同主题内换一篇论文 | ✅ | ✅ | ❌ | **前缀命中**（system + palette 部分免费） |
| 切到另一主题（色板不同） | ✅ | ❌ | ❌ | 几乎全失效 |
| 改 system_prompt.md（升级版本） | ❌ | - | - | 全失效（合理代价） |

**关键洞察**：同主题内换论文，约 1.5K~2K token 的 system + palette 前缀仍命中，省 90%。这是把主题描述成"研究流容器"的技术红利。

### C.3 失效控制

- 主题色板创建后**任何路径都不能 mutate**（前端 UI 灰掉，后端不接受任何 update API）
- "改色板" = "新建主题"，强制用户认知到这是**新的缓存域**
- API 调用前可 `console.debug` 输出 cached system 的 hash 前 8 位，方便调试时确认命中

### C.4 前端发请求字段调整

```js
// 当前
fetch("/api/chat", { body: JSON.stringify({ messages, pdf_text }) })

// v3：让后端拿到 palette
fetch("/api/chat", { body: JSON.stringify({
  messages,
  pdf_text,
  palette: currentTopic.palette,   // 后端拼到 system_content
})})
```

**注意**：palette 的字段顺序要在序列化时**保证稳定**（按 key 字典序排序后 JSON stringify），否则就算内容相同也会因为 key 顺序不同导致前缀字节序列不同 → cache miss。

---

## D. 引用回链协议（Trace-Back Citations）

### D.1 输出格式抉择

| 选项 | 格式 | 优点 | 缺点 |
|---|---|---|---|
| A. 极简 | `〔p.5〕` | LLM 输出短、稳定；前端解析正则 1 行 | 点击只能跳页 |
| B. 带原文 | `〔p.5 · "原文片段"〕` | 点击可精确定位（PDFFindController.findController） | LLM 偶尔会改原文（同义词替换） |
| C. 混合 | 让 LLM 自由选 | 灵活 | 解析复杂 |

**推荐 MVP = A**（〔p.N〕跳页 + hl-flash 动画），B 留到 v3.1 做精确定位。

> **决策点 G2**：A vs B vs A 先做后续升级 B？

### D.2 渲染流程

```
agent stream → fullText 累积
  ↓
renderAssistant(el, fullText)
  ↓ marked.parse(text)   ← 当前流程
  ↓ post-process：把 〔p.N〕 → 渲染为 <a class="cite-link" data-page="N"> 元素
  ↓ 用 DOMParser 或在 marked 输出的 HTML 字符串上做受控 replace（只替换匹配 〔p.N〕 的 token）
```

**关键实现细节**：

1. 用 **post-process** 而不是 marked custom renderer。原因：marked 的 inline token 只在 markdown 语法里触发，`〔...〕` 不是 markdown，定义 inline rule 反而复杂；post-process 用正则在 marked 之后扫一遍 HTML 字符串就行。

2. 正则：`/〔p\.(\d+)〕/g`（注意是中文方括号 `〔〕` U+3014/U+3015，避开 markdown 的 `[]`）。

3. 替换 token（受控、纯静态结构，无 user-injected HTML）：
   ```
   <a class="cite-link" data-page="${n}" title="跳到第 ${n} 页">〔p.${n}〕</a>
   ```
   只有 `${n}` 是动态值，且来自正则 `(\d+)` 捕获组，已经被约束为纯数字 → 无 XSS 面。marked 自身已对 LLM 输出做了 HTML escape，所以 post-process 阶段我们在 marked 输出之后再 replace 是安全的。

4. 事件委托：在 `els.chatMessages` 上挂一个 click handler 监听 `.cite-link`，提前避免每条消息重复绑定。

### D.3 点击行为

```js
els.chatMessages.addEventListener("click", (e) => {
  const link = e.target.closest(".cite-link");
  if (!link) return;
  e.preventDefault();
  const page = parseInt(link.dataset.page, 10);
  if (!page || !state.pdf) return;
  pdfViewer.scrollPageIntoView({ pageNumber: page });
  // 闪一下该页（复用 v2-b 的 hl-flash 思路：临时给 .page 加 class）
  flashPage(page);
});

function flashPage(page) {
  const pageEl = els.viewer.querySelector(`.page[data-page-number="${page}"]`);
  if (!pageEl) return;
  pageEl.classList.add("page-flash");
  setTimeout(() => pageEl.classList.remove("page-flash"), 900);
}
```

`.page-flash` CSS：边框淡入淡出 + 极轻背景色脉冲，900ms 完成，不打扰阅读。

### D.4 system_prompt 怎么让 agent 自然吐这种格式

需要在 system_prompt 加一段：

```
## 引用规范（强制）
凡是你回答里提到论文里的具体观点 / 数字 / 引文 / 实验结果，必须紧跟一个回链标记：
〔p.N〕  ← N 是该内容所在的页码

示例：
✅ 论文在 Section 3 提出了三阶段流水线〔p.5〕，整体吞吐量提升 2.3 倍〔p.8〕。
❌ 论文提出了一个三阶段流水线，吞吐量提升 2.3 倍。

不引用的内容（你自己的总结、推理、提问）不要加回链。
```

**这是改 system_prompt.md 的事，由我决定要不要改**（见 G5）。

---

## E. 迁移 / 兼容

### E.1 v2-b 现有数据状况

- IDB v1 只有 `annotations` store
- 每个用户可能在多个 PDF 上累积了若干 ann（v2-b 测试场景：1 篇 ann ~ 几十条）
- annotation 自身没有 topicId / pdfKey 字段（pdfKey 是 IDB 的 key，没存在 value 里）

### E.2 迁移选项

| 选项 | 行为 | 优点 | 缺点 |
|---|---|---|---|
| **A. 自动归入"默认主题"** | onupgradeneeded v1→v2 时建一个 `id=default` 的主题（用默认色板），扫所有 annotations 给每条加 `topicId='default'` + `pdfKey=fromIdbKey`，PDF 列表用 annotations 的 key 集合反推 | 用户无感知，老数据继续可用 | "默认主题"的色板是默认的；如果用户 v2-b 时心里有别的色板想法，会有错配 |
| B. 手动选 / 重建 | 第一次打开 v3 弹个迁移向导，让用户给每个 PDF 选主题 | 干净 | 单用户的 alpha 阶段没必要弹向导 |
| C. 兼容模式 | 老数据无 topicId，列表里单独显示"未归类"区 | 渐进 | 数据模型变成两套（有/无 topicId），代码复杂度上升 |

**推荐 A**。`co-read` 还是个人 alpha，简单稳。Migration 函数大致：

```js
// onupgradeneeded
if (oldVersion < 2) {
  const annStore = tx.objectStore("annotations");
  const topicsStore = db.createObjectStore("topics", { keyPath: "id" });
  const pdfsStore = db.createObjectStore("pdfs", { keyPath: "pdfKey" });
  // 建默认主题
  const defaultTopic = {
    id: "default", name: "默认主题",
    palette: DEFAULT_PALETTE, paletteFrozenAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    pdfKeys: [],
  };
  // 扫现有 annotations，给每条加 topicId + pdfKey，并攒 pdfKeys
  annStore.openCursor().onsuccess = (e) => {
    const cur = e.target.result;
    if (!cur) {
      defaultTopic.pdfKeys = [...seenPdfKeys];
      topicsStore.add(defaultTopic);
      return;
    }
    const pdfKey = cur.key;
    const list = cur.value.map(a => ({ ...a, topicId: "default", pdfKey }));
    seenPdfKeys.add(pdfKey);
    pdfsStore.add({ pdfKey, title: deriveTitleFromKey(pdfKey), topicId: "default", addedAt: new Date().toISOString() });
    cur.update(list);
    cur.continue();
  };
}
```

`deriveTitleFromKey`：`file:foo.pdf:12345` → `foo.pdf`；`url:https://arxiv.org/pdf/2412.13678` → `2412.13678`。粗糙但够 alpha 用。

> **决策点 G1**：A/B/C 选哪个？

---

## F. 工程量估算

> 行数都是 ±20% 的粗估，作为"心理预期校准"用。

| 模块 | 文件 | 估算行数 | 备注 |
|---|---|---|---|
| F1. Topic / PdfMeta / 新 schema 数据层 | `app.js` IDB 重构 + 新 store + 迁移 | **~250** | openIdb 升级、loadTopics/saveTopic/loadPdfList、上面 E.2 的迁移逻辑 |
| F2. 主题列表 UI（landing 改造） | `index.html` + `app.js` + `style.css` | **~180** | 卡片网格、空态、点卡片切换 view |
| F3. 新建主题流程（2 step modal） | `index.html` + `app.js` + `style.css` | **~280** | 起名 step、色板编辑 step、+/− 颜色行、color picker（用 `<input type="color">` 零依赖） |
| F4. 主题页（PDF 列表 + 添加论文） | `index.html` + `app.js` + `style.css` | **~200** | 列表、+ 添加论文复用 landing 的 loadForm |
| F5. 阅读页接 topic 上下文 | `app.js` | **~120** | currentTopic 状态、色板按钮根据 topic.palette 动态生成、chat fetch 带 palette、tooltip 提示 |
| F6. Server caching 注入升级 | `server.py` | **~30** | 接 palette 字段、拼到 system_content |
| F7. 引用回链 marked 后处理 + click | `app.js` + `style.css` | **~80** | 正则 post-process、cite-link click handler、page-flash CSS 动画 |
| F8. Thread 持久化（v2-c 任务并到 v3） | `app.js` | **~120** | saveThreads / loadThreads / 切论文时 hydrate / debounce 写入 |
| F9. annotation 加 topicId + pdfKey 字段 + 验证 color ∈ palette | `app.js` | **~60** | createAnnotation 改造 + 防御性校验 |
| F10. 迁移函数（v1 → v2） | `app.js` | **~80** | E.2 的 migration 实现 |
| **合计** | | **~1400 行净增** | 当前 app.js 是 1204 行 → v3 后 ~2400 行（建议达到 2500 时就要考虑拆文件了） |

**风险**：app.js 单文件 2400 行接近"单文件可读性边界"。**建议**：F2 + F3 + F4 这一块独立成 `topics.js`（约 660 行）模块化处理，主 `app.js` 还在 1700 行左右。这是非必要勿增实体的一次必要权衡——按 CLAUDE.md 约束 #2 默认偏好 inline，但单文件 2500+ 行的可维护性代价超过了"少一个文件"的红利。

---

## G. 关键决策点

### G1. 数据迁移路径（A/B/C）
推荐 **A 自动归入"默认主题"**。理由：alpha 阶段、单用户、老数据规模小、无感知最优。**定这么做**。

### G2. 引用回链格式：`〔p.N〕` 还是 `〔p.N · "原文"〕`
推荐 **MVP 用 A `〔p.N〕`**（跳页 + flash），B 留到 v3.1。理由：A 实现 80 行，B 需要接 findController + 文本匹配容错 + 跨页选区拼接 ~ 多 200 行；A 已经解决 90% 信任问题。

### G3. 新建主题时 emoji 允不允许改
推荐 **MVP 不允许，固定 6 个默认 emoji**（红绿蓝紫黄灰）。emoji-mart picker 30KB+ 不划算。**让用户改的是 label / color / promptHint / 增删行**。这 6 个 emoji 够用，定这么做。

### G4. 默认色板要不要在现 6 色基础上调整
当前 6 色已被 PRODUCT_HIGHLIGHTS 写进营销话术（"六种颜色，六种 AI 人格"），改 = 改宣传。**推荐保持现 6 色**，label / promptHint 用现 system_prompt.md 里的文案。

### G5. system_prompt.md 要不要改 ★ 最关键
当前 system_prompt.md 直接把"🔴 红：详细解释 / 🟢 绿：简短确认 / ..." 写死在 prompt 里。v3 让用户自定义色板后，**会和 prompt 里的硬编码冲突**。

三个走向：
- **走向 X**：system_prompt.md 不动，颜色规则**走 palette_rules 注入**——但 prompt 里那一段硬编码颜色定义会"重复"。问题：LLM 看到两套规则可能困惑，且用户改了 prompt 里没改到的颜色（如新增 black "🖤"）也无效。
- **走向 Y**：system_prompt.md **删掉颜色定义那段**（L16-22），改成"用户的颜色语言由色板规则附加，请按色板提示回应"。然后 palette_rules 注入是唯一权威来源。
- **走向 Z**：维持现状，v3 默认色板与 prompt 完全对齐就不会冲突（用户自定义只能改 label/promptHint，颜色 key 不变）。

**架构师建议走 Y**（解耦设计原则、配置驱动）。但这是改 system_prompt.md，**严格按 architect.md 的纪律：subagent 不动 system_prompt.md，必须由我（PM）决定**。

> v3 上线时我需要决定走 X / Y / Z。如果选 Y，我会亲自改 system_prompt.md（删 L16-22 的 6 色定义，留一段"按色板规则回应"的元规则），不让 subagent 代笔。

### G6. 主题级笔记导出（v3+）现在要规划吗
PRODUCT_HIGHLIGHTS 已写"一个主题 = 一组论文 + 一套冻结色板 + 一份导出笔记"。**MVP 建议占位 + 灰按钮**：主题页放 `[导出笔记 (即将推出)]` 按钮，点击 toast「v3.1 见」。**理由**：让用户感知到容器的形状是完整的；具体导出格式（按颜色聚合？按 PDF 聚合？带原文 quote？）需要等 v3 用一段时间再设计。

### G7. 主题列表为空时 landing 默认行为
用户打开 v3 第一次（迁移完成后），是看到 1 个"默认主题"卡片 + 提示「点这里继续」，还是直接进入唯一主题的主题页？**推荐前者**——3 层导航的认知一致性优先于"少一次点击"。

### G8. v2-b 单击 hl-rect 的 UX 决策（v2-b 报告留的尾巴）
v2-b 测试报告 P49-53 留了个问题："单击 = 仅浮气泡" 还是 "单击 = 切 thread"。v3 不解决这个，**继续沿用 v2-b 现在的"仅浮气泡"行为**。用户使用中如果感觉不爽，再单独提 issue。

---

## H. v3 不做的事（边界）

- 不引入框架（vanilla 到底）
- 不拆 server.py（仍是 3 endpoint + 静态 dispatcher 一锅煮）
- 不做主题间论文移动（建错主题就重建）
- 不做主题级搜索 / 全主题搜索（v2-b 的页内搜索够用）
- 不做协作 / 分享 / 云同步（本地 IDB 优先）
- 不做色板模板市场 / 导入导出（YAGNI）
- 不做 thread 重命名（label 由代码生成，不让用户改）

---

## I. 验收 checklist 草稿（给 test subagent 后用）

> 还没到 test 阶段，先草拟一个，审稿时可挑刺。

### P0 主题流转
- [ ] Landing 显示主题列表
- [ ] 新建主题 step1 → step2 → 创建成功后跳进新主题
- [ ] 色板锁定后不可改（DOM 无编辑入口 + API 拒绝）
- [ ] 添加论文 → 出现在主题 PDF 列表 → 点进去能读

### P1 Caching 验证
- [ ] 同主题内打开第 2 篇论文：浏览器 devtools 看请求 body 的 system 部分前缀字节序列等于第 1 篇
- [ ] palette key 顺序按字典序稳定序列化（写一个 console.assert）

### P2 引用回链
- [ ] agent 回复里 `〔p.5〕` 被渲染成可点击链接
- [ ] 点击 → PDF 滚到第 5 页 + flash 动画
- [ ] 页码超出范围（如 `〔p.999〕`）：链接照常渲染但点击 no-op，console.debug 记录

### P3 迁移
- [ ] v2-b 现有 IndexedDB（含 annotations）打开 v3 → 自动建"默认主题"+ 所有老 ann 归入
- [ ] 迁移后老 ann 还能正常显示 + 删除 + 引用

### P4 边缘 case（CLAUDE.md 约束 #4）
- [ ] 创建主题时 name 为空 → 按钮 disabled
- [ ] 色板编辑时删到只剩 0 行 → 按钮 disabled（至少留 1 色）
- [ ] 主题列表 50+ 卡片：grid 不卡
- [ ] 同一个 PDF 想加进两个主题：拒绝（pdfKey 唯一，第一个主题"先到先得"）→ 提示用户
- [ ] 切论文时正在 streaming → abort 复用 v2-b 逻辑
- [ ] 改 system_prompt.md 重启后：缓存失效是预期，不报错

---

## J. 实施顺序建议（敏捷拆分）

不建议一口气 1400 行 PR。按依赖分 4 个 PR：

1. **v3-α 数据层**（F1 + F10）：~330 行；只跑迁移和 IDB schema，UI 上看不出区别（老用户老体验）。能 demo："打开 devtools 看 IDB 多了 topics / pdfs store + annotations 加了 topicId"。
2. **v3-β 主题 UI**（F2 + F3 + F4）：~660 行；landing 改造 + 新建主题 + 主题页。这一步阅读页还没接 palette。
3. **v3-γ caching + 阅读页接 topic**（F5 + F6 + F9）：~210 行；阅读页色板按钮变成动态、chat 带 palette 给后端。
4. **v3-δ 回链 + thread 持久化**（F7 + F8）：~200 行；最后两件锦上添花。

每个 PR 测试通过再进下一个。

---

## K. 风险登记

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| IDB 迁移失败导致老数据丢 | 中 | 高 | 迁移前 dump 一份 annotations 到 console.log（用户能复制兜底）；onerror 时 fallback 到只读模式不破坏数据 |
| palette JSON 序列化字段顺序不稳 → cache miss | 中 | 中 | 写一个 stablestringify 工具函数，按 key 排序 + Object.keys 排序 |
| `〔p.N〕` 在选区拷贝时被一起复制污染笔记 | 低 | 低 | CSS 加 `user-select: none` 给 .cite-link（用户复制 markdown 时不带 N） |
| LLM 不按格式吐回链 / 吐成 `[p.5]` / 中英括号混 | 中 | 中 | 正则容错：`/[〔\[](p\.?|页)\s*(\d+)[〕\]]/gi`；prompt 里给反例（D.4） |
| 单文件 app.js 突破 2400 行可读性下降 | 中 | 中 | F2~F4 提到 topics.js（约 660 行）拆出去 |
| 对走向 Y 不放心 → 三套规则共存（X） | 中 | 中 | 实现时先按 Z（默认色板对齐）做，Y 改 prompt 待我拍板 |

---

## L. 结语

v3 的核心是把 co-read 从"工具"升级成"容器"。**容器的边界 = 颜色语言的边界 = caching 的边界 = 笔记的边界**——这四件事在同一个 Topic 概念下统一。这是个值得做的抽象，但实施代价（~1400 行）也是真实的。

按 CLAUDE.md 的 6 条约束盘一下：
- ✅ caching 第一：色板冻结正是为前缀稳定服务
- ✅ 非必要勿增实体：只加了"主题"这一层，没引框架、没加路由库、没换 stack
- ✅ 架构师判断：palette_rules 注入是配置驱动，prompt 与色板解耦（走向 Y）
- ✅ 边缘 case：迁移 / 空状态 / 名字冲突都列了
- ✅ 控制成本：跨论文 caching 命中是直接利好
- ✅ 敏捷：J 节拆成 4 个 PR，每个能 demo

**G1~G8 确认后 → 主 Claude 拆任务给 dev → test 按 I 节验收**。
