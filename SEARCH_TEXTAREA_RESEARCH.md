# Co-Read 搜索 + Textarea 调研（2026-05-19）

> Architect subagent 产出，仅作调研 + 推荐，**未改任何代码**。
> 范围：(A) PDF 搜索 UX 对标 + MVP 推荐；(B) chat textarea auto-grow 对标 + 推荐。
> 当前实现速览：
> - **搜索**：findBar 顶部条（input + status `n/m` + ‹ › ×），⌘F 触发，`highlightAll: true` 硬编码，无 case/whole-word/results 列表（`app.js:448-502`、`index.html:149-162`）。
> - **textarea**：`resize: vertical`，`min-height: 44px / max-height: 240px`，rows="2"，用户拖手柄改高（`style.css:637-650`）。

---

## A. PDF 搜索 UX 调研

### A.1 对标产品

#### Adobe Acrobat Reader
- **触发**：`Cmd/Ctrl+F` 打开顶部 **Find toolbar**（窄横条，悬浮在工具栏下方）；`Shift+Cmd+F` 打开 **Advanced Search**（独立可拖窗口，含完整选项 + 结果列表）。
- **Find toolbar 字段**：输入框 + 上一个/下一个 + 「…」省略号菜单（折叠次要选项：Match Case、Whole Word、Include Bookmarks、Include Comments、**Replace With**）。
- **Advanced Search 窗口**：独立 modal，含 scope（当前 PDF / 文件夹 / 索引）、phrase / any words / all words / stemming / proximity、case-sensitive、whole-words、metadata 过滤；**结果以树状列表显示**（每项含上下文片段，点击跳转）。
- **持久化**：上次的查询字符串 session 内保留。

#### Foxit Reader
- **触发**：`Cmd+F` 快速搜索（toolbar input） / `Shift+Cmd+F` 高级搜索面板。
- **高级搜索面板（侧边或独立）**：
  - Scope：当前 PDF / 文件夹 / portfolio / 全文索引。
  - Match：exact phrase / any words / all words / stemming / pattern (phone/SSN/email)。
  - Filters：**Case-Sensitive**、**Whole Words Only**、include comments / bookmarks / attachments、proximity（N 词内）。
  - Metadata：作者、创建日期、subject。
- **结果**：**tree view**，含上下文 + `+` 展开 + 按日期/文件名/位置排序。点击跳转。

#### PDF Expert（Mac）
- **触发**：右上角搜索框 / `Cmd+F` / 工具栏搜索按钮。
- **位置**：**侧边栏**呈现（"搜索结果 + 编辑工具栏合并在 sidebar，主屏幕保持干净"）。
- **特点**：跨 tab 搜索（"All Tabs"）；**搜索历史**保留最近查询；点击结果跳页。
- **字段较精简**：input + 结果列表为主，无显式 case/whole-word toggles（默认大小写不敏感）。

#### macOS Preview
- **触发**：`Cmd+F` 或右上搜索框。
- **极简**：input + 滚动结果列表（左侧 sidebar 显示匹配段落 + 页码 + 上下文 snippet）。
- **字段**：仅 input。**默认大小写不敏感**，无 toggle。无 whole-word、无 regex。
- **特点**：所有匹配自动高亮，点击结果项跳到该页并 focus 匹配处。

#### mozilla/pdf.js 官方完整 viewer
- **触发**：`Cmd/Ctrl+F` 或 toolbar 找按钮（放大镜 icon）打开 findbar。
- **findbar 位置**：toolbar 下方横条（与我们当前实现一致）。
- **字段（完整版多于当前 co-read 实现）**：
  - input + 上一个/下一个
  - **Highlight All** checkbox
  - **Match Case** checkbox
  - **Match Diacritics** checkbox（变音符号匹配，主要给西欧/学术论文）
  - **Whole Words** checkbox
  - 状态："X of Y matches" / "Phrase not found" / "More than 1000 matches"
- **无结果列表**：靠 highlight all + 上一个/下一个翻匹配。
- **持久化**：input 内容 session 内保留（关闭 bar 不清空）；checkbox 状态保留。

---

### A.2 共同模式（行业共识）

| 模式 | Adobe | Foxit | PDF Expert | Preview | pdf.js |
|------|-------|-------|------------|---------|--------|
| `Cmd+F` 触发 toolbar | ✓ | ✓ | ✓ | ✓ | ✓ |
| 上一个/下一个按钮 | ✓ | ✓ | ✓ | ✓ | ✓ |
| `n / m` 状态显示 | ✓ | ✓ | ✓ | ✓ | ✓ |
| Highlight all（全文高亮）| ✓ | ✓ | ✓ | ✓ | ✓（可关）|
| Case-sensitive toggle | ✓ | ✓ | – | – | ✓ |
| Whole-word toggle | ✓ | ✓ | – | – | ✓ |
| 结果列表（侧栏含 snippet）| ✓（advanced）| ✓ | ✓ | ✓ | – |
| 高级搜索独立窗口 | ✓ | ✓ | – | – | – |
| 替换（replace） | ✓ | ✓（编辑器版）| – | – | – |
| 持久 input/options（session）| ✓ | ✓ | ✓ | ✓ | ✓ |
| `Esc` 关闭 | ✓ | ✓ | ✓ | ✓ | ✓ |
| `Enter` = 下一个 / `Shift+Enter` = 上一个 | ✓ | ✓ | ✓ | ✓ | ✓ |

**关键洞察**：
1. **Cmd+F + 顶部 findbar 是公认默认**，没有产品把基础查询藏到侧栏。
2. **结果列表（含 snippet）是"重型搜索"的标配**，Preview/PDF Expert 用 sidebar 把它做轻；Adobe/Foxit 给到独立窗口做"档案级"搜索。
3. **Case + Whole-Word 是基础线**——只有 Apple 系（Preview/PDF Expert）省略了，因为他们的目标用户是普通人；pdf.js / Adobe / Foxit（开发者/重度用户）都给。
4. **Match Diacritics** 是 pdf.js 独有的细节，**对研究者读论文（含希腊字母、变音）有用**。
5. **session 内保持 input value 是普遍约定**——co-read 当前 `closeFindBar` 把 input 清空，**反人类**（关了再开还要重打一遍）。

---

### A.3 推荐给 co-read 实施的 MVP 模式

**鸭鸭场景**：研究者读论文，常搜术语 / 作者名 / 公式符号，跨页跳转。当前实现"input + n/m + 上下 + ESC"已覆盖 70%，缺以下高频痛点：

#### MVP（强烈推荐，工程量小）

1. **`Esc` 关闭 → 保留 input value**（仅隐藏 bar；下次 `Cmd+F` 重开恢复内容并 select-all）
   - 代码改动：`closeFindBar()` 不再 `els.findInput.value = ""`；改用 session-only 变量。
   - 工程量：5 分钟。

2. **Match Case** + **Whole Words** 两个 checkbox
   - 在 findBar 内加两个紧凑 toggle（如 `Aa` / `[w]` 文字按钮，pdf.js 风格）。
   - `eventBus.dispatch("find", { caseSensitive, entireWord, ... })` 已经支持，**只需 wire UI 到现有 dispatch**。
   - 工程量：15 分钟。

3. **`Enter` / `Shift+Enter` 翻匹配**（input 在焦点时）
   - 当前点击 ‹ › 按钮，键盘流不顺；行业默认 `Enter` = next、`Shift+Enter` = prev。
   - 工程量：5 分钟。

4. **Match Diacritics**（pdf.js 已经支持，dispatch 加一个字段）
   - 对论文里 `naïve` / `Müller` / `α` 等很有用。
   - 可作为 checkbox 也可作为**默认 true**（用户感知更"聪明"）。
   - 工程量：5 分钟。

#### 推荐做的"轻度结果列表"（中等收益，中等工程量）

5. **`Cmd+G` / `Cmd+Shift+G` 系统快捷键**（Mac 标准 "find next / prev"）
   - 即使 findBar 关了也能继续翻匹配。
   - 工程量：10 分钟。

6. **匹配数过多时显示 "1000+ matches"**（pdf.js 内置 limit，目前直接显示 `total`，超 1000 会显示 1000）
   - 工程量：5 分钟（仅文案优化）。

#### **不要做的（避免功能膨胀，违反约束 #2）**

- ❌ **侧栏结果列表 with snippet**：实现复杂（需要 hook pdf.js 内部 `_matches` + 取页文本上下文 + 跨页拼），收益对研究者不大（高亮 + 翻匹配已经够用）。延后到鸭鸭明确说"翻匹配太慢看不到全貌"再做。
- ❌ **替换（replace）**：co-read 是只读伴读器，**不编辑 PDF**。
- ❌ **高级搜索独立窗口 / 多文档搜索 / 正则**：co-read 同一时刻一篇论文，scope 单一；正则属于"杀鸡用牛刀"。
- ❌ **搜索历史下拉**：session 保留 input 已经够用；持久化历史要存 localStorage + UI 下拉，复杂度高。
- ❌ **stemming / proximity / phrase 模式**：学术搜索引擎职责，不该塞进伴读器。

---

## B. Textarea Auto-grow 调研

### B.1 对标产品

| 产品 | 实现 | min/max | 行为 |
|------|------|---------|------|
| **ChatGPT** | scrollHeight + JS（无第三方）| min ~52px / max ~200px | 内容增长自动变高；超 max 出现内部滚动条；**无手柄**；`Enter` 发送、`Shift+Enter` 换行 |
| **Claude.ai** | scrollHeight + JS（类似）| min ~56px / max ~50vh | 同 ChatGPT；focus 时 outline；上传 chip 在 textarea 上方独立栏 |
| **Slack** | scrollHeight + JS | min 1 行 / max ~50% 视口 | 同；rich text 编辑用 contenteditable（Lexical），但**纯文本场景仍是 scrollHeight 模式** |
| **Notion** | contenteditable div（不是 textarea）| – | 整页编辑场景，不适合 chat input |
| **Linear** | scrollHeight + JS | 类似 | 同 |

**结论**：**主流 chat input 一致用 `textarea + input 事件 + scrollHeight` 派**，没人用 mirror div / CSS grid trick（虽然技术可行）；contenteditable 只在富文本编辑器才用。

### B.2 实现模式对比

#### 模式 1：scrollHeight 监听（行业主流，推荐）

```js
ta.addEventListener("input", () => {
  ta.style.height = "auto";          // 先塌缩，让 scrollHeight 准确反映内容
  ta.style.height = ta.scrollHeight + "px";
});
```

CSS：
```css
textarea {
  resize: none;        // 去掉手柄
  overflow-y: hidden;  // 没到 max 时隐藏滚动条
  min-height: 44px;
  max-height: 240px;
  box-sizing: border-box;  // 必须，否则 height = scrollHeight + padding 每次增高
}
/* 到 max 后让内部滚动 */
textarea { overflow-y: auto; }  // 也可一直 auto，没达 max 时 scrollHeight 不会触发滚动条
```

**优点**：
- ~5 行 JS + ~5 行 CSS，无依赖。
- 实时、精准（浏览器自己算）。
- `box-sizing: border-box` 解决 padding 重复累加问题。

**缺点**：
- **每次 input 触发一次 reflow**（先 height=auto → 读 scrollHeight → 写 height）。大量长文本下可见微小抖动，但 chat 场景（用户打字速度）无感。
- 初次渲染 + value programmatic 设值（如 切 thread 灌入草稿）需要**手动触发一次 resize**。
- Firefox/Safari 行高微差：用 `box-sizing: border-box` + 明确 `line-height` 可规避。

#### 模式 2：CSS Grid 镜像（CSS-Tricks 推荐，新兴）

```html
<div class="grow-wrap" data-replicated-value="">
  <textarea></textarea>
</div>
```
```css
.grow-wrap { display: grid; }
.grow-wrap::after {
  content: attr(data-replicated-value) " ";
  white-space: pre-wrap;
  visibility: hidden;
}
.grow-wrap > textarea,
.grow-wrap::after {
  grid-area: 1 / 1;  // 重叠
  font: inherit; padding: inherit; border: inherit;
}
```
```js
ta.addEventListener("input", () => {
  ta.parentNode.dataset.replicatedValue = ta.value;
});
```

**优点**：
- **无 reflow 双跳**——`::after` 撑开 grid，textarea 跟随，更平滑。
- 不会有 height=auto 的瞬间塌缩闪烁。

**缺点**：
- **多一层 wrapper DOM**（破坏当前 `.chat-form` 的 flex 布局，需重排）。
- 字体/padding/border 必须**严格同步**，否则镜像和真 textarea 高度对不上。
- 当前 co-read 用了 flex，wrap 改 grid 牵连其他样式。
- 收益（无闪烁）对 chat 场景很小，**用户感知不强**。

#### 模式 3：原生 CSS `field-sizing: content`（2024+ Chrome only）

```css
textarea { field-sizing: content; min-block-size: 3lh; max-block-size: 12lh; }
```

**优点**：一行 CSS，浏览器原生处理，无 JS。
**缺点**：**Firefox / Safari 暂不支持**（截至 2025 中），生产环境不能单独依赖；作为 progressive enhancement 可叠加。

#### 模式选择

**推荐模式 1（scrollHeight + JS）**：
- 项目纪律是 vanilla JS、扁平、不增实体（约束 #2）→ 模式 1 改动最小，**不动 HTML 结构、不动 flex 布局**。
- 当前 `.chat-form textarea` 已有 `min-height: 44px / max-height: 240px` → 留住，只去掉 `resize: vertical` + 加 `overflow-y: auto`。
- 模式 2 要重排 HTML 嵌套，违反"非必要勿增实体"。
- 模式 3 作为 future enhancement，可在 CSS 里加 `field-sizing: content` 做渐进增强（不依赖它）。

### B.3 推荐给 co-read 的 vanilla JS 实现

#### CSS 改动（`style.css:637`）
```css
.chat-form textarea {
  flex: 1;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px 12px;
  font-family: inherit;
  font-size: 14px;
  /* v4：auto-grow，去掉手柄 */
  resize: none;
  min-height: 44px;
  max-height: 240px;
  overflow-y: auto;           /* 到 max 后内部滚动 */
  outline: none;
  background: var(--surface);
  box-sizing: border-box;     /* 关键 */
  /* progressive enhancement: 2026 后 Firefox/Safari 跟进可走原生 */
  /* field-sizing: content; */
}
```

#### JS 改动（在 `app.js` 初始化处加 ~10 行）
```js
// auto-grow chat textarea（替代 resize: vertical 手柄）
const ta = els.chatInput;
function autoGrow() {
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 240) + "px";
}
ta.addEventListener("input", autoGrow);
// 切 thread / 清空 / programmatic setValue 后手动触发
// （在现有的 "切 thread 后 textarea 清空" 那行后加一次 autoGrow()）
```

**关键边缘 case（约束 #4，半夜工程师视角）**：
1. **粘贴 5000 字** → height 一瞬间冲到 max，超出部分内部滚动。✓ 已处理。
2. **切 thread 清空** → 现有 `els.chatInput.value = ""` 不触发 input 事件 → 手动 `autoGrow()` 收回 min-height。
3. **disabled 状态**（流式中）→ `disabled` 不阻止 height 计算，已有内容仍占高度，OK。
4. **极小窗口/移动端** → max-height: 240px 占满 chat 时仍能滚 chatMessages，不会卡死。
5. **IME 中文输入法 composing** → `input` 事件包含 composition 阶段，正常触发，行为符合预期。
6. **粘贴后立即按 Enter 发送** → handleSubmit 后 `value=""` + 手动 `autoGrow()` 收回；现有 submit 逻辑里要加这一行。

---

## C. 综合建议给主 Claude

### C.1 优先级（按 ROI 排序）

| # | 项 | 工程量 | 用户感知 | 优先 |
|---|----|--------|---------|------|
| 1 | textarea auto-grow（scrollHeight）+ 去手柄 | 15 min | 高（每次发消息都遇到）| **P0** |
| 2 | findBar 关闭保留 input value | 5 min | 中（关了再开省一次打字）| **P0** |
| 3 | findBar 加 `Enter`/`Shift+Enter` 翻匹配 | 5 min | 高（键盘流）| **P0** |
| 4 | findBar 加 Match Case + Whole Words checkbox | 15 min | 中（特定场景）| P1 |
| 5 | findBar 加 Match Diacritics（论文场景）| 5 min | 中（有变音字符的论文）| P1 |
| 6 | `Cmd+G` / `Cmd+Shift+G` 全局 find-next/prev | 10 min | 中 | P2 |
| 7 | "1000+ matches" 文案优化 | 5 min | 低 | P2 |

**P0 一次性做完 ~25 分钟**，对鸭鸭日常体感是台阶式提升。

### C.2 工程量总估算

- **textarea auto-grow**：15 min（dev 实施 + 自测）
- **findBar P0 三项**：15 min
- **findBar P1 三项**：25 min
- **合计 P0+P1**：~55 min（一次 dev session 拿下）

### C.3 风险点

1. **textarea auto-grow** 的 `切 thread 清空` 那处必须手动调 `autoGrow()`，否则切完 thread 后 textarea 残留上一个的高度——这是半夜会被坑的点。**dev 实施时必须 grep 所有 `chatInput.value = ""` / `chatInput.value =` 设值处补一次 `autoGrow()`**。
2. **findBar 加 checkbox** 后窄屏布局会拥挤，建议用紧凑的文字按钮（`Aa` / `"w"` / `á`）+ active 态加底色，而非传统大 checkbox。
3. **保留 input value 后**，PDF 切换（新 PDF）应该清空 query 并 dispatch 一次空 find——不然新 PDF 打开后还在搜上一篇的关键词。**dev 实施时在 `loadPdf` 流程里清 findInput**。
4. **`Match Diacritics` 默认值**：建议默认 false（pdf.js 默认值），让用户主动开；默认 true 会让搜 `naive` 搜不到 `naïve`，反直觉。

### C.4 不做（明确边界）

- **不做**侧栏搜索结果列表（功能膨胀，鸭鸭未提需求）
- **不做**搜索历史持久化（YAGNI）
- **不做**替换、正则、多文档、模糊搜索（与 co-read 产品定位不符）
- **不做** textarea 的 mirror div / CSS grid 方案（违反"不增实体"约束）
- **不做** `field-sizing: content` 单独依赖（浏览器支持未到）

---

## 附：参考来源

PDF 搜索：
- [Adobe Acrobat — Searching PDFs](https://helpx.adobe.com/acrobat/using/searching-pdfs.html)
- [Foxit — Advanced Search](https://www.foxit.com/blog/advanced-search-in-foxit-phantompdf/)
- [PDF Expert — Search PDF on Mac](https://pdfexpert.com/features/search-pdf-mac)
- [Preview PDF 搜索（OSXDaily）](https://osxdaily.com/2016/09/10/search-in-pdf-preview-mac/)
- [mozilla/pdf.js find bar 源码](https://github.com/mozilla/pdf.js/blob/master/web/pdf_find_bar.js)

Textarea auto-grow：
- [CSS-Tricks — The Cleanest Trick for Autogrowing Textareas](https://css-tricks.com/the-cleanest-trick-for-autogrowing-textareas/)
- [Stephan Wagner — Vanilla JS auto-resize](https://stephanwagner.me/auto-resizing-textarea-with-vanilla-javascript)
- [Chrome Developers — `field-sizing`](https://developer.chrome.com/docs/css-ui/css-field-sizing)
- [Andarist/react-textarea-autosize](https://github.com/Andarist/react-textarea-autosize)（仅参考 API 形态，不引入）
