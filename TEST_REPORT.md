# 测试报告 (2026-05-18 17:05)

Server: http://127.0.0.1:5050 (PID 59539, 未重启)  ·  Provider: openrouter / google/gemini-2.0-flash-exp:free
样本 PDF: arxiv 2412.13678 (Anthropic Clio, 46 页, 11 MB)

---

## 覆盖统计
- **24** 个路径/场景测试
- **18** 通过
- **5** 失败（详见 P0-P2）
- **1** 未测（本地 PDF 拖入 / file input，浏览器自动化注入文件较麻烦，建议鸭鸭手测）

---

## Pass

### A. API 直测（用 .venv/bin/python httpx，因 curl 被沙箱拦）
- A1 `POST /api/chat {hi}` → 透传 OpenRouter 404 错误（HTTP 错但**报错正确**：上游说 "No endpoints found for google/gemini-2.0-flash-exp:free."），见 P0 Bug #1
- A2 `GET /api/notes` → 404 ✅
- A3 `GET /anything-weird` → 404（catch-all 合理）✅
- A4 `GET /api/chat` → 405 Method Not Allowed ✅
- A5 `GET /` → 200, 2599 B, no-store ✅
- A6 `GET /app.js` → 200, 13797 B（带 `?v=mtime` cache-bust）✅
- A7 `GET /style.css` → 200, 5838 B ✅
- A8 `GET /system_prompt.md` → 404（外部不可读）✅
- A9 `GET /.env` → 404（外部不可读）✅
- A10 `GET /api/fetch-pdf?url=https://arxiv.org/abs/2412.13678` → 200, 11 MB, `application/pdf`, sniff `%PDF-1.5` ✅
- A11 缺 `url` 参数 → 422 with detail ✅
- A12 中文 URL / 极长 URL → 502 透传，不崩 ✅

### B. UI Happy paths（Playwright）
- B1 首页 → 输入 arxiv URL → 切到 reader，页码 `1 / 46`、标题 `2412.13678` ✅
- B2 翻页按钮 ‹/› → 1→2→3 OK ✅
- B3 键盘 ← / → → 翻页正常 ✅
- B4 输入框 focus 时按 ← → 光标移动**不抢页**（页码不变）✅
- B5 翻页前后边界 cap：往前不到 0，往后不超 46 ✅
- B6 流式发消息（注入 mock SSE 模拟）→ 6 个 chunk 全收、`messages` 累计 user + assistant、按钮 ⏹ → ↵、input 由 disabled 恢复 ✅
- B7 abort 中途（点 ⏹）→ mock 收到 abort signal、UI 显示 "（已中止）"、按钮立即恢复 ✅
- B8 重复点 ⏹（流已结束时再点 submit）→ 无 exception ✅

---

## Fail

### [P0] Bug #1: OpenRouter model `google/gemini-2.0-flash-exp:free` 已下线，整个 LLM 路径全瘫
- **复现**：1. 浏览器打开 http://127.0.0.1:5050 2. 输入 `https://arxiv.org/abs/2412.13678` 3. PDF 加载完会自动触发 `primeSummary()` 调 `/api/chat`
- **期望**：Agent 回复 100 字总结
- **实际**：HTTP 404 + 红框 `⚠ No endpoints found for google/gemini-2.0-flash-exp:free.`
- **直测复现**：`POST /api/chat {messages:[{role:user,content:hi}]}` → 404 + `{"detail":"{\"error\":{\"message\":\"No endpoints found for google/gemini-2.0-flash-exp:free.\",\"code\":404}, ...}"}`
- **截图**：`/Users/gloriayin/projects/co-read-web/test-final-state.png`
- **相关 log**：
  ```
  INFO:     127.0.0.1:55855 - "POST /api/chat HTTP/1.1" 404 Not Found
  INFO:     127.0.0.1:55936 - "POST /api/chat HTTP/1.1" 404 Not Found
  ```
  → 题面里说的"是真 bug 还是浏览器历史 noise"——**真 bug，每次新会话都会触发**
- **怀疑根因**：OpenRouter 把 `google/gemini-2.0-flash-exp:free` 的免费 endpoint 下线了（Google 早就拉走了 free tier 这个特定 model）。`.env` `LLM_PROVIDER=openrouter`、`LLM_MODEL` 未覆盖，所以走 `PROVIDERS["openrouter"]` 的硬编码默认 `google/gemini-2.0-flash-exp:free`（server.py:22）
- **建议修复（dev/architect 决策）**：
  - 短期：切到能用的 provider/model（鸭鸭 .env 有 deepseek/gemini/qwen/kimi 多份 key，DeepSeek 缓存命中率最高且 CLAUDE.md #5 推荐）。鸭鸭说一句"切到 X"就行
  - 中期：OpenRouter 的硬编码 default 可改为更稳定的 model（如 `google/gemini-2.0-flash-001`、`anthropic/claude-3.5-haiku` 等）
  - 注意：server.py:75-79 已经把上游 404 用同样的 status code 透传给前端，前端 `extractErrorMessage` 也成功提取到了 message —— **错误处理链路是好的**，问题纯粹是配置

### [P1] Bug #2: 首 token 前 abort，user 消息没回滚，导致后续 messages 出现连续 user，破坏 OpenAI 协议
- **复现**：1. 发消息 2. 在第一个 SSE chunk 到达**之前**点 ⏹（实际是在 fetch 已发但还没收到响应时）3. 再发新消息
- **期望**：abort 时若 `fullText === ""`，应回滚刚 push 的 user 消息；或者保留 user 消息但下次发消息时也不出现连续 user
- **实际**：`state.messages` 变成 `[user, user, assistant]` —— 两条连续 user。下次发新消息时整个 messages 都会带给上游，OpenAI 兼容 LLM **要求 role 交替**，会返 400 invalid request
- **复现脚本（注入页面）**：
  ```js
  // submit → 100ms 后 submit again (触发 abort)
  // → fullText 空，sendMessage 的 catch(AbortError) 分支只在 fullText 非空时 push assistant
  // → 但 user 消息已经 push 进 state.messages (line 131)，没有被回滚
  ```
- **怀疑根因**：app.js:206-219 `catch (e)` 块里只有 **non-AbortError** 走 `state.messages.pop()` 回滚 user（line 218）；AbortError 分支（line 207-209）只在 `fullText` 非空时 push assistant，**没有处理 fullText 为空时 user 也该回滚的情况**。dev 在 app.js 注释里也已经"留了悬而未决问题"
- **建议修复**：app.js:207-209 改为
  ```js
  if (e.name === "AbortError") {
    if (fullText) {
      renderAssistant(contentEl, fullText + "\n\n_（已中止）_");
      state.messages.push({ role: "assistant", content: fullText });
    } else {
      // 首 token 前 abort：回滚 user 消息，移除空 bubble
      state.messages.pop();
      assistantEl.remove();
    }
  }
  ```

### [P1] Bug #3: 流式中点 ← backHome（重选论文），AbortController 没被 abort，流继续在后台烧 token
- **复现**：1. 发消息开始流式 2. 在 chunks 到达前点 ← backHome 切回 landing 3. 不立刻输入新论文 URL
- **期望**：abort 当前流，停止上游 LLM 计费
- **实际**：
  - UI 切回 landing ✅
  - 但 `state.streaming = true`、`state.abortCtl` 没调用 abort、mock 服务的 abort signal 没触发
  - 流继续在后台完整跑完，token 全部花完
  - 测下来 11/11 chunks 全部到达，`state.messages` 写入了完整 assistant 消息（但用户在 landing 看不到）
- **怀疑根因**：app.js:356 `els.backHome.addEventListener("click", switchToLanding);` —— `switchToLanding()`（line 299-303）只切 view class，**不 abort**。`resetReaderState()`（line 305 包含 `state.abortCtl?.abort()`）只有在用户**再次输入新 URL 触发 loadPdf** 时才会执行
- **建议修复**：backHome 的 handler 包一层先 abort
  ```js
  els.backHome.addEventListener("click", () => {
    if (state.streaming) state.abortCtl?.abort();
    switchToLanding();
  });
  ```
  或者更彻底：backHome 直接调 `resetReaderState()` + `switchToLanding()`，与 loadPdf 的初始化对齐

### [P2] Bug #4: `/api/fetch-pdf` 不校验上游 Content-Type / 文件 sniff，任意 HTML/二进制都会被代理
- **复现**：`/api/fetch-pdf?url=https://www.google.com/` → 200, 内容是 HTML
- **期望**：检查响应 content-type 不为 `application/pdf` 或文件头不是 `%PDF` 时返回 4xx
- **实际**：HTML 被原样代理回去，前端 pdf.js 才报 `Invalid PDF structure.` 让用户回 landing。功能上**没崩**，但带宽浪费 + 后端帮人当裸代理
- **怀疑根因**：server.py:101-109 没做 content-type 校验
- **建议修复**：在 `r.raise_for_status()` 后加：
  ```python
  ct = r.headers.get("content-type", "").lower()
  if "pdf" not in ct and not r.content[:4] == b"%PDF":
      raise HTTPException(415, f"URL didn't return a PDF (content-type: {ct})")
  ```

### [P2/P3] Bug #5: `/api/fetch-pdf` 可作为开放代理 / SSRF 风险
- **复现**：`/api/fetch-pdf?url=http://127.0.0.1:5050/api/notes` → 502 透传（因为目标是 JSON 404），但能成功连到本机；任何外部 URL 也都能访问
- **期望**：限制 host 白名单（arxiv、常见学术站、`*.pdf` 直链且非内网 IP）
- **实际**：本地 dev 中影响小（本机没起 metadata service，169.254.x 不可达），但若部署到云上：攻击者可让 server 访问 `http://169.254.169.254/latest/meta-data/iam/...` 盗 IAM credentials；也可探测内网
- **怀疑根因**：server.py:93 接受任意 URL
- **建议修复**：
  - dev 阶段：加 `if not re.match(r"^https?://(arxiv\.org|.*\.pdf$)", url): raise HTTPException(400)`
  - 或至少拒绝私有 IP（10/172.16/192.168/127/169.254）
- **降级理由**：仅本地 dev 使用，YAGNI；但部署前必须修

---

## 边缘 case 发现

- **疯狂连击翻页按钮**：renderPage 是 async，连续点击会让中间状态混乱（点 5 prev + 60 next 看到中间值 `2 / 46`），但**最终会停在正确边界**（`46 / 46`）。不影响功能但 UX 一闪一闪。属可接受。
- **输入框 focus 时按 ← →**：handler 正确跳过 `INPUT/TEXTAREA`，光标移动而非翻页 ✅
- **重复 abort（state.streaming=false 时再 submit）**：handler 安全（line 372-376 检查 `state.streaming`）✅
- **空 fullText 时 abort**：留有 dangling user message —— 见 Bug #2
- **流式中 backHome**：流不被 abort —— 见 Bug #3
- **PDF.js worker CDN 失败**：未测（PDF.js 加载依赖 cdnjs，断网会崩 PDF 全功能；属符合预期的 CDN 依赖）
- **marked CDN 失败**：app.js:285-290 有兜底 → 纯文本渲染，OK ✅
- **极大 PDF**：11 MB / 46 页 arxiv 论文加载和文本抽取顺畅，浏览器无卡顿；未测 50+ 页超大
- **本地 PDF 拖入**：未测，建议鸭鸭手测
- **`apple-touch-icon.png` / `favicon.ico`**：浏览器自动请求 → 404，log noise 但无影响（index.html 已 inline SVG favicon）

---

## 性能观察

| 项 | 数据 |
|---|---|
| 首页 → reader 切换 | ~1s（CDN 加载 marked + pdf.js + arxiv PDF 下载） |
| PDF (11 MB, 46 页) `/api/fetch-pdf` | 7-8s（含 arxiv 上游时延）|
| 46 页全文本抽取 | ~3s（pdf.js 在主线程，Chrome 没卡）|
| 首 token 延迟 | 无法测（model 404）|
| 流式 chunk 间隔 | mock 模拟 ~400ms/chunk，UI 渐进渲染流畅 |
| 静态文件 | <10ms |

---

## 给 dev/architect 的修复优先级建议

1. **[P0 立即]** 把 OpenRouter 的 default model 从 `google/gemini-2.0-flash-exp:free` 改为还活着的（或者鸭鸭直接换 provider 到 deepseek，缓存命中率更高，符合 CLAUDE.md #1 #5）。修完整个项目才能真的跑起来
2. **[P1]** Bug #2: app.js sendMessage 的 AbortError 分支补回滚逻辑 —— dev 自己留了 TODO 注释，直接对应
3. **[P1]** Bug #3: backHome handler 加 abort —— 同样 ~2 行代码
4. **[P2]** Bug #4: `/api/fetch-pdf` 加 content-type/sniff 校验
5. **[P3]** Bug #5: 上线前必须收紧 `/api/fetch-pdf` 的 URL 白名单或私有 IP 黑名单

## 没动手的部分
- 没改任何代码 ✅
- 没改 .env / 配置 ✅
- 没重启 server（PID 59539 仍是测试开始时那个进程）✅
- 没影响 architect 的工作（只读 server.py / app.js / index.html）✅
