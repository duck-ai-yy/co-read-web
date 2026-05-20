# Co-Read Web · E2E 测试 Spec (v3-final)

> e2e test engineer · 2026-05-19
> 视角：用户产品体验全景。不是看代码、是看"读 + 理解 + 整理 + 输出"的闭环。
> 基线：v2-b 22/22 + v3-α 13/13 + v3-β 22/25 + v3-γ 13/13 + v3-δ 12/15
> 样本：arxiv 2412.13678 (Clio 46 页) + arxiv 1706.03762 (Transformer 15 页 跨 PDF 测)
> Server: 127.0.0.1:5050 PID 64393 alive
> Token 预算：≤ 5 chat（DeepSeek 1 元/天）

---

## 维度规约

- **Step**：用户实际动作 / 注入手段
- **Expected**：用户应当看到 / state 应该是什么
- **Severity**：P0（产品 mission 直接受损）/ P1（边缘 case 但鸭鸭关心）/ P2（nice-to-have）
- **Method**：Playwright MCP browser_* / browser_evaluate 注入 / IDB 直读 / DOM inspection / 真实 LLM 调用

---

# A. 核心用户旅程（按产品 Mission "读+理解+整理+输出"）

## A1. 首次进入：空白 IDB → landing 主题列表（默认主题就位）  [P0]

**Step**：
1. 注入 `indexedDB.deleteDatabase("coread")` 模拟全新用户
2. 刷新 `/`
3. 等 bootstrap

**Expected**：
- DB v2/v3 自动创建，4 stores: topics / pdfs / annotations / threads
- topics.default 存在 + palette 6 项 + paletteFrozenAt 时间戳
- DOM：landing view 显示，主题卡片网格至少 1 张"默认主题"卡片
- DOM：[+ 新建主题] 按钮可见
- console errors = 0

**Method**：browser_evaluate 注入清库 + 刷新 + 读 IDB + DOM inspection

---

## A2. 新建主题：起名 → 编辑 palette → 确认冻结  [P0]

**Step**：
1. 点 [+ 新建主题] → step 1
2. 输入主题名"E2E-测试主题-2026"
3. 点 [下一步 →] → step 2
4. 改第 1 行 label 从"看不懂"→"E2E-A"
5. 改第 2 行 color hex 从默认绿 → `#ff00aa`
6. 点 [+ 加一种颜色] 新增 1 行（共 7 行）
7. 点最后一行 [- 删除] 删掉（回到 6 行 +1 = 7 行变 6 行）
8. 点 [创建主题 →]
9. 进入新主题页

**Expected**：
- topics.{newId} 写入 IDB
- palette 反映用户改动（label / color / 行数）
- paletteFrozenAt 是创建时刻 ISO
- 阅读页中 toolbar 按真实 palette 渲染（条数 = palette.length）
- 再次进入此主题：无任何编辑入口（color picker / label input 都不见）

**Method**：browser_click + browser_fill_form + browser_evaluate（DOM 校验）+ IDB 直读

---

## A3. 加论文：主题页 → 输 arxiv URL → 进阅读页  [P0]

**Step**：
1. 默认主题页 → 点 [+ 添加论文]
2. 输 `https://arxiv.org/abs/2412.13678`
3. 等 loading mask 隐藏（PDF 解析完成 ~3s）
4. 等 viewer 渲染第 1 页

**Expected**：
- IDB pdfs[pdfKey] 写入 + topics.default.pdfKeys 含此 pdfKey
- viewer DOM .page[data-page-number="1"] 存在
- chat 区出现 primeSummary 的 user 消息"请给这篇论文一个 100 字以内的核心总结..."
- 流式 assistant 回复
- 主对话切到 main thread

**Method**：browser_click + browser_type + browser_wait_for

---

## A4. 阅读：连续滚动 + 文字选择复制 + ⌘F 搜索  [P0]

**Step**：
1. 滚动 viewer 到 p.3
2. 在 p.3 选一段文字 → ⌘C 复制
3. 按 ⌘F 打开搜索栏 → 输 "Clio" → Enter
4. ESC 关搜索

**Expected**：
- state.currentPage 同步到 3（toolbar 显示）
- 文字可选可复制（textLayer 健康）
- ⌘F 搜索栏出现 → 搜索结果高亮 → matches 总数显示
- ESC 后搜索栏隐藏

**Method**：browser_press_key + browser_evaluate

---

## A5. 高亮 + 引用入对话：选段 → 色板 → 选色 → 自动切 thread + chatInput 含引用块  [P0]

**Step**：
1. p.2 用 Range API 选 100 字
2. 触发 mouseup → 色板浮出
3. 点紫色按钮（palette 第 4 项）

**Expected**：
- annotation 写 IDB（含 topicId / pdfKey / pages / text）
- DOM `.hl-rect[data-ann-id=X]` 渲染
- chatInput 含引用块 `> [p.2 · 🟣] "..."`
- state.currentThreadId 切到此 ann.id
- thread label = ann.text 前缀
- thread 在 thread list 出现

**Method**：browser_evaluate 注入选区 + DOM 校验

---

## A6. 对话：发消息 → 流式回复 → cite-link 渲染 + hover + click + flash  [P0]

**Step**：
1. 在 chatInput 末尾输 "请用〔p.5〕格式引用论文第 5 页观点"
2. Enter 发送（**消耗 1 条 chat**）
3. 等流式完成
4. 用 browser_evaluate 注入 fake assistant text 含 4 种格式 `〔p.3〕(p.4)（p.5）[p.6]`
5. 检查 4 种都被渲染为 `<a class="cite-link" data-page="N">` + 文本显示 `〔p.N〕`
6. Hover cite-link 看 CSS 下划线
7. 点击 cite-link
8. 看 viewer 滚到对应页 + `.page-flash` 加 class

**Expected**：
- agent 真实回复含至少 1 个 `〔p.N〕`
- 4 种格式 post-process 后 DOM 都是 `cite-link`
- 点击 → scrollPageIntoView 触发 + flashPage 触发 + 900ms 内 `.page-flash` 移除

**Method**：browser_type + Enter + browser_evaluate 注入 fake assistant + click

---

## A7. 多 thread：切 thread → viewer 滚 anchorPage → hl-flash → 切回 main  [P0]

**Step**：
1. 当前在紫高亮 thread（A5 创建）
2. 滚到 p.40
3. 点 thread list 中"主对话"
4. 应回 main thread + chat 区切到 main messages
5. 再点紫高亮 thread item
6. 应自动滚到 ann.anchorPage（p.2）
7. 紫色 hl-rect 加 `.hl-flash` class（900ms 自动移除）

**Expected**：
- state.currentThreadId 同步切换
- viewer scroll 到 anchorPage
- DOM 短暂出现 `.hl-flash` 然后消失
- chat 区 messages 内容随 thread 切换

**Method**：browser_click + browser_evaluate 检查 class

---

## A8. 删除联动：删高亮 → thread 也删 + chat 回 main  [P0]

**Step**：
1. 当前在紫高亮 thread
2. 单击紫色 hl-rect → 浮出 bubble
3. 点 bubble 中"删除"
4. ann 消失 + thread 消失 + chat 回 main

**Expected**：
- state.annotations 不含此 ann
- state.threads 不含此 threadId
- IDB threads 中此 record 被删除（deleteThreadById）
- state.currentThreadId = "main"
- DOM `.hl-rect[data-ann-id=X]` 全消失

**Method**：browser_click + IDB 直读 + DOM 校验

---

## A9. 持久化：刷新页面 → thread.messages 恢复 + 不重 prime  [P0 - 鸭鸭最关心]

**Step**：
1. 在 main thread 至少发 1 条 chat（primeSummary 已自动发过算 1 条；这里就直接用刷新）
2. F5 刷新
3. Bootstrap 完成后看 main thread.messages 数量
4. 等 loadPdf → maybePrimeSummary 检查
5. 看 console 是否出现 `[primeSummary] already done in prior session, skipping`
6. 看 network panel `/api/chat` 是否**没有**新请求

**Expected**：
- main thread.messages 含历史完整对话（user + assistant）
- console.debug 输出 "already done"
- 无新 /api/chat 请求触发

**Method**：browser_evaluate 监听 fetch + console + DOM 校验

---

## A10. 跨论文 caching：同主题加第 2 篇 → primeSummary → caching hash 跟第 1 篇一致  [P0]

**Step**：
1. 已加 Clio (A3) → 默认主题
2. 主题页 → [+ 添加论文] → `https://arxiv.org/abs/1706.03762`
3. 等 PDF 解析 + 进阅读
4. 等 primeSummary 自动发（**消耗 1 条 chat**）
5. 截 console.debug `[v3-γ caching] messages[0]` 的 hash 字段
6. 对比 Clio 第 1 次 prime 的 hash

**Expected**：
- 两次 hash 完全一致（如 `18288ccf`）
- len 完全一致
- topic 都是 "default"
- 证明 paletteRules 前缀字节稳定 → 跨论文 cache 命中前置条件

**Method**：browser_evaluate 监听 console + 比对

---

## A11. 导出：主题页点导出 → 下载 .md → 验证内容结构  [P0]

**Step**：
1. 回主题页
2. 点 [导出笔记]
3. 监听 download 触发
4. 用 browser_evaluate 调 `generateMarkdownExport(topicId)` 直接拿 string 校验内容

**Expected**：内容含以下 section：
- `# 主题: 默认主题`
- `> 导出时间: yyyy-mm-dd hh:mm`
- `> Palette: 🔴 ... / 🟢 ...`
- `## 📄 PDF 1: 2412.13678`
- `### 主对话（不绑高亮）`
- `**你**: ...` `**Agent**: ...`
- `### 高亮 1 (p.N · 🟣 质疑)`
- `> "..."` （quoted）
- 跨多 PDF：每篇独立 section

**Method**：browser_evaluate 直调函数 + 字符串 assert

---

## A12. 切主题：回 landing → 选别的主题 → palette toolbar 切对  [P0]

**Step**：
1. 当前在默认主题
2. 点"← 返回"或刷新 → landing
3. 点 A2 创建的"E2E-测试主题"
4. 进主题页 → 加同一篇 PDF（注意：pdfKey 唯一，先看是否拒绝）
5. 进阅读页
6. 看 toolbar palette 是否变成 6 色（A2 改了 label "E2E-A"）
7. 选段触发色板 → 应显示 6 色 emoji + 改过的 label

**Expected**：
- toolbar palette 与新主题一致
- 色板 tooltip 是新 label
- 创建 ann 时 color 在新 palette 内 → 通过；伪造 color → reject + console.warn

**Method**：browser_click + DOM 校验 + browser_evaluate 注入伪 color

---

# B. v3-fixup 验证（鸭鸭最关心的 2 件事）

## B1. prime 不重复：刷新后 console 应出 "already done" + 无新 /api/chat  [P0]

详见 A9。**重点关注**：
- A9 已含 prime 不重复验证
- 在此再单独抽出强化：发对话 → F5 刷新 → 不应再触发 prime
- 网络 panel 无 /api/chat（除非用户主动发新 chat）

---

## B2. 引用回链容错：4 种格式都被渲染为 `〔p.N〕` 蓝色 link  [P0]

**Step**：browser_evaluate 注入下列 fake assistant text → 调 renderAssistant：

```
text = "测试 〔p.3〕 严格 / (p.4) 半角 / （p.5）全角 / [p.6] 方括号 完毕"
```

**Expected**：所有 4 种都变成
```html
<a class="cite-link" data-page="N" title="跳到第 N 页">〔p.N〕</a>
```
不残留任何 `(p.N)` / `[p.N]` / `（p.N）` 字面量。

**Method**：browser_evaluate 注入 + querySelectorAll('.cite-link') 校验

---

## B3. 引用回链实际：agent 真实输出格式  [P1]

**Step**：（**消耗 1 条 chat**，可与 A6 合并）
1. 选段 → 紫色 → 切入紫 thread
2. 发 "请引用论文 p.3 的某观点，按规范用〔p.3〕标注"
3. 等流式完
4. 看 agent 实际输出格式

**Expected**：理想：至少 1 个 `〔p.N〕` 严格格式。实际可能：DeepSeek 用 `p.3` 不带括号、`(p.3)` 半角等。**记录 actual 给鸭鸭看遵循度**。

---

# C. 边缘 case（CLAUDE.md #4 "半夜工程师视角"）

## C1. 配额爆 mock：fetch 替换返回 429  [P1]

**Step**：browser_evaluate 注入 `window.fetch = mock429`，发 chat。
**Expected**：错误 toast / chat bubble 显示错误 + thread.messages user 回滚 + streaming=false。
**Method**：browser_evaluate

---

## C2. 网络断 mock：fetch 抛 NetworkError  [P1]

**Step**：mock fetch reject。
**Expected**：错误显示 + 不卡 streaming 状态。

---

## C3. 上游超时：mock 返回 504  [P1]

**Step**：mock 504。
**Expected**：错误显示。

---

## C4. 上游错误体非预期格式：mock 返回 200 但 body 不是 SSE  [P1]

**Step**：mock 返回 plain text。
**Expected**：parse 失败不崩，user 消息回滚，console warn。

---

## C5. 极慢网络：mock fetch delay 30s + 用户点 abort  [P1]

**Step**：发 chat → 立即点 stop 按钮 / Enter 再次触发。
**Expected**：AbortController.abort() → catch 走 user pop 分支 → streaming=false。

---

## C6. 主题名 unicode / emoji / 超长  [P1]

**Step**：新建主题名输 "🌸樱花研究 - 超长字符" * 5（>60 字符）。
**Expected**：name 被截断到 60 字 / 显示完整 / 不破坏 IDB schema。

---

## C7. palette label 含 emoji / unicode / 超长  [P1]

**Step**：palette 第 1 行 label 输 "💡🧠看不懂 ××× ×××"。
**Expected**：toolbar tooltip 正确显示 + 不破坏 paletteRules 字节稳定（同 label 二次注入 hash 一致）。

---

## C8. 连续疯狂点击 stop 按钮  [P1]

**Step**：发 chat → 流式中连点 stop 10 次。
**Expected**：第 1 次 abort 生效，后续 no-op（streaming 已 false），无双重 abort 异常。

---

## C9. 流式中三类 abort：backHome / 切主题 / 切 thread  [P1]

**Step**：
- 案 A：流式中点 ← 返回主题页 → 期望 abort + 不污染 thread
- 案 B：流式中刷新 → reload，messages 已存到刚发出去的那条 user
- 案 C：流式中切 thread（已被 v2-b 覆盖，复跑确认）

**Method**：browser_evaluate 注入 + DOM 校验

---

## C10. IDB 不可用（隐私模式 mock）  [P2]

**Step**：browser_evaluate 替换 `window.indexedDB = undefined`，刷新。
**Expected**：UI 不崩，但数据丢失提示用户（or 至少 console.warn）。

---

# D. 累积 PASS 回归抽检

## D1. v2-b 核心抽检（5 项）

- D1-1 loading mask 全屏覆盖（P0）：发 PDF URL → mask 出现在 viewer 上覆盖
- D1-2 色板 mouseup 显示 < 50ms（P0）：性能测
- D1-3 删除 click → DOM remove < 50ms（P0）
- D1-4 跨 3 页选段 → 3 页都有 rect（P1）：browser_evaluate 注入 Range API
- D1-5 v2-a 无回归：⌘F 搜索 / IME / 复制 PDF 文字

## D2. v3-α 抽检（3 项）

- D2-1 IDB v2/v3 schema 4 stores（P0）
- D2-2 paletteRules 字节稳定（P0）：两次同主题取 messages[0] hash
- D2-3 v2-b 老数据迁移 topicId（P0）：browser_evaluate 注入 v1 模拟数据后刷新

## D3. v3-β 抽检（5 项）

- D3-1 landing 主题列表网格（P0）
- D3-2 新建主题 step1/step2（P0）
- D3-3 主题页 PDF 列表 + [+ 添加论文]（P0）
- D3-4 色板锁定（DOM 无编辑入口）（P0）
- D3-5 cardMenu hidden 不再阻塞（v3-β 主 Claude 修的 CSS）

## D4. v3-γ 抽检（3 项）

- D4-1 toolbar 按真实 palette 动态渲染（P0）
- D4-2 createAnnotation reject 越界 color（P1）：browser_evaluate 注入伪 color
- D4-3 reader topic dot 颜色 = palette[0].color（P2）

## D5. v3-δ 抽检（3 项）

- D5-1 cite-link 渲染 + click + flash（P0）：详见 A6
- D5-2 thread.messages 持久化（P0）：详见 A9
- D5-3 导出 .md 内容完整（P0）：详见 A11

---

# E. 产品 4 亮点逐条验证

## E1. 🎨 颜色走思考：标颜色 → agent 按 label 调整回应  [P0]

**Step**：（与 A6/B3 合并测）选段标红 → 发"这块帮我解释"  → 期待 agent 详细解释。再选段标绿 → 期待 agent 简短确认。**消耗 0 chat**（用 console 看 system message 内 palette rules 即可验证注入）。

**Expected**：
- 发请求时 messages[0] 的 system content 含当前 palette 全部 label
- agent 风格变化（人工感知，记录截图）

**Method**：browser_evaluate 监听 fetch payload + 截图

---

## E2. 💰 Cache-native：caching hash 跨 PDF 同主题稳定  [P0]

详见 A10。

---

## E3. 🎯 主题容器：palette 冻结 + 同主题多 PDF + 笔记导出  [P0]

详见 A2 + A10 + A11。

---

## E4. 🔗 Trace-Back 引用：cite-link 渲染 + click 跳页 + flash  [P0]

详见 A6 + B2。

---

# F. 测试方法学补充

## F.1 Token 节制预算

| chat# | 用途 | 来自哪个 case |
|---|---|---|
| 1 | A3 自动 primeSummary (Clio) | A3 |
| 2 | A10 自动 primeSummary (Transformer) | A10 |
| 3 | A6 用户发"请用〔p.5〕格式..." | A6 / B3 合并 |
| 4 | (备用) 触发 agent 真实回复格式校验 | B3 强化 |
| 5 | (备用) 边缘 case mock 失败 fallback | C 系列 |

**目标实际花费**：3 chat（节约 2 备用）。

## F.2 凡能用 browser_evaluate 代替真 chat 的，一律 evaluate

- B2 cite-link 4 格式：注入 fake assistant text（不烧 chat）
- C1-C4 配额/网络/超时：mock fetch（不烧 chat）
- C7-C9 边缘交互：注入 + assert（不烧 chat）
- D2-2 paletteRules hash：读 console.debug 已有日志（不烧 chat）

## F.3 验证产出格式

- 每个 case：✅/❌/⏭ + 一行证据（DOM snippet / IDB content / console line）
- 截图保存：happy path 关键节点（landing / 阅读页 / 高亮 / 导出预览）
- console errors 全程统计（target = 0）

---

# G. 自检：覆盖完整性

## 对照 4 亮点

| 亮点 | 主用例 | 副用例 |
|---|---|---|
| 🎨 Color-tagged Cognition | E1 | A5 (palette toolbar), A2 (palette frozen), B3 (agent 风格) |
| 💰 Cache-native | E2 | A10 (跨论文 hash 一致), D2-2 (字节稳定) |
| 🎯 主题容器 | E3 | A2 (palette frozen), A10 (跨论文同主题), A11 (导出), A12 (切主题) |
| 🔗 Trace-Back 引用 | E4 | A6 (渲染+click), B2 (容错), B3 (agent 真实遵循度) |

✅ 全覆盖

## 对照 Mission 4 环节

| 环节 | 用例 |
|---|---|
| **读** | A3 (加论文), A4 (滚动+复制+搜索), A7 (切 thread + 滚 anchorPage), D1 (v2-b loading mask) |
| **理解** | A5 (高亮+引用), A6 (对话+引用), E1 (颜色走思考), B3 (agent 引用遵循度) |
| **整理** | A2 (新建主题+palette 定义), A7 (多 thread), A8 (删除联动), A12 (切主题) |
| **输出** | A11 (导出 .md), E3 (主题容器) |

✅ 全覆盖

---

# H. 总用例计数

- A 核心旅程：12 项 (P0)
- B v3-fixup：3 项 (P0/P1)
- C 边缘：10 项 (P1/P2)
- D 累积回归抽检：5+3+5+3+3 = 19 项
- E 4 亮点：4 项 (P0)
- **合计：48 项**（≈50+ 达标）

P0 数量：~25 项（占一半）—— 跑通这些是发布门槛。

---

# I. 执行优先顺序

```
1. A1-A3   首次加载 + 创主题 + 加 PDF                    (~10 min)
2. A4-A6   阅读 + 高亮 + 对话 + cite-link (含 chat#1+#2)  (~10 min)
3. A7-A9   thread + 删除 + 持久化（含 prime 不重复）       (~8 min)
4. A10-A11 跨论文 caching + 导出 (含 chat#3)              (~8 min)
5. A12     切主题                                          (~3 min)
6. B2      cite-link 容错（evaluate）                      (~3 min)
7. C1-C9   边缘（evaluate mock）                           (~10 min)
8. D 抽检  累积回归                                        (~5 min)
9. E1      颜色走思考验证（read fetch payload）             (~2 min)
10. 写 E2E_FINAL_REPORT.md                                 (~8 min)
```

**总时间预算：约 60 分钟**。
