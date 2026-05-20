/**
 * Co-Read Web · 前端
 * 单文件 vanilla JS，函数分区组织：state / pdfRenderer / chatClient / ui
 * v1 范围：官方 PDFViewer 接入（连续滚动 + text layer + 搜索）、文字抽取、流式对话、翻页同步给 agent
 * v2 待加：划线高亮、颜色分类、多对话、笔记导出
 * v3 待加：sidebar 缩略图 + outline
 */

import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.6.82/pdf.min.mjs";
import * as pdfjsViewer from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.6.82/pdf_viewer.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.6.82/pdf.worker.min.mjs";

// PDF.js 加载复杂字体（CJK / 数学符号）选区映射 + 标准字体 fallback 的配置。
// 注意：cdnjs 上 4.6.82 没有 cmaps/ 和 standard_fonts/ 目录（HEAD 403 死链），
// 用 jsdelivr 上完整的 dist（带这俩文件夹）。
const PDFJS_ASSET_BASE = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/";
const PDFJS_DOC_OPTS = {
  cMapUrl: PDFJS_ASSET_BASE + "cmaps/",
  cMapPacked: true,
  standardFontDataUrl: PDFJS_ASSET_BASE + "standard_fonts/",
};

// ────────────────────── state ──────────────────────
// v2-b：对话 thread 化
//   threads: { id → { id, annotationId, anchorPage, anchorColor, label, quotedText, messages, createdAt } }
//   currentThreadId: 当前 chat 渲染哪个 thread；默认 "main"
//   主 thread：annotationId=null, anchorPage=null, label="主对话"，承载 primeSummary + 散点提问
//   高亮 thread：annotationId=annId, label=`p.N · 颜色 emoji`，承载围绕该段的讨论
//   删高亮 = 删对应 thread（保持心智干净——产品哲学："对话依附于高亮"）
//
// v3-α 数据层：引入"主题（Topic）" 容器（UI 不动，先把数据通起来）
//   topic = { id, name, palette:[{id,emoji,label,color}], pdfKeys, createdAt }
//   currentTopicId: 当前激活主题；v3-α 阶段恒为 "default"
//   topics 在内存里映射 id → topic 对象（IDB 持久化）
const state = {
  pdf: null,           // PDFDocumentProxy
  totalPages: 0,
  currentPage: 1,
  pdfText: "",         // 全文（首次抽取，喂给 agent system）
  pdfTitle: "",        // 文件名 / 链接末段
  streaming: false,
  abortCtl: null,      // 流式可中断
  // v2-a 划线高亮
  pdfKey: "",          // 当前 PDF 在 IndexedDB 里的 key（filename+size 或 URL）
  annotations: [],     // 当前 PDF 的高亮列表 [{id,color,pages:[{page,rects,text}],text,topicId,createdAt}]
  // v2-b 多 thread
  threads: {},         // id → thread 对象（结构见上）
  currentThreadId: "main",
  // v3-α 主题
  currentTopicId: "default",
  topics: {},          // id → topic 对象
  // v3-β 视图状态机：topicList（landing）/ topicPage / reader
  // newTopic 是 modal（叠在 topicList 上），不算独立 view
  view: "topicList",
  // v3-β 阅读页面打开时来自哪个主题（用于 "← 返回主题页"）
  // 默认 = "default"；用户从某主题点 PDF 进 reader 时设为该主题 id
  readerFromTopicId: "default",
  // v3-polish-2 #3：当前 chat 待发送的引用（独立 chip 形式显示在 chatInput 上方）
  // 形状：{ annId, color, emoji, pageLabel, quoted }（quoted 已截断到 ~80 字符 for chip 显示）
  // 发送时 sendMessage 把它拼到 user message content 头部，再清空
  // 一次只允许一条；新的高亮覆盖旧的
  pendingQuote: null,
};
// 开发期方便 console 调试
window.__coread = state;
// v3-γ caching debug log 开关（默认开；console 里 `window.__coreadCachingDebug = false` 关掉）
if (window.__coreadCachingDebug === undefined) window.__coreadCachingDebug = true;
// v3-α: 暴露主题数据层 helper，后续 PR（主题列表 UI / 色板编辑器）会用
// 当前 UI 不订阅这些函数（数据层先就位，UI 慢慢接）
window.__coreadTopics = {
  ensureDefaultTopic: () => ensureDefaultTopic(),
  loadCurrentTopic:   () => loadCurrentTopic(),
  buildPaletteRules:  (p) => buildPaletteRules(p),
  loadAllTopics:      () => loadAllTopics(),
  saveTopic:          (t) => saveTopic(t),
  saveThread:         (t) => saveThread(t),
  loadThreadsByPdfKey:(k) => loadThreadsByPdfKey(k),
};

// thread helpers ──
// 初始化一个空的"主 thread"。切论文 / backHome 都会重置回这个状态
function makeMainThread() {
  return {
    id: "main",
    annotationId: null,
    anchorPage: null,
    anchorColor: null,
    label: "主对话",
    // v3-polish #7：用户自定义名（thread customName）。空值 / 未设 → 显示自动 label
    customName: "",
    quotedText: "",
    messages: [],
    createdAt: Date.now(),
  };
}
// v3-polish #7：thread 显示名 —— customName 优先（trim 后非空），否则用自动 label
function displayThreadLabel(t) {
  if (!t) return "";
  const name = (t.customName || "").trim();
  return name || t.label || "";
}
function resetThreads() {
  state.threads = { main: makeMainThread() };
  state.currentThreadId = "main";
}
function getCurrentThread() {
  return state.threads[state.currentThreadId] || state.threads.main;
}
// thread label：高亮 thread 显示 "p.N · 🔴"（短而稳定；v3 可加 quotedText 摘要）
function threadLabel(ann) {
  if (!ann) return "主对话";
  const emoji = COLOR_MAP[ann.color]?.emoji || "";
  const pageNums = ann.pages.map((p) => p.page);
  const pageLabel = pageNums.length === 1
    ? `p.${pageNums[0]}`
    : `p.${pageNums[0]}-${pageNums[pageNums.length - 1]}`;
  return `${pageLabel} · ${emoji}`;
}
// 启动时立刻塞一个 main thread，确保 state.threads 永不为空
resetThreads();

// ────────────────────── DOM 引用 ──────────────────────
const $ = (id) => document.getElementById(id);
const els = {
  landing: $("landing"),
  topicPage: $("topicPage"),
  reader: $("reader"),
  // v3-β topic list (landing)
  topicGrid: $("topicGrid"),
  newTopicBtn: $("newTopicBtn"),
  landingStatus: $("landingStatus"),
  // v3-β topic page
  topicBack: $("topicBack"),
  tpName: $("tpName"),
  tpPaletteRow: $("tpPaletteRow"),
  tpPaletteToggle: $("tpPaletteToggle"),
  tpLoadForm: $("tpLoadForm"),
  tpUrlInput: $("tpUrlInput"),
  tpFileInput: $("tpFileInput"),
  tpStatus: $("tpStatus"),
  tpPdfList: $("tpPdfList"),
  // v3-β new topic modal
  newTopicModal: $("newTopicModal"),
  ntmClose: $("ntmClose"),
  ntmStep1: $("ntmStep1"),
  ntmStep2: $("ntmStep2"),
  ntmStep3: $("ntmStep3"),
  ntmNameInput: $("ntmNameInput"),
  ntmPaletteEditor: $("ntmPaletteEditor"),
  ntmAddRow: $("ntmAddRow"),
  ntmConfirmName: $("ntmConfirmName"),
  ntmConfirmPalette: $("ntmConfirmPalette"),
  ntmStepIndicator: $("ntmStepIndicator"),
  ntmPrev: $("ntmPrev"),
  ntmNext: $("ntmNext"),
  ntmConfirm: $("ntmConfirm"),
  // v3-β topic card "..." menu + palette viewer
  topicCardMenu: $("topicCardMenu"),
  paletteViewer: $("paletteViewer"),
  pvClose: $("pvClose"),
  pvBody: $("pvBody"),
  // v3-δ 导出笔记
  tpExportBtn: $("tpExportBtn"),
  // reader
  viewerContainer: $("viewerContainer"),
  viewer: $("viewer"),
  pdfTitle: $("pdfTitle"),
  readerTopicHint: $("readerTopicHint"),
  backHome: $("backHome"),
  pageInfo: $("pageInfo"),
  findBar: $("findBar"),
  // v3-polish-4：findToggle 按钮已删（搜索框始终可见，⌘F 改为 focus #findInput）
  findInput: $("findInput"),
  findStatus: $("findStatus"),
  findPrev: $("findPrev"),
  findNext: $("findNext"),
  findClose: $("findClose"),
  // v5：实时搜索结果下拉预览
  findDropdown: $("findDropdown"),
  chatMessages: $("chatMessages"),
  chatForm: $("chatForm"),
  chatInput: $("chatInput"),
  chatQuoteBar: $("chatQuoteBar"),
  sendBtn: $("sendBtn"),
  threadSummary: $("threadSummary"),
  threadList: $("threadList"),
  // v2-a 划线高亮
  colorPalette: $("colorPalette"),
  hlBubble: $("hlBubble"),
  // v2-b 整页 loading mask
  loadingMask: $("loadingMask"),
  loadingText: $("loadingText"),
  // v3-thumb-zoom：缩略图 sidebar + 缩放控件
  // v3-polish-4：toggleThumb 按钮已删（sidebar 默认显示，无需切换）
  thumbnailSidebar: $("thumbnailSidebar"),
  thumbnailView: $("thumbnailView"),
  zoomOut: $("zoomOut"),
  zoomIn: $("zoomIn"),
  zoomLevel: $("zoomLevel"),
  zoomMenu: $("zoomMenu"),
};

// ────────────────────── pdfRenderer ──────────────────────
// PDF.js 官方 viewer 三件套（一次性创建，整个 app 生命周期复用）：
//   eventBus      —— 所有事件入口（pagechanging / pagesinit / find result 等）
//   linkService   —— PDF 内部跳转 + annotation layer 链接处理
//   findController —— 基础搜索（v1）
//   pdfViewer     —— 多页虚拟化渲染容器，连续滚动 (scrollMode=0)
// 切论文时只 setDocument(...)，不重建实例。
const eventBus = new pdfjsViewer.EventBus();
const linkService = new pdfjsViewer.PDFLinkService({ eventBus });
const findController = new pdfjsViewer.PDFFindController({ eventBus, linkService });
const pdfViewer = new pdfjsViewer.PDFViewer({
  container: els.viewerContainer,
  viewer: els.viewer,
  eventBus,
  linkService,
  findController,
  textLayerMode: 1,        // 1=ENABLE (默认/正常复制)。**不要用 2** —— 2=ENABLE_PERMISSIONS，会无条件 preventDefault 所有 copy 事件、剪贴板永远空
  annotationMode: 2,       // 启用 annotation layer（链接可点）
  removePageBorders: false,
});
linkService.setViewer(pdfViewer);

// v3-thumb-zoom：缩略图 sidebar 视图
//   - 自己实现 mini thumbnail viewer（不依赖 pdf.js 私有 PDFThumbnailViewer 类，因为 CDN 的 pdf_viewer.mjs 不导出）
//   - 直接用已加载的 pdfjsLib.getDocument 拿到的 PDFDocumentProxy 渲染到 canvas
//   - renderThumbnails(pdfDoc) 在 loadPdf 内 fire-and-forget；切论文用 replaceChildren() 清旧
//   - 点击委托 + pagechanging 同步高亮，见下方监听器

// 初始化后才能设 scrollMode / 设文档
eventBus.on("pagesinit", () => {
  pdfViewer.currentScaleValue = "page-width";
  updateZoomLevelUI();
});
// 翻页同步给 agent context（[CURRENT_PAGE: N] 注入依赖此值）
eventBus.on("pagechanging", (evt) => {
  state.currentPage = evt.pageNumber;
  if (state.totalPages) {
    els.pageInfo.textContent = `${evt.pageNumber} / ${state.totalPages}`;
  }
  // v3-thumb-zoom：当前页缩略图自动滚入视野 + 高亮（自己实现的 mini thumbnail viewer）
  // safe-fail：缩略图未渲染时调用静默忽略
  try {
    highlightCurrentThumb(evt.pageNumber);
  } catch (_) { /* 缩略图未渲染或 DOM 已清，忽略 */ }
});
// v3-thumb-zoom：缩放变化 → 更新 toolbar 数字
eventBus.on("scalechanging", () => {
  updateZoomLevelUI();
});
// 搜索结果状态同步到 UI
eventBus.on("updatefindmatchescount", (evt) => updateFindStatus(evt));
eventBus.on("updatefindcontrolstate", (evt) => updateFindStatus(evt));
// v2-a：每页 textLayer 渲染完成 → 给该页挂高亮层并恢复已存在的 annotation
// 注意用 textlayerrendered（textLayer 已就位，rect 坐标稳定），不是 pagerendered（canvas 完成但 textLayer 可能还没）
eventBus.on("textlayerrendered", (evt) => {
  renderHighlightsForPage(evt.pageNumber);
});
// 窗口缩放时重新适配
window.addEventListener("resize", () => {
  if (state.pdf && pdfViewer.currentScaleValue) {
    pdfViewer.currentScaleValue = pdfViewer.currentScaleValue;
  }
});

async function loadPdf({ url, file, topicId }) {
  resetReaderState();
  showLoadingMask("正在拉取 PDF…");
  // v3-α: 确保启动期 bootstrap（默认主题 + annotation migration）已跑完
  // 防御：bootstrap promise 已在模块顶层 fire；这里 await 让首次 loadPdf 不抢跑
  // 失败的 bootstrap 已被 catch 吞掉，不会卡住此处
  await _bootstrapPromise;
  // 双保险：若 state.topics 还没填上（极端情况：bootstrap 失败、IDB 全坏），落回内存默认值
  if (!state.topics[DEFAULT_TOPIC_ID]) {
    state.topics[DEFAULT_TOPIC_ID] = {
      id: DEFAULT_TOPIC_ID,
      name: "默认主题",
      palette: DEFAULT_PALETTE.map((p) => ({ ...p })),
      pdfKeys: [],
      createdAt: new Date().toISOString(),
    };
    state.currentTopicId = DEFAULT_TOPIC_ID;
  }
  // v3-β: 锚定到当前操作的主题（默认 fallback 到 currentTopicId / default）
  // 这是 reader "← 返回" 的目标，也是 addPdfToTopic 的归属
  const targetTopicId = topicId || state.currentTopicId || DEFAULT_TOPIC_ID;
  if (state.topics[targetTopicId]) {
    state.currentTopicId = targetTopicId;
    state.readerFromTopicId = targetTopicId;
  } else {
    state.readerFromTopicId = DEFAULT_TOPIC_ID;
  }
  try {
    let docSrc;
    let title;
    let pdfKey;
    if (file) {
      docSrc = { data: await file.arrayBuffer(), ...PDFJS_DOC_OPTS };
      title = file.name;
      // 文件用 name+size 当 key —— content hash 太重，对论文场景这俩稳定够用
      pdfKey = `file:${file.name}:${file.size}`;
    } else {
      const isHttp = /^https?:\/\//.test(url);
      const urlSrc = isHttp ? `/api/fetch-pdf?url=${encodeURIComponent(url)}` : url;
      docSrc = { url: urlSrc, ...PDFJS_DOC_OPTS };
      title = deriveTitleFromUrl(url);
      pdfKey = `url:${url}`;
    }
    state.pdf = await pdfjsLib.getDocument(docSrc).promise;
    state.totalPages = state.pdf.numPages;
    state.pdfTitle = title;
    state.pdfKey = pdfKey;

    // v3-β: 把当前 PDF 关联到 targetTopic（pdfKeys 去重 push + 更新 lastOpened 时间）
    // 同一 pdfKey 在多个主题间可共享引用（鸭鸭已拍板：annotations 按 topicId 区分）
    // 异步写 IDB，不阻塞渲染；失败已在 saveTopic 内部 catch
    addPdfToTopic(state.currentTopicId, pdfKey, title).catch((e) =>
      console.warn("[addPdfToTopic]", e)
    );

    showLoadingMask(`正在解析正文（共 ${state.totalPages} 页，0/${state.totalPages}）…`);
    switchToReader();
    els.pdfTitle.textContent = title;
    els.pdfTitle.title = title;
    els.pageInfo.textContent = `1 / ${state.totalPages}`;
    // 显示当前主题名作为 toolbar 提示
    updateReaderTopicHint();
    // v3-γ：按当前主题 palette 动态渲染色板按钮（数据驱动）
    // 关键时机：每次进 reader 必跑一次（切主题→切论文/同主题切论文都覆盖）
    renderColorPalette();

    // 把文档交给 viewer + linkService —— viewer 自己管渲染、虚拟化、滚动
    pdfViewer.setDocument(state.pdf);
    linkService.setDocument(state.pdf, null);
    // v3-thumb-zoom：自己实现的 mini thumbnail viewer，串行渲染所有页面到 canvas
    // fire-and-forget：渲染失败不阻塞主流程（鸭鸭还能正常读 PDF，只是 sidebar 不可用）
    renderThumbnails(state.pdf).catch((e) => console.warn("[renderThumbnails]", e));

    // v2-a：异步加载已保存的 annotation。pagerendered 时会按需 render
    // 用 .catch 不阻塞主流程（IndexedDB 不可用时已在内部降级到内存）
    loadAnnotations(pdfKey).then(async (list) => {
      // v3-α: 内存层兜底——若加载到的 ann 没 topicId（migration 还没跑或失败），补上 "default"
      // 这是双保险：autoMigrateAnnotationsToDefault 是 IDB 层迁移，这里只在内存里补
      state.annotations = (list || []).map((ann) =>
        ann && !ann.topicId ? { ...ann, topicId: DEFAULT_TOPIC_ID } : ann
      );
      // 已保存的 annotation 重建对应 thread（用户切论文回来还能看到围绕高亮的"思考标签"）
      for (const ann of state.annotations) ensureAnnotationThread(ann);
      // v3-δ：从 IDB 加载这个 pdfKey 下所有 threads，把 messages 填回内存
      // 边缘：失败不崩；空 → 维持 resetThreads() 的初始 main thread
      try {
        const savedThreads = await loadThreadsByPdfKey(pdfKey);
        for (const rec of savedThreads || []) {
          if (!rec || !rec.id) continue;
          if (state.threads[rec.id]) {
            // 已有内存对象（main / annotation thread）→ 把 messages 灌进去
            state.threads[rec.id].messages = rec.messages || [];
            // v3-polish #7：customName 也以 IDB 为准恢复（用户上次改的名字不能丢）
            state.threads[rec.id].customName = rec.customName || "";
            // 元字段（label / quotedText 等）以内存为准（annotation 元数据是单一来源）
          } else {
            // 内存里没有这个 thread → 整体恢复（罕见：annotation 已删但 thread 残留时跳过）
            // 校验：annotation thread 必须有对应 ann；main thread (id="main") 无 ann 也保留
            if (rec.annotationId && !state.annotations.find((a) => a.id === rec.annotationId)) {
              continue; // 孤儿 thread，不恢复（避免脏数据）
            }
            state.threads[rec.id] = {
              id: rec.id,
              annotationId: rec.annotationId || null,
              anchorPage: rec.anchorPage || null,
              anchorColor: rec.anchorColor || null,
              label: rec.label || (rec.id === "main" ? "主对话" : "(已恢复)"),
              customName: rec.customName || "",
              quotedText: rec.quotedText || "",
              messages: rec.messages || [],
              createdAt: rec.createdAt || Date.now(),
            };
          }
        }
        // 当前若停在 main thread，且 main 有历史消息 → 重渲染 chat 区
        if (state.currentThreadId === "main") {
          renderChatFromThread();
        }
        updateThreadSummary();
      } catch (e) {
        console.warn("[loadThreadsByPdfKey]", e);
      }
      // 当前已渲染的 page 立即补画一次（textlayerrendered 已经触发过的页）
      renderAllHighlights();
      updateThreadSummary();
    }).catch((e) => console.warn("[loadAnnotations]", e));

    await extractAllText((i, n) => {
      showLoadingMask(`正在解析正文（共 ${n} 页，${i}/${n}）…`);
    });
    hideLoadingMask();
    maybePrimeSummary();
  } catch (e) {
    console.error("[loadPdf]", e);
    hideLoadingMask();
    const msg = `加载失败：${e.message || e}`;
    // 已切到 reader 的情况下，回退到来源主题页（用户看到错误能立刻重试）
    if (els.reader.classList.contains("active")) {
      switchToTopicPage(state.readerFromTopicId || DEFAULT_TOPIC_ID);
      setTpStatus(msg, true);
    } else if (els.topicPage.classList.contains("active")) {
      setTpStatus(msg, true);
    } else {
      setLandingStatus(msg, true);
    }
  }
}

// 整页 loading mask：拉取 / 解析期间挡住整个视口，挡掉用户乱点
function showLoadingMask(text) {
  els.loadingText.textContent = text || "加载中…";
  els.loadingMask.hidden = false;
}
function hideLoadingMask() {
  els.loadingMask.hidden = true;
}

function deriveTitleFromUrl(url) {
  try {
    const u = new URL(url);
    const tail = u.pathname.split("/").filter(Boolean).pop() || u.hostname;
    return decodeURIComponent(tail);
  } catch {
    return url;
  }
}

// 全文抽取：喂给 agent system message。viewer 重构后此函数签名/返回值不变。
// 注意：viewer 的 textLayer 是按需渲染的（virtualized），这里直接走 pdfjsLib API
// 一次性抽全文，和 viewer 渲染解耦，避免相互干扰。
async function extractAllText(onProgress) {
  const chunks = [];
  for (let i = 1; i <= state.totalPages; i++) {
    const page = await state.pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map((it) => it.str).join(" ");
    chunks.push(`--- 第 ${i} 页 ---\n${pageText}`);
    onProgress?.(i, state.totalPages);
  }
  state.pdfText = chunks.join("\n\n");
}

// ────────────────────── 搜索 (PDFFindController) ──────────────────────
// v3-polish-4：搜索框始终可见 → openFindBar 只做 focus + select；closeFindBar 只清查询不再 hide
// v5：ESC 回到原始语义 —— 清空 input value + 清高亮 + 收下拉 + 焦点还 viewer（撤销 v4 的"保留 query"）
// v5：删掉 3 个 toggle（caseSensitive / entireWord / matchDiacritics），统一用 pdf.js 默认 false
function openFindBar() {
  els.findInput.focus();
  els.findInput.select();
}
function clearFindHighlights() {
  // 只清高亮 + 内部 query state，不动 input value
  eventBus.dispatch("find", {
    source: window,
    type: "",
    query: "",
    highlightAll: true,
    findPrevious: false,
  });
  els.findStatus.textContent = "0 / 0";
}
function closeFindBar() {
  // ESC（v5）：清空 input value + 清高亮 + 收下拉 + 焦点还 viewer
  els.findInput.value = "";
  clearFindHighlights();
  hideFindDropdown();
  els.viewerContainer.focus({ preventScroll: true });
}
function dispatchFind(type) {
  const query = els.findInput.value;
  eventBus.dispatch("find", {
    source: window,
    type,                           // ""=新查询 / "again"=同查询下一个 / "highlightallchange" 等
    query,
    highlightAll: true,
    findPrevious: false,
  });
}
function findAgain(prev) {
  const query = els.findInput.value;
  if (!query) return;
  eventBus.dispatch("find", {
    source: window,
    type: "again",
    query,
    highlightAll: true,
    findPrevious: !!prev,
  });
}
function updateFindStatus(evt) {
  // evt 形如 { matchesCount: { current, total } } 或类似
  const mc = evt?.matchesCount || findController.matchesCount;
  const current = mc?.current || 0;
  const total = mc?.total || 0;
  els.findStatus.textContent = `${current} / ${total}`;
}

// ── v5：实时搜索结果下拉预览 ──────────────────────────────
// 鸭鸭需求：输入关键词、还没回车，就在 findBar 下方浮出匹配预览。
// 实现走最简直觉：直接在 state.pdfText 上 grep（pdfText 已按 "--- 第 N 页 ---" 分页存储），
// 不 hook pdf.js 内部 matches，跟页内黄色高亮（findController）完全解耦。
const FIND_DD_MAX = 50;          // 最多渲染 50 条，避免下拉过长（极常见词如 "the" 几百处）
const FIND_DD_CTX = 20;          // snippet 前后各取 ~20 字上下文
let _findDebounceTimer = null;

function hideFindDropdown() {
  if (els.findDropdown) els.findDropdown.hidden = true;
}

// HTML 转义：snippet 来自 PDF 正文，可能含 < > & 等
function escHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]
  ));
}

// 在 pdfText 内搜 query → 收集 { page, snippet }（大小写不敏感，snippet 保留原文大小写）
function collectFindResults(query) {
  const results = [];
  // 按 "--- 第 N 页 ---" 标记切分（extractAllText 的格式）
  const parts = state.pdfText.split(/--- 第 (\d+) 页 ---\n/);
  // split 后结构：["", "1", "<第1页文字>", "2", "<第2页文字>", ...]
  const qLower = query.toLowerCase();
  let truncated = false;
  for (let i = 1; i < parts.length; i += 2) {
    const pageNum = parseInt(parts[i], 10);
    const pageText = parts[i + 1] || "";
    const pageLower = pageText.toLowerCase();
    let from = 0;
    while (true) {
      const idx = pageLower.indexOf(qLower, from);
      if (idx < 0) break;
      const start = Math.max(0, idx - FIND_DD_CTX);
      const end = Math.min(pageText.length, idx + query.length + FIND_DD_CTX);
      results.push({
        page: pageNum,
        before: (start > 0 ? "…" : "") + pageText.slice(start, idx),
        match: pageText.slice(idx, idx + query.length),  // 原文大小写
        after: pageText.slice(idx + query.length, end) + (end < pageText.length ? "…" : ""),
      });
      from = idx + query.length;
      if (results.length >= FIND_DD_MAX) { truncated = true; break; }
    }
    if (truncated) break;
  }
  return { results, truncated };
}

function renderFindDropdown(query) {
  const dd = els.findDropdown;
  if (!dd) return;
  // query 为空 → 隐藏，不搜
  if (!query) { hideFindDropdown(); return; }
  // pdfText 还没抽取完（大 PDF 加载中 / 未加载 PDF）→ 提示而非空
  if (!state.pdfText) {
    dd.replaceChildren();
    const tip = document.createElement("div");
    tip.className = "find-result-empty";
    tip.textContent = "正在解析正文…";
    dd.appendChild(tip);
    dd.hidden = false;
    return;
  }
  const { results, truncated } = collectFindResults(query);
  dd.replaceChildren();
  // 顶部统计行
  const head = document.createElement("div");
  head.className = "find-result-head";
  if (results.length === 0) {
    head.textContent = "无匹配";
    dd.appendChild(head);
    dd.hidden = false;
    return;
  }
  head.textContent = truncated
    ? `共 ${results.length}+ 处（仅显示前 ${FIND_DD_MAX}）`
    : `共 ${results.length} 处匹配`;
  dd.appendChild(head);
  // 结果项
  for (const r of results) {
    const item = document.createElement("div");
    item.className = "find-result";
    item.dataset.page = String(r.page);
    item.setAttribute("role", "option");
    item.innerHTML =
      `<span class="fr-page">📄 p.${r.page}</span> ` +
      `<span class="fr-snip">${escHtml(r.before)}` +
      `<mark>${escHtml(r.match)}</mark>` +
      `${escHtml(r.after)}</span>`;
    dd.appendChild(item);
  }
  dd.hidden = false;
}

// 点 dropdown 结果 → 跳页 + 保留 scrollLeft（复用 cite-link / 缩略图同款双 rAF）
function jumpToFindResult(pageNum) {
  if (!pageNum || !state.pdf) return;
  if (pageNum < 1 || pageNum > state.totalPages) {
    console.debug("[find-result] page out of range:", pageNum);
    return;
  }
  // scrollLeft 保留：pdf.js scrollPageIntoView 只管垂直对齐、会重置水平位置
  const prevScrollLeft = els.viewerContainer.scrollLeft;
  try {
    pdfViewer.scrollPageIntoView({ pageNumber: pageNum });
  } catch (err) {
    console.debug("[find-result] scrollPageIntoView failed:", err);
    return;
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      els.viewerContainer.scrollLeft = prevScrollLeft;
    });
  });
  // 收起下拉 + 让 pdf.js 在该页黄色高亮这个词（沿用现有 findController 流程）
  hideFindDropdown();
  dispatchFind("");
}

// ────────────────────── v2-a 划线高亮 ──────────────────────
// 模型：
//   annotation = {
//     id: uuid,
//     color: 'red'|'green'|'blue'|'purple'|'yellow'|'gray',
//     text: '所选文字（跨页拼起来的纯文本）',
//     pages: [
//       { page: N, text: '该页选中文字', rects: [{leftPct, topPct, widthPct, heightPct}, ...] }
//     ],
//     createdAt: ISO string,
//   }
// rect 用百分比（相对该 page 容器）→ 缩放时无需重算，跟着 .page 自适应。
//
// 持久化：IndexedDB（store: annotations, key: pdfKey, value: 该 PDF 的全部 annotation 数组）。
//        失败 → 内存 Map 兜底（隐私模式 / Safari 老版本）。

const COLOR_MAP = {
  red:    { emoji: "🔴", label: "红" },
  green:  { emoji: "🟢", label: "绿" },
  blue:   { emoji: "🔵", label: "蓝" },
  purple: { emoji: "🟣", label: "紫" },
  yellow: { emoji: "🟡", label: "黄" },
  gray:   { emoji: "⚪", label: "灰" },
};

// ────────────────────── v3-α 主题数据层 ──────────────────────
// 默认主题色板：6 个内置 tag。按鸭鸭拍板（G3 + G4）：emoji 固定 6 个、保持现 6 色不调整。
// 字段（task 简化）：{ id, emoji, label, color }
//   - id 是内部锚（不展示给用户），用于 annotation.color 旧索引兼容（'red'/'green'/...）
//   - 给 LLM 的 system 注入只 emit emoji + label，不 emit id（system_prompt.md 已更新格式）
//   - 用户后续在主题编辑器里可改 label/color/增删行（不在 v3-α 范围内，UI 不动）
const DEFAULT_PALETTE = [
  { id: "red",    emoji: "🔴", label: "看不懂",   color: "#ff5e5e" },
  { id: "green",  emoji: "🟢", label: "已掌握",   color: "#54d062" },
  { id: "blue",   emoji: "🔵", label: "课题相关", color: "#4a9eff" },
  { id: "purple", emoji: "🟣", label: "质疑",     color: "#b06dff" },
  { id: "yellow", emoji: "🟡", label: "重点",     color: "#f5d042" },
  { id: "gray",   emoji: "⚪", label: "待查",     color: "#b8b8b8" },
];
const DEFAULT_TOPIC_ID = "default";

// 构建 palette 注入字符串（追加到 system message 末尾，给 LLM 看 tag 规则）
// 设计：emit emoji + label，按 palette 数组原顺序 —— 这是 caching 前缀稳定的关键（同主题永远相同字节序列）
// 改 palette = cache 失效（合理，按 V3_DESIGN C.3）
function buildPaletteRules(palette) {
  if (!palette || palette.length === 0) return "";
  const lines = palette.map((p) => `- ${p.emoji} ${p.label}`);
  return `## 主题 tag 规则\n${lines.join("\n")}`;
}

// ── IndexedDB 轻封装（无依赖） ──
// v3-α schema 升级（version 1 → 2）：
//   v1: annotations [keyPath: 隐式, key=pdfKey, value=ann[]]
//   v2 新增 stores:
//     - topics    [keyPath=id]   Topic 对象
//     - threads   [keyPath=id]   thread 持久化（含 topicId / pdfKey / messages / createdAt）
//     - metadata  [keyPath=key]  通用元数据 (migrationVersion 等)
//   annotations store 不动，但 value 数组里每条 ann 加 topicId 字段（autoMigrateToDefault 跑一遍）
const IDB_NAME = "coread";
const IDB_VERSION = 2;
const IDB_STORE = "annotations";
const IDB_STORE_TOPICS = "topics";
const IDB_STORE_THREADS = "threads";
const IDB_STORE_META = "metadata";
let _idbPromise = null;
const _memFallback = new Map();          // 内存兜底（annotations）
const _memTopics = new Map();            // 内存兜底（topics）
const _memThreads = new Map();           // 内存兜底（threads）
const _memMeta = new Map();              // 内存兜底（metadata）

function openIdb() {
  if (_idbPromise) return _idbPromise;
  _idbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) return reject(new Error("no indexedDB"));
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (evt) => {
      const db = req.result;
      // v1 → v2 升级：建新 store。annotations store 不动（v1 已存在则保留；首次安装这里建）
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      if (!db.objectStoreNames.contains(IDB_STORE_TOPICS))  db.createObjectStore(IDB_STORE_TOPICS,  { keyPath: "id" });
      if (!db.objectStoreNames.contains(IDB_STORE_THREADS)) db.createObjectStore(IDB_STORE_THREADS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(IDB_STORE_META))    db.createObjectStore(IDB_STORE_META,    { keyPath: "key" });
      // 注意：annotations 内部数据迁移（加 topicId 字段）不在 onupgradeneeded 里跑
      // 原因：cursor.update + put 在 versionchange 事务里嵌套异步比较脆，且 onupgradeneeded 失败回滚不可见
      // → 改在 db open 完成后用普通 readwrite 事务幂等跑 autoMigrateAnnotationsToDefault()，靠 metadata.migrationVersion 防重
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("idb open failed"));
  }).catch((e) => { _idbPromise = null; throw e; });
  return _idbPromise;
}

async function loadAnnotations(key) {
  try {
    const db = await openIdb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch (_) {
    return _memFallback.get(key) || [];
  }
}

async function saveAnnotations(key, list) {
  try {
    const db = await openIdb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(list, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (_) {
    _memFallback.set(key, list);
  }
}

// ── v3-α: topics store CRUD ──
async function loadTopic(id) {
  try {
    const db = await openIdb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_TOPICS, "readonly");
      const req = tx.objectStore(IDB_STORE_TOPICS).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (_) {
    return _memTopics.get(id) || null;
  }
}

async function saveTopic(topic) {
  try {
    const db = await openIdb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_TOPICS, "readwrite");
      tx.objectStore(IDB_STORE_TOPICS).put(topic);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (_) {
    _memTopics.set(topic.id, topic);
  }
}

async function loadAllTopics() {
  try {
    const db = await openIdb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_TOPICS, "readonly");
      const req = tx.objectStore(IDB_STORE_TOPICS).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch (_) {
    return [..._memTopics.values()];
  }
}

// ── v3-α: threads store CRUD（thread 持久化路径预埋；当前 UI 不订阅，后续 PR 接入）──
async function saveThread(thread) {
  // 兜底：thread.id 缺失就不存（防垃圾）
  if (!thread || !thread.id) return;
  // 序列化时只存可序列化字段（messages 是纯对象 OK）
  const record = {
    id: thread.id,
    topicId: thread.topicId || state.currentTopicId,
    pdfKey: thread.pdfKey || state.pdfKey || "",
    annotationId: thread.annotationId || null,
    anchorPage: thread.anchorPage || null,
    anchorColor: thread.anchorColor || null,
    label: thread.label || "",
    // v3-polish #7：持久化用户自定义名（空字符串也 OK，loadThreadsByPdfKey 会还原）
    customName: thread.customName || "",
    quotedText: thread.quotedText || "",
    messages: thread.messages || [],
    createdAt: thread.createdAt || Date.now(),
  };
  try {
    const db = await openIdb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_THREADS, "readwrite");
      tx.objectStore(IDB_STORE_THREADS).put(record);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (_) {
    _memThreads.set(record.id, record);
  }
}

async function loadThreadsByPdfKey(pdfKey) {
  if (!pdfKey) return [];
  try {
    const db = await openIdb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_THREADS, "readonly");
      const req = tx.objectStore(IDB_STORE_THREADS).getAll();
      req.onsuccess = () => {
        const all = req.result || [];
        resolve(all.filter((t) => t.pdfKey === pdfKey));
      };
      req.onerror = () => reject(req.error);
    });
  } catch (_) {
    return [..._memThreads.values()].filter((t) => t.pdfKey === pdfKey);
  }
}

// v3-δ：按 id 删 thread（删 annotation 时联动）
async function deleteThreadById(id) {
  if (!id) return;
  try {
    const db = await openIdb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_THREADS, "readwrite");
      tx.objectStore(IDB_STORE_THREADS).delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (_) {
    _memThreads.delete(id);
  }
}

// v3-δ：所有 thread 持久化的统一入口（限定 pdfKey + topicId）
// 设计：
//   - 调用点不必关心 thread 是否带 pdfKey/topicId 元字段 —— 这里统一注入当前 state 上下文
//   - 失败已在 saveThread 内部 try/catch（IDB 全坏时落到 _memThreads）
//   - 不 await（fire-and-forget）：sendMessage stream 期间不要被 IDB 写阻塞
//   - 边缘：state.pdfKey 为空（极端：thread 创建早于 loadPdf）→ 跳过；下一次写入再补
function persistThread(thread) {
  if (!thread || !thread.id) return;
  if (!state.pdfKey) return; // main thread 在 resetThreads 时就建了，但还没绑 PDF，跳过
  // 注入元字段（thread 对象本身不存 pdfKey/topicId，靠这里写时刻）
  const record = {
    ...thread,
    pdfKey: state.pdfKey,
    topicId: state.currentTopicId || DEFAULT_TOPIC_ID,
  };
  saveThread(record).catch((e) => console.warn("[persistThread]", e));
}

// ── v3-α: metadata store（migrationVersion 等）──
async function readMeta(key) {
  try {
    const db = await openIdb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_META, "readonly");
      const req = tx.objectStore(IDB_STORE_META).get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror = () => reject(req.error);
    });
  } catch (_) {
    return _memMeta.get(key) || null;
  }
}

async function writeMeta(key, value) {
  try {
    const db = await openIdb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_META, "readwrite");
      tx.objectStore(IDB_STORE_META).put({ key, value });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (_) {
    _memMeta.set(key, value);
  }
}

// ── v3-α: 启动期数据准备 ──
// ensureDefaultTopic: 若 IDB 里没有 default topic → 用 DEFAULT_PALETTE 创建一个；
//                     若已有 → 加载到 state.topics 直接复用（保留用户后续可能改过的 label/color）
async function ensureDefaultTopic() {
  let topic = await loadTopic(DEFAULT_TOPIC_ID);
  if (!topic) {
    const now = new Date().toISOString();
    topic = {
      id: DEFAULT_TOPIC_ID,
      name: "默认主题",
      // 深拷贝默认 palette（避免后续编辑器 mutate 到模板）
      palette: DEFAULT_PALETTE.map((p) => ({ ...p })),
      pdfKeys: [],
      createdAt: now,
      // v3-fixup-2: 默认主题首次创建时也冻结时间戳；既有 default（无此字段）保持 undefined
      paletteFrozenAt: now,
    };
    await saveTopic(topic);
  }
  state.topics[topic.id] = topic;
  state.currentTopicId = topic.id;
  return topic;
}

// loadCurrentTopic: 公开 helper —— 后续 PR 切换主题时调用
async function loadCurrentTopic() {
  const id = state.currentTopicId || DEFAULT_TOPIC_ID;
  let topic = await loadTopic(id);
  if (!topic) topic = await ensureDefaultTopic();
  state.topics[topic.id] = topic;
  return topic;
}

// autoMigrateAnnotationsToDefault: 把 v2-b 老 annotations 加上 topicId="default"
// 幂等：只补没有 topicId 的；跑完写 migrationVersion=2 防重复扫描
// 启动时跑一次；migrationVersion 已是 X 就直接跳过对应步骤
//
// v3-γ：migration v3 = 补 default.pdfKeys
//   v3-α 给所有老 ann 补了 topicId="default"，但 default.pdfKeys 还是空 []
//   → 默认主题卡片虚显示 "0 篇"，UX 差
//   修：migrateDefaultPdfKeys() 扫 annotations store，把"有 topicId=default 的 ann"对应的 pdfKey
//        push 到 default.pdfKeys（去重），写回 topics
//   幂等：migrationVersion >= 3 跳过
const MIGRATION_VERSION_KEY = "migrationVersion";
const CURRENT_MIGRATION_VERSION = 4;

// v4 脏 annotation 判定阈值（百分比坐标体系下）
// - 单页 rect 数 > 50：通常是 Cmd+A 全选 / textLayer 异常吞下整段
// - 单 rect 边长 > 0.95：单 rect 近似覆盖整页（容器级 rect 的特征 —— widthPct/heightPct ≈ 1.0）
// 历史教训：阈值 0.5 太严格，把"极宽段落选区（widthPct ~0.7）"误杀；0.95 只挡容器级 rect。
// 源头修复见 describeSelection：跨页选区时 Range.getClientRects() 会返回 textLayer 容器级 rect，
// 那里已直接 filter；这里保留 belt-and-suspenders 守门防止历史脏 ann 残留 + 异常情况。
const DIRTY_PAGE_RECT_LIMIT = 50;
const DIRTY_RECT_SIZE_LIMIT = 0.95;

// v3-polish-3 #2：跨页选段时不把页脚 / page header 加进去
// 跨页选区 = 上一页底部 footer/footnote/页码 + 下一页 header/标题 全被吞进选区 → hl-rect 画在非 body 区域
// heuristic margin：研究学者读 paper 主体集中在 5%-92% 区域；页码 + footnote 通常在底 5-10%，header 在顶 ~3-5%
// trade-off：极少数论文标题或表头真在顶/底 → 接受少量误伤，避免污染跨页选段
// 这条 filter 跟"容器级 rect filter（widthPct>0.95 && heightPct>0.95）"是独立两条，两条都保留
const HEADER_TOP_PCT_LIMIT = 0.05;
const FOOTER_TOP_PCT_LIMIT = 0.92;

function isDirtyAnnotation(ann) {
  if (!ann || !Array.isArray(ann.pages)) return false;
  return ann.pages.some((p) => {
    if (!p || !Array.isArray(p.rects)) return false;
    if (p.rects.length > DIRTY_PAGE_RECT_LIMIT) return true;
    return p.rects.some((r) => (r?.widthPct || 0) > DIRTY_RECT_SIZE_LIMIT || (r?.heightPct || 0) > DIRTY_RECT_SIZE_LIMIT);
  });
}
async function autoMigrateAnnotationsToDefault() {
  // 注意：这一步只负责"给 ann 补 topicId"。版本号在 runMigrations 总入口里统一写。
  try {
    const db = await openIdb();
    // 一次性扫整个 annotations store，给每条记录里的每条 ann 加 topicId（如缺）
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) { resolve(); return; }
        const list = cursor.value || [];
        let changed = false;
        const updated = list.map((ann) => {
          if (ann && !ann.topicId) {
            changed = true;
            return { ...ann, topicId: DEFAULT_TOPIC_ID };
          }
          return ann;
        });
        if (changed) cursor.update(updated);
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    // 迁移失败不阻塞启动；下次启动会再试（idempotent）
    console.warn("[autoMigrateAnnotationsToDefault]", e);
  }
}

// v3-γ migration v3: 把"有 topicId=default 的 ann"对应的 pdfKey 补进 default.pdfKeys
// 不依赖 v2 step 是否跑过（幂等 + 容错）：本步只读 annotations store + 写 topics:default
// 失败 console.warn 不阻塞启动（下次启动再试）
async function migratePdfKeysToDefault() {
  try {
    const db = await openIdb();
    // 1. 扫 annotations store 所有 (pdfKey, ann[]) → 收集"含 default ann"的 pdfKey
    const defaultPdfKeys = await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const store = tx.objectStore(IDB_STORE);
      const req = store.openCursor();
      const keys = new Set();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) { resolve(keys); return; }
        const list = cursor.value || [];
        // 任何一条 ann.topicId === default 就算这个 pdfKey 属于 default
        const hasDefault = list.some((a) => a && a.topicId === DEFAULT_TOPIC_ID);
        if (hasDefault) keys.add(cursor.key);
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
      tx.onerror = () => reject(tx.error);
    });

    if (defaultPdfKeys.size === 0) return; // 没历史 ann，无需补

    // 2. 读出 default topic，去重 push pdfKeys，写回
    // 用 loadTopic + saveTopic 而不是直接事务，保持代码统一（性能差异不重要，启动期一次性）
    let topic = await loadTopic(DEFAULT_TOPIC_ID);
    if (!topic) {
      // 极端：default 还没建（ensureDefaultTopic 失败 / 顺序异常）→ 直接退出让下次启动重来
      console.warn("[migratePdfKeysToDefault] default topic not found, skip");
      return;
    }
    const existing = new Set(topic.pdfKeys || []);
    for (const k of defaultPdfKeys) existing.add(k);
    topic.pdfKeys = [...existing];
    await saveTopic(topic);
    // 内存层同步（state.topics[default] 也要刷新）
    state.topics[DEFAULT_TOPIC_ID] = topic;
  } catch (e) {
    console.warn("[migratePdfKeysToDefault]", e);
  }
}

// v4: 一次性清理 v2-a / v3 累积测试期产生的脏 annotation
// 根因：早期 createAnnotation 无 sanity check，Cmd+A / textLayer 异常选区都会被吞下来
//   → 历史数据里可能存在覆盖整页的巨型 rect / 单页几百 rect 的 ann
// 表现：默认主题 Clio 论文里有一条紫色 ann 含 816×1056 巨型 rect，hl-rect click 命中整页、bubble 显示在屏幕外
// 策略：遍历 annotations store 所有 records，按 isDirtyAnnotation 判定，删脏 ann + 联动删对应 thread
// 幂等：靠 metadata.migrationVersion=4 防重；本函数自身仅一次 cursor 扫
// 容错：失败 console.warn 不阻塞启动；下次启动会再试（直到成功写 migrationVersion=4）
async function cleanDirtyAnnotations() {
  try {
    const db = await openIdb();
    const dirtyThreadIds = []; // 收集要联动删的 thread id
    const reportByPdfKey = new Map(); // pdfKey → 删了几条
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) { resolve(); return; }
        const list = cursor.value || [];
        const kept = [];
        let removed = 0;
        for (const ann of list) {
          if (isDirtyAnnotation(ann)) {
            removed++;
            if (ann.id) dirtyThreadIds.push(ann.id);
          } else {
            kept.push(ann);
          }
        }
        if (removed > 0) {
          reportByPdfKey.set(cursor.key, removed);
          cursor.update(kept);
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
      tx.onerror = () => reject(tx.error);
    });

    // 联动删 thread（每个脏 ann.id 对应一个 thread）
    // 单独事务批量删，失败不影响 ann 清理已完成的事实
    if (dirtyThreadIds.length > 0) {
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(IDB_STORE_THREADS, "readwrite");
          const store = tx.objectStore(IDB_STORE_THREADS);
          for (const tid of dirtyThreadIds) store.delete(tid);
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
      } catch (e) {
        console.warn("[cleanDirtyAnnotations] thread cleanup failed", e);
      }
    }

    const total = [...reportByPdfKey.values()].reduce((a, b) => a + b, 0);
    if (total > 0) {
      console.warn(`[cleanDirtyAnnotations] removed ${total} dirty annotation(s) across ${reportByPdfKey.size} PDF(s):`,
        [...reportByPdfKey.entries()].map(([k, n]) => `${k} (${n})`).join(", "));
    } else {
      console.log("[cleanDirtyAnnotations] 0 dirty annotations found");
    }
  } catch (e) {
    console.warn("[cleanDirtyAnnotations]", e);
  }
}

// 启动期 migration 总入口：按顺序跑、最后统一写版本号
// 设计：每个 step 内部已经容错；本函数只负责"跑过的版本不再跑"
// 现状：CURRENT_MIGRATION_VERSION = 4
//   ver < 2 → ann 补 topicId
//   ver < 3 → default.pdfKeys 补历史
//   ver < 4 → 清理脏 annotation（巨型 rect / 单页 rect 过多）+ 联动删 thread
async function runMigrations() {
  try {
    const ver = (await readMeta(MIGRATION_VERSION_KEY)) || 0;
    if (ver >= CURRENT_MIGRATION_VERSION) return;
    if (ver < 2) {
      await autoMigrateAnnotationsToDefault();
    }
    if (ver < 3) {
      await migratePdfKeysToDefault();
    }
    if (ver < 4) {
      await cleanDirtyAnnotations();
    }
    await writeMeta(MIGRATION_VERSION_KEY, CURRENT_MIGRATION_VERSION);
  } catch (e) {
    console.warn("[runMigrations]", e);
  }
}

// 启动期总入口：先 ensure default topic，再跑 annotation 迁移，最后加载所有 topics 到 state
// 在模块顶层 fire-and-forget 跑；后续 loadPdf 用到 state.topics 时若还没好会落到 ensureDefaultTopic 兜底
// v3-β：额外把 IDB 里所有 topics 拉到内存里，topic grid 渲染时用
const _bootstrapPromise = (async () => {
  await ensureDefaultTopic();
  // v3-γ：用统一 migration 入口（ann 补 topicId + default.pdfKeys 回填，靠 metadata.migrationVersion 幂等）
  await runMigrations();
  const allTopics = await loadAllTopics();
  for (const t of allTopics) {
    // ensureDefaultTopic 已经把 default 写进 state.topics，但若 IDB 里有更"新"版本也要覆盖
    state.topics[t.id] = t;
  }
})().catch((e) => console.warn("[bootstrap]", e));

// ── 选区 → annotation ──
// 把 selection 按 page 切片：每个 page 的 rects（百分比） + 该页文字
function describeSelection(sel) {
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  // 选区必须在 viewer 内（不能是 chat / 输入框 / 色板自己）
  if (!els.viewer.contains(range.commonAncestorContainer)) return null;
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
  if (rects.length === 0) return null;

  // v2-b 修复：每个 rect 找它属于哪个 .page —— 用 .page 列表点包含判定
  // 旧实现用 document.elementFromPoint(cx, cy)：rect 中心在视口外（跨 3+ 页选区中间整页不可见）
  // → elementFromPoint 返回 null → 中间页 rect 全部丢失。
  // 新实现：缓存所有 .page[data-pageNumber] 的 getBoundingClientRect()，
  // 对每个 rect 中心点遍历查表（点 ∈ pageRect）→ 不依赖视口可见性，跨任意页数稳定。
  // PDF.js virtualization 虽然销毁部分 canvas，但 .page DOM 本身保留（v2-a test 已实测验证）。
  const pageEls = els.viewer.querySelectorAll(".page[data-page-number]");
  const pageRects = []; // [{pageNum, pageEl, br}]
  for (const pageEl of pageEls) {
    const pageNum = parseInt(pageEl.dataset.pageNumber, 10);
    if (!pageNum) continue;
    const br = pageEl.getBoundingClientRect();
    if (br.width === 0 || br.height === 0) continue;
    pageRects.push({ pageNum, pageEl, br });
  }
  const byPage = new Map(); // pageNumber → { pageEl, items: [r, ...] }
  for (const r of rects) {
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    // 在缓存的 page 列表里找包含该中心点的页（点包含 = cx∈[left,right) ∧ cy∈[top,bottom)）
    let matched = null;
    for (const p of pageRects) {
      if (cx >= p.br.left && cx < p.br.right && cy >= p.br.top && cy < p.br.bottom) {
        matched = p; break;
      }
    }
    if (!matched) continue;
    if (!byPage.has(matched.pageNum)) byPage.set(matched.pageNum, { pageEl: matched.pageEl, items: [] });
    byPage.get(matched.pageNum).items.push(r);
  }
  if (byPage.size === 0) return null;

  // 计算每页 rect 的百分比坐标 + 提取该页文字
  const pages = [];
  const sortedPageNums = [...byPage.keys()].sort((a, b) => a - b);
  for (const pn of sortedPageNums) {
    const { pageEl, items } = byPage.get(pn);
    const pr = pageEl.getBoundingClientRect();
    if (pr.width === 0 || pr.height === 0) continue;
    const rectsRaw = items.map((r) => ({
      leftPct:   (r.left - pr.left) / pr.width,
      topPct:    (r.top  - pr.top ) / pr.height,
      widthPct:  r.width  / pr.width,
      heightPct: r.height / pr.height,
    }));
    // v3-polish-4 #2：脚注 heuristic —— 字号明显小于正文（heightPct < 正文中位数 * 0.7）的 rect 多半是脚注
    // 论文脚注的横杠分隔条由 canvas 画，不在 textLayer 里、无法直接检测；只能靠字号特征 heuristic
    // trade-off：极端 mix 字号文档（小字标题/角标）可能误杀，但跨页选段把脚注混进高亮的体验更糟，鸭鸭可接受
    // 中位数取所有 rect heightPct 的中位，再以 0.7 倍为阈值（约下限 70% 字号）
    const heightsSorted = rectsRaw.map((r) => r.heightPct).sort((a, b) => a - b);
    const pageMedianHeight = heightsSorted.length > 0
      ? heightsSorted[Math.floor(heightsSorted.length / 2)]
      : 0;
    const FOOTNOTE_HEIGHT_RATIO = 0.7;
    // v3-polish-5：位置 heuristic —— 在底部 30% 且字号略小于正文（median * 0.85）= 脚注的可能性极高
    // 单独 0.7 的字号阈值不够松（脚注字号常常是 75-90% 正文），但合上"位置在底部"就够准
    const FOOTNOTE_BOTTOM_TOP_PCT = 0.7;
    const FOOTNOTE_BOTTOM_HEIGHT_RATIO = 0.85;
    const rects2 = rectsRaw.filter((r) => {
      // 过滤 1：跨页选区时 Range.getClientRects() 会返回 .textLayer 容器级整页 rect
      // （widthPct≈1.0 && heightPct≈1.0），它们不是真的字符 bbox，必须过滤。
      // 阈值 0.95 留余量：极宽段落最宽 ~0.7、极高单 rect ~0.05，都不会被误伤。
      // 不过滤的后果：isDirtyAnnotation 看到 1.0×1.0 rect → 整段 reject，跨页选段全废。
      if (r.widthPct > 0.95 && r.heightPct > 0.95) return false;
      // 过滤 2（v3-polish-3 #2）：跨页选段时跳过页脚 / page header rect
      // 跨页选区的副作用：上页 footer/页码 + 下页 header 都被吞进 selection rect
      // 用 topPct 阈值粗略框出 body 主区域（5%-92%），超出即丢
      // 单页选段也会过这条 filter —— 一致行为
      if (r.topPct < HEADER_TOP_PCT_LIMIT || r.topPct > FOOTER_TOP_PCT_LIMIT) return false;
      // 过滤 3（v3-polish-4 #2）：字号小于正文中位数 70% 的 rect = 脚注 heuristic（横杠 canvas 画不到，只能凭字号）
      if (pageMedianHeight > 0 && r.heightPct < pageMedianHeight * FOOTNOTE_HEIGHT_RATIO) return false;
      // 过滤 4（v3-polish-5）：位置在页底 30% 且字号 < 正文 85% → 脚注（论文常见 footnote 字号差 ~80-90%）
      if (pageMedianHeight > 0
          && r.topPct > FOOTNOTE_BOTTOM_TOP_PCT
          && r.heightPct < pageMedianHeight * FOOTNOTE_BOTTOM_HEIGHT_RATIO) return false;
      return true;
    });
    if (rects2.length === 0) continue;
    // 该页文字：截取 range 与该页 textLayer 的交集
    const textLayer = pageEl.querySelector(".textLayer");
    let pageText = "";
    if (textLayer) {
      const sub = range.cloneRange();
      // 把 sub range 截到该 page textLayer 边界内
      try {
        if (!textLayer.contains(sub.startContainer)) {
          sub.setStart(textLayer, 0);
        }
        if (!textLayer.contains(sub.endContainer)) {
          sub.setEnd(textLayer, textLayer.childNodes.length);
        }
        pageText = sub.toString().replace(/\s+/g, " ").trim();
      } catch (_) { /* range 边界异常时退回整段 */ }
    }
    pages.push({ page: pn, text: pageText, rects: rects2 });
  }
  if (pages.length === 0) return null;

  // v3-polish-5：跨页选段时按页位置过滤 rect —— 起点页只要尾部、终点页只要头部
  // 直觉：跨 N 页选段，用户真正想要的是"起点页末尾 + 终点页开头 + 中间页全部"
  //       中间任何额外字（脚注 / 页码 / 跨页穿插的角注）都不是用户的意图
  // 单页选段不受此影响（仅 length > 1 时触发）
  if (pages.length > 1) {
    pages.forEach((p, i) => {
      const isFirst = i === 0;
      const isLast = i === pages.length - 1;
      p.rects = p.rects.filter((r) => {
        if (isFirst) return r.topPct > 0.3;  // 起点页：只要下半部（尾部）
        if (isLast)  return r.topPct < 0.7;  // 终点页：只要上半部（头部）
        return true;                          // 中间页：全保留
      });
    });
  }
  // 去掉过滤后空页
  const finalPages = pages.filter((p) => p.rects.length > 0);
  if (finalPages.length === 0) return null;

  // 全文 = 各页拼接（跨页用空格分隔）
  const fullText = finalPages.map((p) => p.text).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  if (!fullText) return null;

  return { pages: finalPages, text: fullText };
}

// v3-polish-3：根据 ann 查它所属 topic 的 palette tag，取 hex 颜色用于 hl-rect 内联 background
// 找不到（老 ann 无 topicId / palette 已被改 / tag.id 漂移）→ 返回 null，由 CSS .color-<id> fallback 处理
function resolveAnnHex(ann) {
  const topicId = ann?.topicId || state.currentTopicId || DEFAULT_TOPIC_ID;
  const palette = state.topics[topicId]?.palette || [];
  const tag = palette.find((t) => t.id === ann.color);
  return tag?.color || null;
}

// 给某页画 / 重画该页所有 annotation 的 rect
function renderHighlightsForPage(pageNumber) {
  const pageEl = els.viewer.querySelector(`.page[data-page-number="${pageNumber}"]`);
  if (!pageEl) return;
  // 该页的 highlight-layer：没有就建，有就清空重画（处理 viewer 切走再切回的情况）
  let layer = pageEl.querySelector(":scope > .highlight-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "highlight-layer";
    pageEl.appendChild(layer);
  } else {
    layer.replaceChildren();
  }
  for (const ann of state.annotations) {
    const pageEntry = ann.pages.find((p) => p.page === pageNumber);
    if (!pageEntry) continue;
    const hex = resolveAnnHex(ann);
    for (const rect of pageEntry.rects) {
      const div = document.createElement("div");
      // 保留 color-${id} class 作为 CSS fallback（palette 查不到 tag 时仍能上色）
      div.className = `hl-rect color-${ann.color}`;
      div.dataset.annId = ann.id;
      div.style.left   = `${rect.leftPct * 100}%`;
      div.style.top    = `${rect.topPct  * 100}%`;
      div.style.width  = `${rect.widthPct * 100}%`;
      // v3-polish-4 #1：高度收缩到 88%（行间留 12% 空白）→ 多行 rect 不再上下边缘 1-2px overlap
      // 解决"多行高亮叠加处出现深色条纹"的视觉不协调（alpha 0.40 + 0.40 ≈ 0.64 那条窄带）
      div.style.height = `${rect.heightPct * 0.88 * 100}%`;
      // 命中 palette → inline hex（兼容自定义颜色）；命中失败 → CSS fallback
      if (hex) div.style.background = hex;
      div.title = `${COLOR_MAP[ann.color]?.emoji || ""} ${ann.text.slice(0, 40)}${ann.text.length > 40 ? "…" : ""}`;
      layer.appendChild(div);
    }
  }
}

function renderAllHighlights() {
  for (let i = 1; i <= state.totalPages; i++) renderHighlightsForPage(i);
}

// v3-polish #6：增量 append 单个 ann 的 rect（不重建整层）
// 用于 createAnnotation 性能优化：避免 replaceChildren + 重画同页所有 rect 带来的卡顿
// 边缘：若目标页 .highlight-layer 还不存在（PDF 页未渲染），lazy 建一个空 layer 等 textlayerrendered；
//      但 createAnnotation 永远是当前可见页发起 → layer 必然已存在（renderHighlightsForPage 在 textlayerrendered 已建）
function appendAnnotationRects(ann) {
  for (const pageEntry of ann.pages) {
    const pageEl = els.viewer.querySelector(`.page[data-page-number="${pageEntry.page}"]`);
    if (!pageEl) continue;
    let layer = pageEl.querySelector(":scope > .highlight-layer");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "highlight-layer";
      pageEl.appendChild(layer);
    }
    // 防御：同一 ann 已经有 rect 不要重复 append（switchThread 等再次触发时静默跳过）
    if (layer.querySelector(`.hl-rect[data-ann-id="${ann.id}"]`)) continue;
    const frag = document.createDocumentFragment();
    const hex = resolveAnnHex(ann);
    for (const rect of pageEntry.rects) {
      const div = document.createElement("div");
      // 保留 color-${id} class 作为 CSS fallback（palette 查不到 tag 时仍能上色）
      div.className = `hl-rect color-${ann.color}`;
      div.dataset.annId = ann.id;
      div.style.left   = `${rect.leftPct * 100}%`;
      div.style.top    = `${rect.topPct  * 100}%`;
      div.style.width  = `${rect.widthPct * 100}%`;
      // v3-polish-4 #1：与 renderHighlightsForPage 对齐 —— heightPct *= 0.88 让行间留 12% 空白
      div.style.height = `${rect.heightPct * 0.88 * 100}%`;
      if (hex) div.style.background = hex;
      div.title = `${COLOR_MAP[ann.color]?.emoji || ""} ${ann.text.slice(0, 40)}${ann.text.length > 40 ? "…" : ""}`;
      frag.appendChild(div);
    }
    layer.appendChild(frag);
  }
}

// ── v3-γ：按当前主题 palette 动态渲染色板按钮 ──
// 触发时机：switchToReader / updateReaderTopicHint 后调用（即每次进 reader / 切主题）
// v3-polish：去掉 cp-close 按钮（取消选中 / mouseleave / 滚动 / 点空白都会自动 hide，× 是冗余）
// data-color = palette.id（"red" / "cN-xxxx" 等任意 slug，createAnnotation 凭此查 palette）
// data-tag-label = palette.label（aria-label / 调试用）
// title = "<emoji> <label>"（hover tooltip 显示语义）
function renderColorPalette() {
  if (!els.colorPalette) return;
  const topic = state.topics[state.currentTopicId];
  const palette = topic?.palette || [];
  // 全清重建（按钮数量随 palette 变化）
  els.colorPalette.replaceChildren();
  for (const tag of palette) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cp-btn";
    btn.dataset.color = tag.id;
    btn.dataset.tagLabel = tag.label || "";
    btn.title = `${tag.emoji || ""} ${tag.label || ""}`.trim();
    btn.setAttribute("aria-label", tag.label || tag.emoji || tag.id);
    btn.textContent = tag.emoji || "●";
    els.colorPalette.appendChild(btn);
  }
}

// ── 色板：mouseup 后判断有无选区，有则浮出 ──
let _pendingSelection = null;  // 缓存当前选区描述，等用户点色

// 悬浮缓冲：鼠标从 hl-rect/选区移到色板/气泡按钮的路径上不能闪掉
// mouseleave 触发 150ms 延时 hide；150ms 内 mouseenter 取消
const HOVER_HIDE_DELAY = 150;
let _paletteHideTimer = null;
let _bubbleHideTimer = null;

function showColorPalette() {
  // show 时清掉残留 timer（防止上一次 mouseleave 的 timeout 误关新 palette）
  if (_paletteHideTimer) { clearTimeout(_paletteHideTimer); _paletteHideTimer = null; }
  const sel = window.getSelection();
  const desc = describeSelection(sel);
  if (!desc) { hideColorPalette(); return; }
  _pendingSelection = desc;
  // 色板位置：定位到选区第一个 rect 上方（相对 viewerContainer）
  // 用 range 的第一个 rect 而不是 desc 的百分比，避免再换算
  const range = sel.getRangeAt(0);
  const rects = range.getClientRects();
  const firstRect = rects[0];
  if (!firstRect) { hideColorPalette(); return; }
  const cont = els.viewerContainer.getBoundingClientRect();
  // 色板尺寸大约 220x40
  const PALETTE_W = 240, PALETTE_H = 38, GAP = 8;
  // 选区上方放不下时放下方
  let top = firstRect.top - cont.top + els.viewerContainer.scrollTop - PALETTE_H - GAP;
  if (top < els.viewerContainer.scrollTop + 4) {
    // 上方放不下 → 放在选区下方（用 last rect）
    const lastRect = rects[rects.length - 1];
    top = lastRect.bottom - cont.top + els.viewerContainer.scrollTop + GAP;
  }
  let left = firstRect.left - cont.left + els.viewerContainer.scrollLeft;
  // 不超出右边界
  const maxLeft = els.viewerContainer.scrollLeft + cont.width - PALETTE_W - 4;
  if (left > maxLeft) left = maxLeft;
  if (left < els.viewerContainer.scrollLeft + 4) left = els.viewerContainer.scrollLeft + 4;

  els.colorPalette.style.left = `${left}px`;
  els.colorPalette.style.top  = `${top}px`;
  els.colorPalette.hidden = false;
}

function hideColorPalette() {
  // 兜底清 timer：避免 hide 后 timeout 还在跑、回头把刚 show 的新 palette 又关掉
  if (_paletteHideTimer) { clearTimeout(_paletteHideTimer); _paletteHideTimer = null; }
  els.colorPalette.hidden = true;
  _pendingSelection = null;
}

function hideHlBubble() {
  if (_bubbleHideTimer) { clearTimeout(_bubbleHideTimer); _bubbleHideTimer = null; }
  els.hlBubble.hidden = true;
  els.hlBubble.dataset.annId = "";
}

// ── 创建 annotation：选完色后调用 ──
async function createAnnotation(color) {
  const desc = _pendingSelection;
  hideColorPalette();
  if (!desc) return;
  // v4 守门：拒绝异常超大选区（Cmd+A / textLayer 异常 → 整页 rect / 单页几百 rect）
  // 根因：早期版本无 sanity check，把脏数据写进 IDB（migration v4 同步清历史数据）
  // UX：默默 reject + console.warn —— 用户看到 hl-rect 没出现自然感知"选区无效"，不弹 UI 避免打扰阅读
  // 跨页正常选区不受影响：按单页判定，10 页跨页选区每页 ~10 小 rect 不触发
  if (isDirtyAnnotation(desc)) {
    console.warn("[createAnnotation] selection rejected (too large / dirty):", {
      pageCount: desc.pages.length,
      maxRectsPerPage: Math.max(...desc.pages.map((p) => p.rects.length)),
      maxRectWidthPct: Math.max(...desc.pages.flatMap((p) => p.rects.map((r) => r.widthPct || 0))),
      maxRectHeightPct: Math.max(...desc.pages.flatMap((p) => p.rects.map((r) => r.heightPct || 0))),
    });
    return;
  }
  // v3-γ：物理校验 color ∈ 当前主题 palette
  // 触发情景：① toolbar 被注入伪造 button ② 旧 ann.color 残留 ③ palette 编辑器变更后 stale 引用
  // 防御策略：palette.find(t => t.id === color) 找不到则 console.warn + reject 创建（不静默 fallback）
  // 注意：palette 为空时 reject 所有 color（极端情况下兜底）—— 防止生成无主题归属的 ann
  const palette = state.topics[state.currentTopicId]?.palette || [];
  const tag = palette.find((t) => t.id === color);
  if (!tag) {
    console.warn("[createAnnotation] color not in palette, rejecting:", color, "palette ids:", palette.map((t) => t.id));
    return;
  }
  const ann = {
    id: (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`),
    color,
    text: desc.text,
    pages: desc.pages,
    // v3-α：新建 annotation 自动归入当前主题（默认 "default"）
    topicId: state.currentTopicId || DEFAULT_TOPIC_ID,
    createdAt: new Date().toISOString(),
  };
  state.annotations.push(ann);
  // 清掉浏览器选区（视觉上让用户感受到"动作完成"）
  window.getSelection()?.removeAllRanges();
  // v3-polish #6：增量画新 ann 的 rect（不再 replaceChildren 整层重建）
  // 旧路径：renderHighlightsForPage → layer.replaceChildren + 遍历 state.annotations 全画
  //         随高亮数量线性变慢 + 同页所有 hl-rect 闪一下（GPU 重 layout）
  // 新路径：只 append 本 ann 的 rect 到 highlight-layer，O(本次 rect 数)
  appendAnnotationRects(ann);
  // saveAnnotations 是 IDB 异步写（put）；不会阻塞主线程，保留原 fire-and-forget
  saveAnnotations(state.pdfKey, state.annotations).catch((e) => console.warn("[save]", e));
  // v2-b：创建对应 thread + 自动切到这个 thread
  // v3-polish-2 #5：自动切 thread **不滚动** —— 保留用户刚画线的视角
  //                只有显式切（点击 thread-list / hl-bubble "引用"）才滚到 anchorPage
  ensureAnnotationThread(ann);
  switchThread(ann.id, { autoScroll: false });
  // 创建即引用：渲染独立 chip 到 chatInput 上方（不再污染 textarea）
  quoteAnnotationToChat(ann);
}

// ── 为 annotation 建立对应 thread（重复调用幂等）──
function ensureAnnotationThread(ann) {
  if (state.threads[ann.id]) return state.threads[ann.id];
  const pageNums = ann.pages.map((p) => p.page);
  state.threads[ann.id] = {
    id: ann.id,
    annotationId: ann.id,
    anchorPage: pageNums[0],
    anchorColor: ann.color,
    label: threadLabel(ann),
    // v3-polish #7：customName 默认空，由用户在 thread list 改名后填入
    customName: "",
    quotedText: ann.text,
    messages: [],
    createdAt: Date.now(),
  };
  return state.threads[ann.id];
}

// ── 删除 annotation ──
// optimistic：先同步把 DOM 那些 rect remove + 隐藏气泡（用户瞬间看到效果），
//             再清 state.annotations + 重渲染该页（处理叠色重排），最后异步 save。
async function deleteAnnotation(id) {
  const idx = state.annotations.findIndex((a) => a.id === id);
  if (idx < 0) return;
  const ann = state.annotations[idx];
  // 1. 同步直接抹掉 DOM 上所有 data-ann-id=id 的 hl-rect（视觉上瞬间消失）
  const rects = els.viewer.querySelectorAll(`.hl-rect[data-ann-id="${id}"]`);
  rects.forEach((el) => el.remove());
  // 2. 隐藏气泡（如果当前显示的是这个 ann）
  hideHlBubble();
  // 3. 从 state 移除
  state.annotations.splice(idx, 1);
  // 4. v2-b：联动删 thread；若正在看这个 thread → 切回 main
  if (state.threads[id]) {
    delete state.threads[id];
    // v3-δ：联动删 IDB thread record（避免下次 hydrate 时出现孤儿 thread）
    deleteThreadById(id).catch((e) => console.warn("[deleteThreadById]", e));
    if (state.currentThreadId === id) {
      switchThread("main");
    } else {
      updateThreadSummary();
    }
  }
  // 5. 重新渲染受影响页，让其他 ann 的叠色重排到位（同步，但只动这几页）
  for (const p of ann.pages) renderHighlightsForPage(p.page);
  // 6. 异步存
  saveAnnotations(state.pdfKey, state.annotations).catch((e) => console.warn("[save]", e));
}

// ── 切 thread：渲染对应 messages + 滚到 anchorPage（如有）──
// 切之前先 abort 正在进行的 streaming（避免回复落到错的 thread 里）
// v3-polish-2 #5：加 autoScroll 选项区分"显式切"（用户点击）vs "自动切"（createAnnotation 内部）
//   autoScroll=true（默认）：用户行为，滚到 anchorPage + 居中显示 hl-rect
//   autoScroll=false：createAnnotation 刚画完高亮后内部切 thread，**保持视角不动**
//                     —— 鸭鸭：选中颜色后不要动页面，只有切 thread 才跳
function switchThread(threadId, opts) {
  const autoScroll = !opts || opts.autoScroll !== false;
  if (!state.threads[threadId]) return;
  if (state.currentThreadId === threadId) {
    updateThreadSummary();
    return;
  }
  // 流式中切走 → abort（让那个 thread 的 user 消息自然回滚，由 sendMessage 的 catch 处理）
  if (state.streaming && state.abortCtl) {
    state.abortCtl.abort();
  }
  state.currentThreadId = threadId;
  renderChatFromThread();
  updateThreadSummary();
  closeThreadList();
  // 切到高亮 thread → 滚到锚定页 + 短暂强调该 ann 的 rect（仅显式切）
  const thread = state.threads[threadId];
  if (autoScroll && thread.anchorPage && state.pdf) {
    try {
      pdfViewer.scrollPageIntoView({ pageNumber: thread.anchorPage });
    } catch (_) { /* viewer 未就绪时忽略 */ }
    if (thread.annotationId) {
      // 等下一帧，让 PDF 页元素被滚到位 / hl-rect 已被画上
      // （textlayerrendered 触发的 renderHighlightsForPage 已经 sync 完成 DOM；
      //   PDF.js scrollPageIntoView 也是同步的，但布局还没刷 → rAF 安全）
      requestAnimationFrame(() => {
        const rect = els.viewer.querySelector(`.hl-rect[data-ann-id="${thread.annotationId}"]`);
        if (rect && typeof rect.scrollIntoView === "function") {
          rect.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        flashAnnotation(thread.annotationId);
      });
    }
  }
  // 切到 thread 后，textarea 清空（避免上一个 thread 没发完的草稿混进来）
  // pendingQuote 也清空（每个 thread 的引用语境独立；createAnnotation 后续会重设新 chip）
  els.chatInput.value = "";
  autoGrow(els.chatInput);
  clearPendingQuote();
}

// 用 CSS class 闪一下对应 ann 的 rect（视觉强化"切过来了"）
function flashAnnotation(annId) {
  const rects = els.viewer.querySelectorAll(`.hl-rect[data-ann-id="${annId}"]`);
  rects.forEach((el) => {
    el.classList.add("hl-flash");
    // 一次性动画，结束后清掉 class（不影响后续 hover/style）
    setTimeout(() => el.classList.remove("hl-flash"), 900);
  });
}

// 把当前 thread 的 messages 渲染到 chat 区
function renderChatFromThread() {
  const thread = getCurrentThread();
  els.chatMessages.replaceChildren();
  for (const m of thread.messages) {
    // user 消息要把 [CURRENT_PAGE: N]\n 前缀去掉再显示（与 sendMessage 中保存逻辑对齐）
    if (m.role === "user") {
      const display = m.content.replace(/^\[CURRENT_PAGE:\s*\d+\]\n/, "");
      appendMsgBubble("user", display);
    } else {
      appendMsgBubble("assistant", m.content);
    }
  }
}

// ── 引用到对话：渲染 chip 到 chatInput 上方独立行（v3-polish-2 #3 UX 改造）──
// 旧路径：把 "> [p.N · 🔴] '...'" 直接 prepend 到 chatInput.value
//        → 占用输入框、文字混在草稿里、用户难以区分自己打的字与引用
// 新路径：渲染独立 chip 到 #chatQuoteBar，含 emoji + 页码 + 截断 quote + ✕ 取消
//        chatInput 始终纯净，只承载用户输入；发送时 sendMessage 拼接 pendingQuote
// v3-polish-2 #3：引用块**恢复**颜色 emoji（鸭鸭说之前 v3-polish 我去掉是错的；emoji 指的是主题 dot，不是引用块的）
function quoteAnnotationToChat(ann) {
  // 页码：单页用 "p.N"，跨页用 "p.N-M"
  const pageNums = ann.pages.map((p) => p.page);
  const pageLabel = pageNums.length === 1
    ? `p.${pageNums[0]}`
    : `p.${pageNums[0]}-${pageNums[pageNums.length - 1]}`;
  // chip 显示用的截断版本（~80 字符）；发送时另算一份给 LLM
  const MAX_CHIP_QUOTE = 80;
  const chipQuoted = ann.text.length > MAX_CHIP_QUOTE
    ? ann.text.slice(0, MAX_CHIP_QUOTE) + "…"
    : ann.text;
  const palette = state.topics[state.currentTopicId]?.palette || [];
  const tag = palette.find((t) => t.id === ann.color);
  // emoji 优先取 palette 自带，否则回退到全局 COLOR_MAP（兼容老 ann）
  const emoji = tag?.emoji || COLOR_MAP[ann.color]?.emoji || "●";
  // 一次只允许一条 pending quote：新选段创建新引用 → 直接覆盖旧 chip
  state.pendingQuote = {
    annId: ann.id,
    color: ann.color,
    emoji,
    pageLabel,
    quoted: chipQuoted,
    // 完整文本另存（发送时拼给 LLM，可比 chip 截断版长，但仍受 MAX_QUOTE 限制）
    fullQuoted: ann.text.length > 400 ? ann.text.slice(0, 400) + "…" : ann.text,
  };
  renderChatQuoteBar();
  els.chatInput.focus();
}

// ── 渲染 / 隐藏 chip ──
function renderChatQuoteBar() {
  const bar = els.chatQuoteBar;
  if (!bar) return;
  const q = state.pendingQuote;
  if (!q) {
    bar.replaceChildren();
    bar.hidden = true;
    return;
  }
  bar.replaceChildren();
  const chip = document.createElement("div");
  chip.className = "quote-chip";
  chip.dataset.annId = q.annId;
  const label = document.createElement("span");
  label.className = "qc-label";
  label.textContent = `${q.emoji} ${q.pageLabel} "${q.quoted}"`;
  label.title = q.quoted; // 鼠标 hover 看完整截断文本
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "qc-close";
  closeBtn.setAttribute("aria-label", "取消引用");
  closeBtn.title = "取消引用";
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => {
    state.pendingQuote = null;
    renderChatQuoteBar();
    els.chatInput.focus();
  });
  chip.appendChild(label);
  chip.appendChild(closeBtn);
  bar.appendChild(chip);
  bar.hidden = false;
}

function clearPendingQuote() {
  state.pendingQuote = null;
  renderChatQuoteBar();
}

// ── 单击已有高亮 → 浮出气泡 ──
function showHlBubble(annId, anchorRect) {
  const ann = state.annotations.find((a) => a.id === annId);
  if (!ann) return;
  hideColorPalette();
  // show 时清掉残留 timer（防止上一次 mouseleave 的 timeout 误关新 bubble）
  if (_bubbleHideTimer) { clearTimeout(_bubbleHideTimer); _bubbleHideTimer = null; }
  els.hlBubble.dataset.annId = annId;
  // 定位：高亮 rect 上方居中
  const cont = els.viewerContainer.getBoundingClientRect();
  const BUBBLE_H = 32, GAP = 6;
  let top = anchorRect.top - cont.top + els.viewerContainer.scrollTop - BUBBLE_H - GAP;
  if (top < els.viewerContainer.scrollTop + 4) {
    top = anchorRect.bottom - cont.top + els.viewerContainer.scrollTop + GAP;
  }
  let left = anchorRect.left - cont.left + els.viewerContainer.scrollLeft;
  const maxLeft = els.viewerContainer.scrollLeft + cont.width - 140;
  if (left > maxLeft) left = maxLeft;
  if (left < els.viewerContainer.scrollLeft + 4) left = els.viewerContainer.scrollLeft + 4;
  els.hlBubble.style.left = `${left}px`;
  els.hlBubble.style.top  = `${top}px`;
  els.hlBubble.hidden = false;
}

// ────────────────────── chatClient ──────────────────────
// v2-b：消息收发都基于"当前 thread"
//   - state.threads[currentThreadId].messages 是真实历史，caching 前缀 = system + pdf_text + 该 thread 的历史
//   - 不同 thread 各自独立的对话上下文（同一 PDF 共享 system + pdf_text 大前缀 → caching 命中率仍很高）
async function sendMessage(userText) {
  if (state.streaming) return;
  const thread = getCurrentThread();
  const pageTag = `[CURRENT_PAGE: ${state.currentPage}]\n`;
  // v3-polish-2 #3：pendingQuote chip → 拼到 user message 头部
  //   block 格式与旧版本保持一致："> [p.N · 🔴] '...'\n\n"
  //   这样 agent 看到的引用块格式不变（system prompt / 既有 LLM 习惯都已熟悉），
  //   只是 UI 层把它从 textarea 移到独立 chip
  let userPayload = userText;
  let userDisplay = userText;
  if (state.pendingQuote) {
    const q = state.pendingQuote;
    const quoteBlock = `> [${q.pageLabel} · ${q.emoji}] "${q.fullQuoted}"\n\n`;
    userPayload = quoteBlock + userText;
    userDisplay = quoteBlock + userText; // 在 chat 气泡里也保留引用，让用户回顾时知道自己引了什么
  }
  const userMsg = { role: "user", content: pageTag + userPayload };
  thread.messages.push(userMsg);
  appendMsgBubble("user", userDisplay); // 给用户看的不带 [CURRENT_PAGE] 标签
  // 引用已随消息发出 → 清空 chip
  clearPendingQuote();
  // v3-δ：user 消息入 thread 立刻持久化（捕获"刚发出去就刷新"的极端情况）
  persistThread(thread);
  setStreaming(true);
  // 锁住开始 send 时的 thread —— 中途切 thread 时不会污染其他 thread
  const sendThreadId = state.currentThreadId;

  const assistantEl = appendMsgBubble("assistant", "", true);
  const contentEl = assistantEl.querySelector(".content");
  contentEl.textContent = "…"; // 给个等待提示，避免完全空
  let fullText = "";
  state.abortCtl = new AbortController();

  // v3-α: palette 规则作为 system role 第一条 prepend 到 messages
  // server.py 不动 → server 拼出来的最终 messages = [server_system(SYSTEM_PROMPT+pdf_text), palette_system, ...thread.messages]
  // 多 system role 是合法 OpenAI 协议（provider 会自然 concat）
  // caching 影响：palette_system 字符串前缀稳定 → 同主题任意请求前缀字节序列一致；改 palette = 失效（合理）
  // 注意：跨 PDF 的完整前缀命中需要 server.py 把 palette 拼到 SYSTEM_PROMPT 后、pdf_text 前才能做到；
  //       v3-α 阶段不动 server.py，此处只保证 messages 协议正确 + system_prompt.md 的 tag 规则段被注入
  const paletteRules = buildPaletteRules(state.topics[state.currentTopicId]?.palette);
  const messagesWithPalette = paletteRules
    ? [{ role: "system", content: paletteRules }, ...thread.messages]
    : thread.messages;

  // v3-γ caching 验证日志：跨 PDF 同主题打开第 2 篇时，比 messages[0] 字节是否一致
  // hash 用极简 djb2（无依赖，唯一性够给同一 session 内观察），不传上游
  // 注意：messages[0] 在有 paletteRules 时是 palette system；无时是 thread 第一条 user
  //   → 同主题不同 PDF 下 paletteRules 字节相同 → messages[0] 应稳定
  //   → server.py 拼 SYSTEM_PROMPT + pdf_text 作为 server_system，是另一层 caching 前缀（不在前端 hash 范围）
  // 开启方式：window.__coreadCachingDebug = true（默认开，关掉用 false）
  if (window.__coreadCachingDebug !== false && messagesWithPalette[0]) {
    const m0 = messagesWithPalette[0];
    const s = (m0.role || "") + "|" + (typeof m0.content === "string" ? m0.content : JSON.stringify(m0.content));
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    const hashHex = (h >>> 0).toString(16).padStart(8, "0");
    console.debug(
      "[v3-γ caching] messages[0]",
      "role=" + m0.role,
      "len=" + s.length,
      "hash=" + hashHex,
      "topic=" + (state.currentTopicId || "?")
    );
  }

  try {
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: messagesWithPalette,
        pdf_text: state.pdfText,
      }),
      signal: state.abortCtl.signal,
    });

    // HTTP 层错误（4xx/5xx）
    if (!r.ok) {
      const errBody = await r.text();
      throw new Error(extractErrorMessage(errBody) || `HTTP ${r.status}`);
    }

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let sawAnySSE = false;
    let rawAll = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      rawAll += chunk;
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (!trimmed.startsWith("data:")) continue;
        sawAnySSE = true;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const j = JSON.parse(data);
          // 上游 provider 偶尔会在 200 流里夹错误对象
          if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
          const delta = j.choices?.[0]?.delta?.content || "";
          if (delta) {
            fullText += delta;
            renderAssistant(contentEl, fullText);
            els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
          }
        } catch (e) {
          // 单行 JSON 解析失败可能是分片，继续。但 e 是抛 Error（带 message）则上抛
          if (e instanceof Error && e.message && !e.message.startsWith("Unexpected")) throw e;
        }
      }
    }

    // 整个流都没看到 SSE 行 → 上游返回的不是流（多半是错误 JSON）
    if (!sawAnySSE) {
      const msg = extractErrorMessage(rawAll) || "上游返回的不是流式响应。";
      throw new Error(msg);
    }

    if (!fullText.trim()) {
      throw new Error("上游返回空内容（可能被安全过滤或额度耗尽）。");
    }

    // 写回**发起 send 时锁定**的 thread（thread 可能已被切走 / 删除）
    const tgt = state.threads[sendThreadId];
    if (tgt) {
      tgt.messages.push({ role: "assistant", content: fullText });
      // v3-δ：assistant 完成 → 持久化
      persistThread(tgt);
    }
  } catch (e) {
    const tgt = state.threads[sendThreadId];
    if (e.name === "AbortError") {
      renderAssistant(contentEl, fullText + "\n\n_（已中止）_");
      if (tgt) {
        if (fullText) {
          tgt.messages.push({ role: "assistant", content: fullText });
        } else {
          // 首 token 前就 abort：没收到任何 assistant 内容 → user 消息也回滚
          // 否则下次发送会出现 [..., user, user] 违反 OpenAI 协议
          tgt.messages.pop();
        }
        // v3-δ：abort 后也要 persist（user 留 / user 回滚 / 半成品 assistant 都有可能）
        persistThread(tgt);
      }
    } else {
      console.error("[sendMessage]", e);
      contentEl.innerHTML = "";
      const errEl = document.createElement("div");
      errEl.className = "err";
      // v3-fixup-2: 上游错误体可能是一坨 HTML（如 502 Bad Gateway 的 nginx 错误页 / Cloudflare 拦截页），
      // 直接 textContent 进 bubble 虽不会渲染但显示为长串字符串吓人。
      // 策略：长 > 200 字符 或 看起来含 HTML tag（"<x" 模式）→ 截断 + 友好提示，原文 console.warn。
      // trade-off：代码字符串 "if (x < y)" 也会命中"含 <"，但只影响显示策略不影响功能，可接受。
      const rawMsg = String(e.message || e);
      const looksLikeHtml = /<[a-zA-Z!\/]/.test(rawMsg);
      if (rawMsg.length > 200 || looksLikeHtml) {
        console.warn("[sendMessage] 上游原始错误内容（已截断显示）:", rawMsg);
        errEl.textContent = "⚠ 上游返回格式异常（详情见 console）";
      } else {
        errEl.textContent = `⚠ ${rawMsg}`;
      }
      contentEl.appendChild(errEl);
      // 失败的 user 消息也回滚，避免下次请求重复带上失败 turn
      if (tgt) {
        tgt.messages.pop();
        persistThread(tgt);
      }
    }
  } finally {
    assistantEl.classList.remove("streaming");
    setStreaming(false);
    state.abortCtl = null;
    updateThreadSummary();
  }
}

function extractErrorMessage(raw) {
  if (!raw) return "";
  // 递归找 message：兼容
  //   { "detail": "<string 套娃 JSON>" }   ← FastAPI HTTPException
  //   [{ "error": { "message": "..." } }]  ← Gemini
  //   { "error": { "message": "..." } }    ← OpenAI 风格
  //   { "message": "..." } 等
  const seen = new Set();
  const find = (val) => {
    if (!val || seen.has(val)) return "";
    if (typeof val === "string") {
      // 试着把字符串当 JSON 解一次（detail 套娃）
      try { return find(JSON.parse(val)); } catch { return val.length < 200 ? val : ""; }
    }
    if (typeof val !== "object") return "";
    seen.add(val);
    if (Array.isArray(val)) {
      for (const x of val) { const m = find(x); if (m) return m; }
      return "";
    }
    // 优先精确字段
    if (typeof val.message === "string") return val.message;
    if (val.error) { const m = find(val.error); if (m) return m; }
    if (val.detail) { const m = find(val.detail); if (m) return m; }
    return "";
  };
  try { return find(JSON.parse(raw)) || raw.slice(0, 200); }
  catch { return raw.slice(0, 200); }
}

// v3-fixup-2: 把 primeSummary 文案里的检测词抽成常量。
// 改 primeSummary 文案时必须确保 PRIME_KEYWORD 仍然出现在模板里，否则 maybePrimeSummary 检测会失效，
// 导致每次 reload 都重发一次浪费 token。
/* PRIME_KEYWORD 必须出现在 primeSummary 模板里，改文案时同步 */
const PRIME_KEYWORD = "核心总结";

async function primeSummary() {
  // 文案里必须含 PRIME_KEYWORD（"核心总结"），见 maybePrimeSummary 检测逻辑
  await sendMessage(`请给这篇论文一个 100 字以内的${PRIME_KEYWORD}（What / Why / How / Result）。`);
}

// v3-fixup #1: prime 重复触发修
// 根因：刷新页面后 loadThreadsByPdfKey hydrate 已把历史 messages 灌回 main thread，
// 但 loadPdf 仍无条件调 primeSummary → 浪费一次 LLM 调用 + 污染导出文件。
// 修法：调用前检查 main thread 是否已含 primeSummary 风格的 user 提问，已有就跳过。
// v3-fixup-2: 检测词已抽成顶部 PRIME_KEYWORD 常量，与 primeSummary 文案共用同一字符串。
async function maybePrimeSummary() {
  const mainThread = state.threads && state.threads.main;
  const alreadyPrimed =
    mainThread &&
    Array.isArray(mainThread.messages) &&
    mainThread.messages.some(
      (m) => m && m.role === "user" && typeof m.content === "string" && m.content.includes(PRIME_KEYWORD)
    );
  if (alreadyPrimed) {
    console.debug("[primeSummary] already done in prior session, skipping");
    return;
  }
  await primeSummary();
}

// ────────────────────── UI 工具 ──────────────────────
function appendMsgBubble(role, content, streaming = false) {
  const el = document.createElement("div");
  el.className = `msg ${role}` + (streaming ? " streaming" : "");

  const roleEl = document.createElement("div");
  roleEl.className = "role";
  roleEl.textContent = role === "user" ? "你" : "Agent";

  const contentEl = document.createElement("div");
  contentEl.className = "content";
  if (role === "assistant") renderAssistant(contentEl, content);
  else contentEl.textContent = content;

  el.appendChild(roleEl);
  el.appendChild(contentEl);
  els.chatMessages.appendChild(el);
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
  return el;
}

function renderAssistant(el, text) {
  if (!text) { el.textContent = ""; return; }
  // marked 可能没加载（断网）—— 兜底纯文本
  if (window.marked) {
    const html = window.marked.parse(text, { breaks: true, gfm: true });
    el.innerHTML = postProcessCitations(html);
  } else {
    el.textContent = text;
  }
}

// v3-δ：引用回链 post-process
// 把 marked 输出的 HTML 里的 〔p.N〕 标记替换成 <a class="cite-link" data-page="N">〔p.N〕</a>
// 设计要点：
//   - 用 post-process 而不是 marked custom renderer（〔〕不是 markdown 语法、inline rule 过于复杂）
//   - 中文方括号 〔〕 U+3014/U+3015，避开 markdown 的 []
//   - 只替换 marked 输出 HTML 中已经 escape 过的字符，捕获组只匹配纯数字 → 无 XSS 面
//   - click handler 在 els.chatMessages 上用事件委托一次性挂载（见下方初始化段）
//   - 注意：marked 不会"escape"〔〕（非 ASCII，不在 HTML escape 表里），所以正则在 HTML 串里直接命中原字符
//
// v3-fixup #2: 容错正则（C 方案）
//   - DeepSeek 等 agent 不严格遵循 〔p.N〕，常用 (p.5) / [p.5] / （p.5）
//   - 主 Claude 已在 system_prompt.md 加 few-shot 强化（A 方案），这里是双保险
//   - 渲染统一显示全角 〔p.N〕 → 用户视觉一致，不暴露 agent 漂移
//   - 顺序：先严格 〔〕、再全角圆括、再半角圆括、再方括号；每条独立 replace
//   - 仅作用于 assistant message（renderAssistant 的调用点），user 输入里偶然写 (p.5) 不受影响
//   - 边缘：assistant 若用 markdown 链接 `[p.5](url)`，marked 会先转成 <a href="url">p.5</a>，
//     此时 HTML 里不再有 `[p.5]` 字面量 → 容错正则不会命中 → 安全
const CITE_REGEXES = [
  /〔p\.?\s*(\d+)〕/g,    // 〔p.5〕 严格首选
  /（p\.?\s*(\d+)）/g,    // （p.5）全角圆括号
  /\(p\.?\s*(\d+)\)/g,    // (p.5) 半角圆括号
  /\[p\.?\s*(\d+)\]/g,    // [p.5] 方括号
];
function postProcessCitations(html) {
  if (!html || typeof html !== "string") return html;
  let out = html;
  for (const re of CITE_REGEXES) {
    out = out.replace(re, (_match, n) => {
      return `<a class="cite-link" data-page="${n}" title="跳到第 ${n} 页">〔p.${n}〕</a>`;
    });
  }
  return out;
}

// 闪一下整个 page（v3-δ 引用回链 click → 视觉提示"跳到这页了"）
// 复用 v2-b hl-flash 思路，但作用于整个 .page；CSS .page-flash 见 style.css
function flashPage(pageNumber) {
  const pageEl = els.viewer.querySelector(`.page[data-page-number="${pageNumber}"]`);
  if (!pageEl) return;
  pageEl.classList.add("page-flash");
  setTimeout(() => pageEl.classList.remove("page-flash"), 900);
}

// v3-β: 视图切换状态机 ──────────────────────
// 三大 view（互斥）：topicList（landing）/ topicPage / reader
// newTopic 是叠加 modal，不占 view 槽位
// 切 view 时统一负责：清错误提示 / 收 thread list / 收 palette viewer / 设 state.view
function _hideAllViews() {
  els.landing.classList.remove("active");
  els.topicPage.classList.remove("active");
  els.reader.classList.remove("active");
}
function switchToTopicList() {
  _hideAllViews();
  hidePaletteViewer();
  hideTopicCardMenu();
  els.landing.classList.add("active");
  state.view = "topicList";
  renderTopicGrid();
  setLandingStatus("");
}
function switchToTopicPage(topicId) {
  // 切前先 abort 任何流式（用户从 reader 回到 topic page 时）
  if (state.abortCtl) state.abortCtl.abort();
  _hideAllViews();
  hidePaletteViewer();
  hideTopicCardMenu();
  els.topicPage.classList.add("active");
  state.view = "topicPage";
  // 不存在的 topicId（被删 / 数据脏）→ 兜底回主题列表
  const topic = state.topics[topicId];
  if (!topic) {
    console.warn("[switchToTopicPage] topic not found:", topicId);
    switchToTopicList();
    return;
  }
  state.currentTopicId = topicId;
  renderTopicPage(topic);
  setTpStatus("");
}
function switchToReader() {
  _hideAllViews();
  hidePaletteViewer();
  hideTopicCardMenu();
  els.reader.classList.add("active");
  state.view = "reader";
  setLandingStatus("");
  // v3-γ：切到 reader 时按当前主题重渲色板（loadPdf 已经在切完后再渲一次，这里是兜底入口）
  renderColorPalette();
}
// 阅读页 "←" 回主题页（不是 landing）—— 由 readerFromTopicId 决定
function switchToLanding() {
  // 流式中点 ← 回去：先 abort，避免流在后台继续烧 token 且不触发 setStreaming(false)
  // abort 后 sendMessage 的 catch(AbortError) + finally 会自行善后 messages / streaming state
  if (state.abortCtl) state.abortCtl.abort();
  const back = state.readerFromTopicId || state.currentTopicId || DEFAULT_TOPIC_ID;
  if (state.topics[back]) {
    switchToTopicPage(back);
  } else {
    switchToTopicList();
  }
}

function resetReaderState() {
  state.pdf = null;
  state.totalPages = 0;
  state.currentPage = 1;
  state.pdfText = "";
  state.pdfTitle = "";
  state.pdfKey = "";
  state.annotations = [];
  resetThreads();   // 重置成只有空 main thread
  if (state.abortCtl) state.abortCtl.abort();
  els.chatMessages.replaceChildren();
  // 隐藏色板/气泡 + thread list + 清掉 viewer 残留的高亮 DOM（setDocument(null) 之前先擦干净）
  hideColorPalette();
  hideHlBubble();
  closeThreadList();
  // v3-polish-2 #3：离开 reader 清掉 pending quote chip（避免跨 PDF 残留）
  clearPendingQuote();
  // 把 viewer 清空：setDocument(null) 让 viewer 内部销毁 PDFPageView、释放 canvas
  // 注意：必须在 viewer 已经 init 过的前提下才安全
  try {
    pdfViewer.setDocument(null);
    linkService.setDocument(null, null);
  } catch (_) { /* 首次加载前没文档，忽略 */ }
  // v3-polish-4：sidebar 默认显示 —— 切论文 / 回主题页时只清空缩略图 DOM，不再隐藏 sidebar 容器
  els.thumbnailView.replaceChildren();
  // 关闭缩放预设菜单（如果之前打开过）
  els.zoomMenu.hidden = true;
  els.zoomLevel.setAttribute("aria-expanded", "false");
  // 清空搜索查询（搜索框本身仍始终可见）
  els.findInput.value = "";
  els.findStatus.textContent = "0 / 0";
  // v5：收起搜索结果下拉（避免跨 PDF 残留旧结果）
  hideFindDropdown();
  els.pageInfo.textContent = "- / -";
  els.threadSummary.textContent = "⊳ 准备中…";
  els.pdfTitle.textContent = "";
  els.readerTopicHint.textContent = "";
}

function setLandingStatus(text, isError = false) {
  if (!text) { els.landingStatus.hidden = true; els.landingStatus.textContent = ""; return; }
  els.landingStatus.hidden = false;
  els.landingStatus.textContent = text;
  els.landingStatus.classList.toggle("error", !!isError);
}

function setStreaming(on) {
  state.streaming = on;
  // 流式中：按钮变 ⏹ 停止键、保持可点击；textarea disabled 防止 ⌘+Enter 重发
  // 非流式：按钮恢复 ↵ 发送键
  els.sendBtn.textContent = on ? "⏹" : "↵";
  els.sendBtn.title = on ? "停止生成" : "发送";
  els.sendBtn.setAttribute("aria-label", on ? "停止生成" : "发送");
  els.sendBtn.disabled = false; // 始终可点击；流式时点击 = abort
  els.sendBtn.classList.toggle("stopping", on);
  els.chatInput.disabled = on;
}

function updateThreadSummary() {
  const cur = getCurrentThread();
  const n = Object.keys(state.threads).length;
  // v3-polish #7：用 displayThreadLabel（customName 优先）
  els.threadSummary.textContent = `⊳ ${n} 个对话 · 当前：${displayThreadLabel(cur)}`;
  els.threadSummary.title = `点击切换对话（共 ${n} 个）`;
  // 若 thread list 正展开 → 同步重渲染（轮数 / label 可能变了）
  if (!els.threadList.hidden) renderThreadList();
}

// 渲染 thread list（按 createdAt 升序，main 永远第一）
// v3-polish #7：每个 thread 旁加"✎"重命名按钮（行内编辑）；main / annotation thread 都允许改名
function renderThreadList() {
  els.threadList.replaceChildren();
  const ids = Object.keys(state.threads).sort((a, b) => {
    if (a === "main") return -1;
    if (b === "main") return 1;
    return state.threads[a].createdAt - state.threads[b].createdAt;
  });
  for (const id of ids) {
    const t = state.threads[id];
    // 用 div 包装（之前是 <button>，要在里面再放 button 会嵌套违法）
    const item = document.createElement("div");
    item.className = "thread-list-item" + (id === state.currentThreadId ? " active" : "");
    item.dataset.threadId = id;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", id === state.currentThreadId ? "true" : "false");
    item.tabIndex = 0;

    const label = document.createElement("span");
    label.className = "tl-label";
    label.textContent = displayThreadLabel(t);
    // 若有 customName，把自动 label 作为 tooltip 提示原始锚定信息（p.5 · 🔴）
    if ((t.customName || "").trim()) {
      label.title = `${displayThreadLabel(t)}（${t.label}）`;
    } else {
      label.title = displayThreadLabel(t);
    }

    const meta = document.createElement("span");
    meta.className = "tl-meta";
    // 一轮 = 一对 user+assistant；不精确没关系，给个感觉
    const rounds = Math.ceil(t.messages.length / 2);
    meta.textContent = `${rounds} 轮`;

    // v3-polish #7：行内重命名按钮（点击不切 thread，停止冒泡）
    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "tl-rename";
    renameBtn.dataset.action = "rename";
    renameBtn.textContent = "✎";
    renameBtn.setAttribute("aria-label", "重命名对话");
    renameBtn.title = "重命名对话";

    item.appendChild(label);
    item.appendChild(meta);
    item.appendChild(renameBtn);
    els.threadList.appendChild(item);
  }
}

// v3-polish #7：行内重命名 thread —— 把 .tl-label 替换为 input
function startEditThreadLabel(threadId, itemEl) {
  const t = state.threads[threadId];
  if (!t || !itemEl) return;
  const labelEl = itemEl.querySelector(".tl-label");
  if (!labelEl) return;
  // 已经在编辑 → 不重入
  if (itemEl.querySelector(".tl-label-input")) return;
  // 编辑种子：优先 customName（用户可继续改），没有就用自动 label 当起点
  const seed = (t.customName || "").trim() || t.label || "";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "tl-label-input";
  input.value = seed;
  input.maxLength = 30;
  input.setAttribute("aria-label", "重命名对话");

  // 替换 label
  labelEl.replaceWith(input);
  input.focus();
  input.select();

  let finished = false;
  const commit = (save) => {
    if (finished) return;
    finished = true;
    if (save) {
      const next = input.value.trim().slice(0, 30);
      // 空 → 视为清除 customName，回退到自动 label（"重置成默认名"动作）
      t.customName = next;
      // 持久化（fire-and-forget）
      persistThread(t);
    }
    // 重渲染整个 list（最简单，避免手工恢复 DOM 失败）
    renderThreadList();
    updateThreadSummary();
  };

  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      commit(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      commit(false);
    }
    // 防止上下方向键被外层捕获
    e.stopPropagation();
  });
  input.addEventListener("blur", () => commit(true));
  // input 上点击不要触发 item 切 thread
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("mousedown", (e) => e.stopPropagation());
}

function openThreadList() {
  renderThreadList();
  els.threadList.hidden = false;
  els.threadSummary.setAttribute("aria-expanded", "true");
}
function closeThreadList() {
  els.threadList.hidden = true;
  els.threadSummary.setAttribute("aria-expanded", "false");
}
function toggleThreadList() {
  if (els.threadList.hidden) openThreadList();
  else closeThreadList();
}

// ────────────────────── v3-β 主题 UI ──────────────────────
// 三层视图：topicList (landing) / topicPage / reader
// 关键设计决策（鸭鸭已拍板，严格遵守）：
//   - 主题创建后 palette 完全冻结；palette 编辑器只在新建流程出现
//   - 默认主题"默认主题" 不可改名、不可删除（menu 不显示）
//   - 每个 tag = {id, emoji, label≤20字, color}；emoji 固定（创建时从 EMOJI_POOL 分配）
//   - 同一 pdfKey 可加进多个主题（annotations 按 topicId 区分），主题列表里"重复"是正常的

// emoji 池：新建主题加新行时从此循环取（不让用户改 emoji）
// 顺序刻意与 DEFAULT_PALETTE 的 6 个相同 → 默认主题展开就是这 6 个
const EMOJI_POOL = ["🔴", "🟢", "🔵", "🟣", "🟡", "⚪", "🟠", "🟤", "⚫", "🩷"];
// v3-γ：新增行的默认 color 池（对应 EMOJI_POOL 顺序）
// 前 6 个与 DEFAULT_PALETTE 的 color 对齐；后 4 个补 orange/brown/black/pink
// 用途：ntmAddPaletteRow 按 `PRESET_COLORS[N % 10]` 给新行预填，比单一灰 `#cccccc` 友好
const PRESET_COLORS = [
  "#ff5e5e", // 🔴
  "#54d062", // 🟢
  "#4a9eff", // 🔵
  "#b06dff", // 🟣
  "#f5d042", // 🟡
  "#b8b8b8", // ⚪
  "#ff9b54", // 🟠
  "#9b59b6", // 🟤
  "#34495e", // ⚫
  "#e91e63", // 🩷
];
const MAX_PALETTE_ROWS = 10;       // 上限：超过用户更可能困惑而不是 power-user
const MIN_PALETTE_ROWS = 1;        // 最少 1 行（删到 0 行就丢失主题意义）

// ── 工具：相对时间（粗糙够用）──
function formatRelativeTime(iso) {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!t) return "";
  const diff = Date.now() - t;
  const min = 60 * 1000, hour = 60 * min, day = 24 * hour;
  if (diff < min) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  try { return new Date(iso).toISOString().slice(0, 10); } catch { return ""; }
}

// 从 pdfKey 反推可读标题（file:foo.pdf:123 / url:https://... → 截尾）
function deriveTitleFromPdfKey(pdfKey, fallback = "") {
  if (!pdfKey) return fallback || "(未命名)";
  if (pdfKey.startsWith("file:")) {
    // file:NAME:SIZE → 取中间的 NAME
    const rest = pdfKey.slice(5);
    const lastColon = rest.lastIndexOf(":");
    return lastColon > 0 ? rest.slice(0, lastColon) : rest;
  }
  if (pdfKey.startsWith("url:")) {
    return deriveTitleFromUrl(pdfKey.slice(4));
  }
  return fallback || pdfKey;
}

// ── 主题列表（landing）渲染 ──
function renderTopicGrid() {
  els.topicGrid.replaceChildren();
  // 排序：默认主题永远第一，其余按 createdAt 倒序（最新建的在前）
  const ids = Object.keys(state.topics).sort((a, b) => {
    if (a === DEFAULT_TOPIC_ID) return -1;
    if (b === DEFAULT_TOPIC_ID) return 1;
    const ta = new Date(state.topics[a].createdAt || 0).getTime();
    const tb = new Date(state.topics[b].createdAt || 0).getTime();
    return tb - ta;
  });
  for (const id of ids) {
    const topic = state.topics[id];
    if (!topic) continue;
    els.topicGrid.appendChild(buildTopicCard(topic));
  }
}

function buildTopicCard(topic) {
  const card = document.createElement("div");
  card.className = "topic-card" + (topic.id === DEFAULT_TOPIC_ID ? " default-topic" : "");
  card.dataset.topicId = topic.id;
  card.setAttribute("role", "button");
  card.tabIndex = 0;

  // 名称
  const name = document.createElement("div");
  name.className = "tc-name";
  name.textContent = topic.name;

  // palette 色块预览
  const pal = document.createElement("div");
  pal.className = "tc-palette";
  for (const p of (topic.palette || [])) {
    const sw = document.createElement("span");
    sw.className = "tc-swatch";
    sw.style.background = p.color;
    sw.title = `${p.emoji} ${p.label}`;
    pal.appendChild(sw);
  }

  // 元信息：PDF 数 + 创建时间
  const meta = document.createElement("div");
  meta.className = "tc-meta";
  const pdfCount = (topic.pdfKeys || []).length;
  const m1 = document.createElement("span");
  m1.textContent = `${pdfCount} 篇`;
  const m2 = document.createElement("span");
  m2.textContent = formatRelativeTime(topic.createdAt);
  meta.appendChild(m1);
  if (m2.textContent) meta.appendChild(m2);

  // "..." 菜单（默认主题不展示）
  if (topic.id !== DEFAULT_TOPIC_ID) {
    const menuBtn = document.createElement("button");
    menuBtn.type = "button";
    menuBtn.className = "tc-menu-btn";
    menuBtn.textContent = "⋯";
    menuBtn.setAttribute("aria-label", "更多操作");
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      showTopicCardMenu(topic.id, menuBtn);
    });
    card.appendChild(menuBtn);
  }

  card.appendChild(name);
  card.appendChild(pal);
  card.appendChild(meta);

  // 点卡片 → 进主题页
  card.addEventListener("click", () => switchToTopicPage(topic.id));
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      switchToTopicPage(topic.id);
    }
  });

  return card;
}

// ── 主题卡片 "..." 菜单 ──
let _menuTargetTopicId = null;
function showTopicCardMenu(topicId, anchorEl) {
  _menuTargetTopicId = topicId;
  const rect = anchorEl.getBoundingClientRect();
  els.topicCardMenu.style.top = `${rect.bottom + window.scrollY + 4}px`;
  // 让菜单右对齐到 anchor（视觉更稳）
  els.topicCardMenu.style.left = `${rect.right + window.scrollX - 140}px`;
  els.topicCardMenu.hidden = false;
}
function hideTopicCardMenu() {
  els.topicCardMenu.hidden = true;
  _menuTargetTopicId = null;
}

// ── 主题页 ──
function renderTopicPage(topic) {
  els.tpName.textContent = topic.name;
  // palette 行（只读小标签）
  els.tpPaletteRow.replaceChildren();
  for (const p of (topic.palette || [])) {
    const tag = document.createElement("span");
    tag.className = "tp-tag";
    const sw = document.createElement("span");
    sw.className = "tp-tag-swatch";
    sw.style.background = p.color;
    tag.appendChild(sw);
    tag.append(` ${p.emoji} ${p.label}`);
    tag.title = "主题创建后色板不可修改";
    els.tpPaletteRow.appendChild(tag);
  }
  // 回到主题页时让 URL 输入框聚焦（首篇 → 引导加论文）
  setTimeout(() => els.tpUrlInput.focus({ preventScroll: true }), 0);
  renderTpPdfList(topic);
  // v3-δ：导出按钮可用性
  updateExportBtnState(topic);
}

// v3-δ：根据 topic.pdfKeys 是否非空切换导出按钮可用性
function updateExportBtnState(topic) {
  if (!els.tpExportBtn) return;
  const hasPdf = (topic?.pdfKeys || []).length > 0;
  els.tpExportBtn.disabled = !hasPdf;
  els.tpExportBtn.title = hasPdf
    ? "导出本主题为 markdown 笔记"
    : "主题里还没有论文";
}

function renderTpPdfList(topic) {
  els.tpPdfList.replaceChildren();
  const pdfKeys = topic.pdfKeys || [];
  if (pdfKeys.length === 0) {
    const empty = document.createElement("div");
    empty.className = "tp-pdf-empty";
    empty.textContent = "还没有论文。粘贴一个链接或选本地 PDF 开始读。";
    els.tpPdfList.appendChild(empty);
    return;
  }
  // 倒序：最新加的在前（pdfKeys 是 push 进去的，反过来就是最近优先）
  for (let i = pdfKeys.length - 1; i >= 0; i--) {
    const pdfKey = pdfKeys[i];
    const title = deriveTitleFromPdfKey(pdfKey);
    const item = document.createElement("div");
    item.className = "tp-pdf-item";
    item.dataset.pdfKey = pdfKey;
    item.tabIndex = 0;

    const icon = document.createElement("span");
    icon.className = "tp-pdf-icon";
    icon.textContent = pdfKey.startsWith("file:") ? "📄" : "🔗";

    const name = document.createElement("span");
    name.className = "tp-pdf-name";
    name.textContent = title;
    name.title = pdfKey;

    const time = document.createElement("span");
    time.className = "tp-pdf-time";
    time.textContent = pdfKey.startsWith("url:") ? "" : "";

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "tp-pdf-remove";
    removeBtn.textContent = "×";
    removeBtn.title = "从本主题移除（不删 annotation 数据）";
    removeBtn.setAttribute("aria-label", "移除");
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      removePdfFromTopic(topic.id, pdfKey);
    });

    item.appendChild(icon);
    item.appendChild(name);
    item.appendChild(time);
    item.appendChild(removeBtn);

    // 点条目 → 用 url:/file: 形式加载 PDF
    const openIt = () => openPdfFromTopic(topic.id, pdfKey);
    item.addEventListener("click", openIt);
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openIt();
      }
    });

    els.tpPdfList.appendChild(item);
  }
}

// 打开主题里某个已添加的 pdfKey
// pdfKey 格式：`url:<URL>` / `file:<name>:<size>`
// 注意：file: key 因为没存原始 File（隐私 + 大小），需要用户再次选文件 → 提示
function openPdfFromTopic(topicId, pdfKey) {
  if (pdfKey.startsWith("url:")) {
    const url = pdfKey.slice(4);
    loadPdf({ url, topicId });
  } else if (pdfKey.startsWith("file:")) {
    // 本地文件无法存进 IDB（File 对象不可序列化 + 隐私）
    // → 用户必须重新选；这里弹个友好提示
    setTpStatus("本地文件无法保存，请重新选择 PDF 文件。", true);
    els.tpFileInput.click();
  } else {
    setTpStatus(`未知 PDF key 格式: ${pdfKey}`, true);
  }
}

// ── 色板查看面板（主题页只读，强调"已冻结"）──
function showPaletteViewer(topic) {
  els.pvBody.replaceChildren();
  for (const p of (topic.palette || [])) {
    const row = document.createElement("div");
    row.className = "pv-row";
    const sw = document.createElement("span");
    sw.className = "pv-swatch";
    sw.style.background = p.color;
    const em = document.createElement("span");
    em.className = "pv-emoji";
    em.textContent = p.emoji;
    const lb = document.createElement("span");
    lb.className = "pv-label";
    lb.textContent = p.label;
    row.appendChild(sw);
    row.appendChild(em);
    row.appendChild(lb);
    els.pvBody.appendChild(row);
  }
  els.paletteViewer.hidden = false;
}
function hidePaletteViewer() {
  els.paletteViewer.hidden = true;
}

// ── reader 顶栏 topic hint 更新 ──
// v3-polish-2 #3：去掉主题名前面的彩色 dot（鸭鸭说"emoji 加回去"指的是引用块，不是主题 dot）
//   ::before 的 dot 已在 CSS 中删除；这里不再注入 --topic-dot-color
function updateReaderTopicHint() {
  const topic = state.topics[state.currentTopicId];
  if (!topic) {
    els.readerTopicHint.textContent = "";
    els.readerTopicHint.removeAttribute("data-editable");
    return;
  }
  els.readerTopicHint.textContent = topic.name;
  // v3-polish #5：默认主题不可改名；非默认主题点击进入 inline edit
  const editable = topic.id !== DEFAULT_TOPIC_ID;
  if (editable) {
    els.readerTopicHint.setAttribute("data-editable", "1");
    els.readerTopicHint.title = `点击重命名（当前：${topic.name}）`;
  } else {
    els.readerTopicHint.removeAttribute("data-editable");
    els.readerTopicHint.title = `当前主题：${topic.name}（默认主题不可改名）`;
  }
}

// v3-polish #5：reader 顶栏主题名 inline 重命名
// 点击 → 切到 input；Enter / blur 保存；ESC 取消恢复
let _topicHintEditing = false;
function startEditReaderTopicHint() {
  if (_topicHintEditing) return;
  const topic = state.topics[state.currentTopicId];
  if (!topic || topic.id === DEFAULT_TOPIC_ID) return;
  _topicHintEditing = true;
  const oldName = topic.name;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "reader-topic-hint-input";
  input.value = oldName;
  input.maxLength = 30;
  input.setAttribute("aria-label", "重命名主题");
  // 用 input 替换 hint span 的 textContent —— 但保留 dot ::before
  els.readerTopicHint.textContent = "";
  els.readerTopicHint.appendChild(input);
  input.focus();
  input.select();

  let finished = false;
  const commit = async (save) => {
    if (finished) return;
    finished = true;
    _topicHintEditing = false;
    let nextName = input.value.trim().slice(0, 30);
    if (!save || !nextName || nextName === oldName) {
      // 取消 / 空 / 没变 → 直接恢复
      updateReaderTopicHint();
      return;
    }
    try {
      await renameTopic(state.currentTopicId, nextName);
    } catch (e) {
      console.warn("[renameTopic]", e);
    }
    // 任何持有该 topic.name 引用的 UI 都需要刷一遍
    updateReaderTopicHint();
    // 主题列表（landing）/ 主题页头 / pdf title hint 等下次进入时由各自 render 读 topic.name 即可
  };

  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      commit(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      commit(false);
    }
  });
  input.addEventListener("blur", () => commit(true));
}

// ── tp page 状态提示 ──
function setTpStatus(text, isError = false) {
  if (!text) { els.tpStatus.hidden = true; els.tpStatus.textContent = ""; return; }
  els.tpStatus.hidden = false;
  els.tpStatus.textContent = text;
  els.tpStatus.classList.toggle("error", !!isError);
}

// ──────────────────────────────────────────
// Topic CRUD（IDB 写入 + 内存 state.topics 同步）
// ──────────────────────────────────────────

function _uuid() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `t-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// 创建主题：写 IDB + 内存 + 切到新主题页
async function createTopic({ name, palette }) {
  const id = _uuid();
  const now = new Date().toISOString();
  const topic = {
    id,
    name: (name || "").trim() || "未命名主题",
    // 深拷贝 palette（防 modal 编辑器后续 mutate）
    palette: (palette || []).map((p) => ({ ...p })),
    pdfKeys: [],
    createdAt: now,
    // v3-fixup-2: palette 创建即冻结，记录冻结时间戳（修 A2 long-term issue）
    // 老主题（v3-α/β 创建无此字段）保持 undefined，不主动 migrate（避免 IDB 写风暴）
    paletteFrozenAt: now,
  };
  state.topics[id] = topic;
  await saveTopic(topic);
  return topic;
}

// 重命名（默认主题禁止）
async function renameTopic(id, newName) {
  if (id === DEFAULT_TOPIC_ID) return;
  const topic = state.topics[id];
  if (!topic) return;
  topic.name = (newName || "").trim() || topic.name;
  await saveTopic(topic);
}

// 删除主题：默认主题禁止；
// 联动：清掉该主题下所有 annotation 的归属 + 删 threads（按 topicId 过滤）
// 注意：annotations IDB 按 pdfKey 存，所以要遍历该 topic.pdfKeys 把里头属于本主题的 ann 抹掉
async function deleteTopic(id) {
  if (id === DEFAULT_TOPIC_ID) return;
  const topic = state.topics[id];
  if (!topic) return;

  // 1. 清 annotations：每个 pdfKey 下，过滤掉 topicId === id 的 ann
  for (const pdfKey of (topic.pdfKeys || [])) {
    try {
      const list = await loadAnnotations(pdfKey);
      const remaining = (list || []).filter((a) => a.topicId !== id);
      // 全删干净的情况下也写回（空数组 vs 不存在；这里写空数组让其他主题能继续用）
      await saveAnnotations(pdfKey, remaining);
    } catch (e) {
      console.warn("[deleteTopic] clean annotations failed", pdfKey, e);
    }
  }

  // 2. 清 threads（IDB 里 topicId 字段匹配的全删）
  try {
    const db = await openIdb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_THREADS, "readwrite");
      const store = tx.objectStore(IDB_STORE_THREADS);
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur) { resolve(); return; }
        if (cur.value && cur.value.topicId === id) cur.delete();
        cur.continue();
      };
      req.onerror = () => reject(req.error);
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn("[deleteTopic] clean threads failed", e);
  }

  // 3. 删 topic 本身（IDB + 内存）
  try {
    const db = await openIdb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_TOPICS, "readwrite");
      tx.objectStore(IDB_STORE_TOPICS).delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    _memTopics.delete(id);
  }
  delete state.topics[id];

  // 4. 如果当前正在该主题的页面（state.currentTopicId === id），切回主题列表
  if (state.currentTopicId === id) {
    state.currentTopicId = DEFAULT_TOPIC_ID;
  }
  if (state.readerFromTopicId === id) {
    state.readerFromTopicId = DEFAULT_TOPIC_ID;
  }
}

// 把 pdfKey 加进 topic.pdfKeys（去重 push）+ 持久化
// 同一 pdfKey 已在 topic.pdfKeys 里 → no-op（让用户重复点同一论文不会污染列表）
async function addPdfToTopic(topicId, pdfKey, _title) {
  const topic = state.topics[topicId];
  if (!topic || !pdfKey) return;
  if (!topic.pdfKeys) topic.pdfKeys = [];
  if (topic.pdfKeys.includes(pdfKey)) return;
  topic.pdfKeys.push(pdfKey);
  await saveTopic(topic);
}

// 从主题里移除 pdfKey（不删 IDB 里的 annotation 数据，只切断 topic 的引用）
// 设计取舍：annotation 仍在 IDB（按 pdfKey 存），用户后续再加进任意主题还能见到
// → "从主题移除" 是轻量动作，与"删主题"分开
async function removePdfFromTopic(topicId, pdfKey) {
  const topic = state.topics[topicId];
  if (!topic || !pdfKey) return;
  topic.pdfKeys = (topic.pdfKeys || []).filter((k) => k !== pdfKey);
  await saveTopic(topic);
  renderTpPdfList(topic);
  updateExportBtnState(topic);
}

// ──────────────────────────────────────────
// v3-δ：笔记导出
// ──────────────────────────────────────────
// 设计：扫主题下所有 pdfKey → 拉 annotations + threads → 按 PDF 聚合输出 markdown
//   - 主对话（thread.id="main"）：每篇 PDF 一段，独立于高亮
//   - 高亮 thread：按页码 + tag 分组；每条引用 quote + thread.messages
//   - 用户消息脱去 [CURRENT_PAGE: N] 前缀（与 chat 显示对齐）
//   - assistant 消息保留原文（含 〔p.N〕 标记）—— 导出后人可读，回链是文本残留
// 失败容忍：任一 PDF 拉数据失败 → 该 PDF 段记"(数据读取失败)"，不阻塞其他 PDF

function _stripPageTag(s) {
  if (typeof s !== "string") return "";
  return s.replace(/^\[CURRENT_PAGE:\s*\d+\]\n/, "");
}

// 文件名安全化：替换 windows / unix 不合法字符为 -
// 主题名含 "测试/X" → "测试-X"
function _safeFileName(name) {
  return (name || "未命名主题")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60) || "未命名主题";
}

// yyyyMMdd-HHmm（按本地时区）
function _formatStamp(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

async function generateMarkdownExport(topicId) {
  const topic = state.topics[topicId];
  if (!topic) throw new Error("主题不存在");
  const pdfKeys = topic.pdfKeys || [];
  const palette = topic.palette || [];

  const lines = [];
  const now = new Date();
  // 头部
  lines.push(`# 主题: ${topic.name}`);
  lines.push("");
  lines.push(`> 导出时间: ${now.toISOString().slice(0, 16).replace("T", " ")}`);
  // palette 一行展示
  if (palette.length > 0) {
    const paletteLine = palette.map((p) => `${p.emoji} ${p.label}`).join(" / ");
    lines.push(`> Palette: ${paletteLine}`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");

  if (pdfKeys.length === 0) {
    lines.push("_（主题里还没有论文）_");
    return lines.join("\n");
  }

  for (let i = 0; i < pdfKeys.length; i++) {
    const pdfKey = pdfKeys[i];
    const title = deriveTitleFromPdfKey(pdfKey);
    lines.push(`## 📄 PDF ${i + 1}: ${title}`);
    lines.push("");

    // 拉 annotations + threads
    let anns = [];
    let threadRecs = [];
    try {
      anns = await loadAnnotations(pdfKey) || [];
      // 仅保留属于该 topic 的 ann（同一 pdfKey 可能跨主题）
      anns = anns.filter((a) => !a.topicId || a.topicId === topicId);
    } catch (e) {
      console.warn("[generateMarkdownExport] loadAnnotations", pdfKey, e);
      lines.push("_（annotation 数据读取失败）_");
      lines.push("");
    }
    try {
      threadRecs = await loadThreadsByPdfKey(pdfKey) || [];
      threadRecs = threadRecs.filter((t) => !t.topicId || t.topicId === topicId);
    } catch (e) {
      console.warn("[generateMarkdownExport] loadThreadsByPdfKey", pdfKey, e);
    }

    // 主对话
    const mainThread = threadRecs.find((t) => t.id === "main");
    lines.push("### 主对话（不绑高亮）");
    lines.push("");
    if (!mainThread || !mainThread.messages || mainThread.messages.length === 0) {
      lines.push("_（无对话）_");
      lines.push("");
    } else {
      for (const m of mainThread.messages) {
        const role = m.role === "user" ? "**你**" : "**Agent**";
        const content = m.role === "user" ? _stripPageTag(m.content) : (m.content || "");
        lines.push(`${role}: ${content}`);
        lines.push("");
      }
    }

    // 高亮 thread：按 annotation 列表顺序（按 createdAt 升序更稳，与时间线一致）
    const annsByCreatedAsc = [...anns].sort((a, b) => {
      const ta = new Date(a.createdAt || 0).getTime();
      const tb = new Date(b.createdAt || 0).getTime();
      return ta - tb;
    });
    annsByCreatedAsc.forEach((ann, idx) => {
      const pages = ann.pages || [];
      const pageNums = pages.map((p) => p.page);
      const pageLabel = pageNums.length === 0
        ? "p.?"
        : pageNums.length === 1
          ? `p.${pageNums[0]}`
          : `p.${pageNums[0]}-${pageNums[pageNums.length - 1]}`;
      // 找 palette tag（用 ann.color 当 palette.id）
      const tag = palette.find((p) => p.id === ann.color);
      const tagLabel = tag ? `${tag.emoji} ${tag.label}` : (ann.color || "");
      // v3-polish #7：若用户给本 thread 起了名（customName），在小标题里显式带上
      const annThread = threadRecs.find((x) => x.id === ann.id);
      const customName = (annThread?.customName || "").trim();
      const head = customName
        ? `### 高亮 ${idx + 1} · ${customName} (${pageLabel} · ${tagLabel})`
        : `### 高亮 ${idx + 1} (${pageLabel} · ${tagLabel})`;
      lines.push(head);
      lines.push("");
      // 引用原文
      const quote = (ann.text || "").replace(/\s+/g, " ").trim();
      if (quote) {
        // 多行 quote 也按一行展开（markdown blockquote 单行更稳；前端选段已是单行连缀）
        lines.push(`> "${quote}"`);
        lines.push("");
      }
      // 对应 thread.messages
      const t = threadRecs.find((x) => x.id === ann.id);
      if (!t || !t.messages || t.messages.length === 0) {
        lines.push("_（无对话）_");
        lines.push("");
      } else {
        for (const m of t.messages) {
          const role = m.role === "user" ? "**你**" : "**Agent**";
          const content = m.role === "user" ? _stripPageTag(m.content) : (m.content || "");
          lines.push(`${role}: ${content}`);
          lines.push("");
        }
      }
    });

    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

// 触发浏览器下载
async function downloadTopicMarkdown(topicId) {
  const topic = state.topics[topicId];
  if (!topic) return;
  let md;
  try {
    md = await generateMarkdownExport(topicId);
  } catch (e) {
    console.error("[downloadTopicMarkdown]", e);
    setTpStatus(`导出失败：${e.message || e}`, true);
    return;
  }
  const stamp = _formatStamp(new Date());
  const fname = `${_safeFileName(topic.name)}-${stamp}.md`;
  let url = null;
  try {
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (e) {
    console.error("[downloadTopicMarkdown] blob/download", e);
    setTpStatus(`下载失败：${e.message || e}`, true);
  } finally {
    if (url) {
      // 给浏览器一点时间触发下载，再 revoke
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
}

// ──────────────────────────────────────────
// 新建主题 modal（3 步）
// ──────────────────────────────────────────
//   Step 1: 起名
//   Step 2: 编辑 palette（基于 DEFAULT_PALETTE 改 label/color，+/- 行；emoji 不可改）
//   Step 3: 确认（"创建后不可改" 警告）→ 创建 → 切到新主题
//
// 状态：ntmDraft = { step, name, paletteDraft: [{id,emoji,label,color}] }
// 取消（× / esc / 点 mask）→ 丢弃 draft，不写 IDB（默认主题完全不受影响）
const ntmDraft = {
  step: 1,
  name: "",
  paletteDraft: [],
};

function openNewTopicModal() {
  ntmDraft.step = 1;
  ntmDraft.name = "";
  // 用 DEFAULT_PALETTE 深拷贝（包含 emoji，但用户不能改 emoji）
  ntmDraft.paletteDraft = DEFAULT_PALETTE.map((p) => ({ ...p }));
  els.ntmNameInput.value = "";
  els.newTopicModal.hidden = false;
  ntmRenderStep();
  setTimeout(() => els.ntmNameInput.focus(), 50);
}
function closeNewTopicModal() {
  els.newTopicModal.hidden = true;
}

function ntmRenderStep() {
  // 显示对应 step
  els.ntmStep1.classList.toggle("active", ntmDraft.step === 1);
  els.ntmStep2.classList.toggle("active", ntmDraft.step === 2);
  els.ntmStep3.classList.toggle("active", ntmDraft.step === 3);
  els.ntmStepIndicator.textContent = `第 ${ntmDraft.step} / 3 步`;

  // 按钮显示
  els.ntmPrev.hidden = ntmDraft.step === 1;
  els.ntmNext.hidden = ntmDraft.step === 3;
  els.ntmConfirm.hidden = ntmDraft.step !== 3;

  // Step-specific 渲染
  if (ntmDraft.step === 2) {
    ntmRenderPaletteEditor();
  } else if (ntmDraft.step === 3) {
    ntmRenderConfirm();
  }
  ntmUpdateNextEnabled();
}

function ntmUpdateNextEnabled() {
  if (ntmDraft.step === 1) {
    els.ntmNext.disabled = !els.ntmNameInput.value.trim();
  } else if (ntmDraft.step === 2) {
    // palette 至少要有 1 行 + 每行 label 不空
    const valid = ntmDraft.paletteDraft.length >= MIN_PALETTE_ROWS &&
      ntmDraft.paletteDraft.every((p) => p.label && p.label.trim());
    els.ntmNext.disabled = !valid;
  }
}

function ntmRenderPaletteEditor() {
  els.ntmPaletteEditor.replaceChildren();
  ntmDraft.paletteDraft.forEach((p, idx) => {
    const row = document.createElement("div");
    row.className = "ntm-row";
    row.dataset.idx = String(idx);

    const em = document.createElement("span");
    em.className = "ntm-emoji";
    em.textContent = p.emoji;
    em.title = "emoji 不可修改";

    const lb = document.createElement("input");
    lb.type = "text";
    lb.maxLength = 20;
    lb.placeholder = "标签 ≤ 20 字";
    lb.value = p.label;
    lb.addEventListener("input", () => {
      p.label = lb.value;
      ntmUpdateNextEnabled();
    });

    // v3-polish-5：去掉 color picker —— 颜色由 emoji 固定决定（EMOJI_POOL[i] ↔ PRESET_COLORS[i]）
    // 用户只能改 label + 增删行；color 字段仍写入 IDB（由代码自动填，UI 不暴露）
    // 历史背景：保留 color 字段是为了 schema 兼容（老主题/老 annotation 仍依赖 tag.color 取 hex）

    const del = document.createElement("button");
    del.type = "button";
    del.className = "ntm-del";
    del.textContent = "🗑";
    del.title = "删除此行";
    del.disabled = ntmDraft.paletteDraft.length <= MIN_PALETTE_ROWS;
    del.addEventListener("click", () => {
      ntmDraft.paletteDraft.splice(idx, 1);
      ntmRenderPaletteEditor();
      ntmUpdateNextEnabled();
    });

    row.appendChild(em);
    row.appendChild(lb);
    row.appendChild(del);
    els.ntmPaletteEditor.appendChild(row);
  });
  // "+" 按钮可用性
  els.ntmAddRow.disabled = ntmDraft.paletteDraft.length >= MAX_PALETTE_ROWS;
}

function ntmAddPaletteRow() {
  if (ntmDraft.paletteDraft.length >= MAX_PALETTE_ROWS) return;
  // 从 EMOJI_POOL 取下一个还没用的 emoji；都用过了就循环
  const usedEmojis = new Set(ntmDraft.paletteDraft.map((p) => p.emoji));
  let chosenEmoji = EMOJI_POOL.find((e) => !usedEmojis.has(e));
  if (!chosenEmoji) {
    // 全占满了——循环：用 length % pool 索引
    chosenEmoji = EMOJI_POOL[ntmDraft.paletteDraft.length % EMOJI_POOL.length];
  }
  // 新行 id：尽量唯一，用 emoji + idx
  // 防止旧 ann.color 索引冲突：新加的不沿用 "red" 等保留 key
  const newId = `c${ntmDraft.paletteDraft.length}-${Date.now().toString(36).slice(-4)}`;
  // v3-polish-5：color 由 emoji 决定 —— 用 emoji 在 EMOJI_POOL 的 index 索引 PRESET_COLORS
  // 不再用 paletteDraft.length（删行后会漂移导致 emoji 和 color 不一致）
  const emojiIdx = EMOJI_POOL.indexOf(chosenEmoji);
  const nextColor = PRESET_COLORS[emojiIdx >= 0 ? emojiIdx : 0];
  ntmDraft.paletteDraft.push({
    id: newId,
    emoji: chosenEmoji,
    label: "新标签",
    color: nextColor,
  });
  ntmRenderPaletteEditor();
  ntmUpdateNextEnabled();
}

function ntmRenderConfirm() {
  els.ntmConfirmName.textContent = ntmDraft.name || "(未命名)";
  els.ntmConfirmPalette.replaceChildren();
  for (const p of ntmDraft.paletteDraft) {
    const row = document.createElement("div");
    row.className = "ntm-cp-row";
    const sw = document.createElement("span");
    sw.className = "ntm-cp-swatch";
    sw.style.background = p.color;
    const em = document.createElement("span");
    em.textContent = p.emoji;
    const lb = document.createElement("span");
    lb.textContent = p.label || "(未命名标签)";
    row.appendChild(sw);
    row.appendChild(em);
    row.appendChild(lb);
    els.ntmConfirmPalette.appendChild(row);
  }
}

async function ntmDoCreate() {
  // 守门：理论上 step 3 不应让无效数据进来，但兜底
  const name = ntmDraft.name.trim();
  const palette = ntmDraft.paletteDraft;
  if (!name) { ntmDraft.step = 1; ntmRenderStep(); return; }
  if (!palette.length || palette.some((p) => !p.label || !p.label.trim())) {
    ntmDraft.step = 2; ntmRenderStep(); return;
  }
  els.ntmConfirm.disabled = true;
  try {
    const topic = await createTopic({ name, palette });
    closeNewTopicModal();
    // 切到新主题
    switchToTopicPage(topic.id);
  } catch (e) {
    console.error("[createTopic]", e);
    setLandingStatus(`创建主题失败：${e.message || e}`, true);
  } finally {
    els.ntmConfirm.disabled = false;
  }
}

// ────────────────────── 事件绑定 ──────────────────────
// v3-β: 主题页 "添加论文" 表单——把 URL / 文件加到当前主题
els.tpLoadForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = els.tpUrlInput.value.trim();
  if (!url) return;
  els.tpUrlInput.value = "";
  await loadPdf({ url, topicId: state.currentTopicId });
});
els.tpFileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  // 重置 input 让用户可以选同一个文件 N 次（浏览器默认 change 不重 fire 同名文件）
  e.target.value = "";
  if (file) await loadPdf({ file, topicId: state.currentTopicId });
});

// reader 左上角 "←" —— v3-β：回主题页（不是 landing）
els.backHome.addEventListener("click", switchToLanding);

// v3-polish #5：reader 顶栏主题名点击 → inline 重命名（默认主题除外，由 startEditReaderTopicHint 守门）
els.readerTopicHint.addEventListener("click", (e) => {
  // 已经在编辑（input 自己接管事件）→ 不重入
  if (e.target.closest("input")) return;
  startEditReaderTopicHint();
});

// v2-b：thread 切换器
els.threadSummary.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleThreadList();
});
els.threadList.addEventListener("click", (e) => {
  const item = e.target.closest(".thread-list-item");
  if (!item) return;
  e.stopPropagation();
  // v3-polish #7：点 ✎ → 进入 inline rename（不切 thread）
  const renameBtn = e.target.closest(".tl-rename");
  if (renameBtn) {
    startEditThreadLabel(item.dataset.threadId, item);
    return;
  }
  // 点 input 等 child → 别切 thread（startEditThreadLabel 自己 stopPropagation 已经管了 input）
  if (e.target.closest(".tl-label-input")) return;
  switchThread(item.dataset.threadId);
});
// v3-polish #7：thread-list-item 改成 div 后补一下键盘可达性（Enter / Space 切换）
els.threadList.addEventListener("keydown", (e) => {
  const item = e.target.closest(".thread-list-item");
  if (!item) return;
  if (e.target.closest(".tl-label-input")) return; // 编辑中由 input 自己接管
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    switchThread(item.dataset.threadId);
  }
});
// 点空白处（包括 PDF 滚动 / chat / landing）→ 折叠 thread list
document.addEventListener("mousedown", (e) => {
  if (els.threadList.hidden) return;
  if (e.target.closest("#threadList") || e.target.closest("#threadSummary")) return;
  closeThreadList();
});

// 搜索 UI 绑定（v3-polish-4：findToggle 按钮已删，搜索框始终可见 → 只剩 findClose / prev / next）
// v4：× 按钮 = 主动清空（清 input value + 清高亮 + 焦点还 viewer），与 ESC（保留 value）区分语义
els.findClose.addEventListener("click", () => {
  els.findInput.value = "";
  clearFindHighlights();
  hideFindDropdown();
  els.viewerContainer.focus({ preventScroll: true });
});
els.findPrev.addEventListener("click", () => findAgain(true));
els.findNext.addEventListener("click", () => findAgain(false));

// ────────────────────── v3-thumb-zoom：缩略图 sidebar + 缩放控件 ──────────────────────
// v3-polish-4：缩略图 sidebar 默认显示，无需 toggle 按钮 / toggle 函数
// 缩略图本身仍在 loadPdf 时 fire-and-forget 渲染；pagechanging 事件驱动高亮（renderThumbnails 内部 + 全局 listener）

// 自己实现的 mini thumbnail renderer
// 不依赖 pdf.js 的私有 PDFThumbnailViewer（CDN 的 pdf_viewer.mjs 不导出），用已有 PDFDocumentProxy.getPage + canvas
// 串行 await：50+ 页大 PDF 会卡 5-10 秒，鸭鸭日常论文 < 30 页可接受；分批 lazy 留 v3.1
async function renderThumbnails(pdfDoc) {
  const view = els.thumbnailView;
  view.replaceChildren();   // 清旧（切论文时复用此函数）
  if (!pdfDoc) return;
  const total = pdfDoc.numPages;
  for (let i = 1; i <= total; i++) {
    // 切论文期间老 promise 还在跑 → 检测 state.pdf 是否还指向同一 doc，不是就放弃
    if (state.pdf !== pdfDoc) return;
    const wrap = document.createElement("div");
    wrap.className = "thumb-item";
    wrap.dataset.pageNumber = String(i);
    wrap.tabIndex = 0;
    wrap.setAttribute("role", "button");
    wrap.setAttribute("aria-label", `第 ${i} 页`);

    const canvas = document.createElement("canvas");
    const label = document.createElement("div");
    label.className = "thumb-label";
    label.textContent = String(i);

    wrap.appendChild(canvas);
    wrap.appendChild(label);
    view.appendChild(wrap);

    try {
      const page = await pdfDoc.getPage(i);
      const viewport = page.getViewport({ scale: 0.2 });   // ~120px 宽
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = "120px";
      canvas.style.height = "auto";
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    } catch (e) {
      // 单页渲染失败不影响其他页（极少见，可能是损坏 PDF）
      console.warn(`[renderThumbnails] page ${i} 渲染失败`, e);
    }
  }
  // 渲染完成 → 立刻把当前页标 selected（如果用户已经在翻页）
  try { highlightCurrentThumb(state.currentPage || 1); } catch (_) {}
}

// 高亮当前页缩略图 + 滚入视野
function highlightCurrentThumb(pageNum) {
  const view = els.thumbnailView;
  view.querySelectorAll(".thumb-item").forEach((t) => {
    t.classList.toggle("selected", Number(t.dataset.pageNumber) === pageNum);
  });
  const cur = view.querySelector(`.thumb-item[data-page-number="${pageNum}"]`);
  if (cur) cur.scrollIntoView({ block: "nearest" });
}

// 点击委托：缩略图 → 跳到对应页（参考 cite-link 同款 scrollPageIntoView 逻辑）
// v3-polish-3 #3：保留 viewer 水平 scrollLeft —— 用户缩放/横向滚到某位置后跳页不丢位置
// PDF.js scrollPageIntoView 会重置 scrollLeft（它只关心垂直对齐）→ 先存后改、双 rAF 等异步滚定后恢复
els.thumbnailView.addEventListener("click", (e) => {
  const wrap = e.target.closest(".thumb-item");
  if (!wrap) return;
  const pageNum = Number(wrap.dataset.pageNumber);
  if (pageNum && state.pdf) {
    const prevScrollLeft = els.viewerContainer.scrollLeft;
    try {
      pdfViewer.scrollPageIntoView({ pageNumber: pageNum });
    } catch (err) {
      console.debug("[thumb-click] scrollPageIntoView failed:", err);
      return;
    }
    // 双 rAF：第一帧 pdf.js 内部 layout flush，第二帧恢复 scrollLeft
    // 单 rAF 实测在某些 zoom 下 scrollLeft 还会被 pdf.js 二次覆盖
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        els.viewerContainer.scrollLeft = prevScrollLeft;
      });
    });
  }
});

// 缩放控件 ─
// 当前显示数字（实数 → 百分比，预设值显示对应中文标签）
function updateZoomLevelUI() {
  if (!state.pdf) {
    els.zoomLevel.textContent = "100%";
    return;
  }
  const scale = pdfViewer.currentScale || 1;
  const pct = Math.round(scale * 100);
  // 当前用了预设字符串（page-width / page-fit）时显示中文
  const sv = pdfViewer.currentScaleValue;
  if (sv === "page-width") {
    els.zoomLevel.textContent = `${pct}% · 宽`;
  } else if (sv === "page-fit") {
    els.zoomLevel.textContent = `${pct}% · 适配`;
  } else {
    els.zoomLevel.textContent = `${pct}%`;
  }
}
function zoomOut() {
  if (!state.pdf) return;
  const cur = pdfViewer.currentScale || 1;
  pdfViewer.currentScale = Math.max(0.25, cur * 0.9);
}
function zoomIn() {
  if (!state.pdf) return;
  const cur = pdfViewer.currentScale || 1;
  pdfViewer.currentScale = Math.min(4.0, cur * 1.1);
}
function openZoomMenu() {
  if (!state.pdf) return;
  els.zoomMenu.hidden = false;
  els.zoomLevel.setAttribute("aria-expanded", "true");
}
function closeZoomMenu() {
  els.zoomMenu.hidden = true;
  els.zoomLevel.setAttribute("aria-expanded", "false");
}
els.zoomOut.addEventListener("click", zoomOut);
els.zoomIn.addEventListener("click", zoomIn);
els.zoomLevel.addEventListener("click", () => {
  if (els.zoomMenu.hidden) openZoomMenu(); else closeZoomMenu();
});
els.zoomMenu.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-scale]");
  if (!btn) return;
  const v = btn.dataset.scale;
  // 预设字符串（page-width / page-fit）→ currentScaleValue；数字 → currentScale
  if (v === "page-width" || v === "page-fit") {
    pdfViewer.currentScaleValue = v;
  } else {
    const n = parseFloat(v);
    if (!isNaN(n)) pdfViewer.currentScale = n;
  }
  closeZoomMenu();
});
// 点空白处关闭缩放菜单（与 thread-list 同模式）
document.addEventListener("mousedown", (e) => {
  if (els.zoomMenu.hidden) return;
  if (e.target.closest("#zoomMenu") || e.target.closest("#zoomLevel")) return;
  closeZoomMenu();
});

els.findInput.addEventListener("input", () => {
  // 页内黄色高亮 + n/m 计数：实时跟随（保留现有行为）
  dispatchFind("");
  // v5：实时下拉预览 —— debounce 250ms，避免快速打字每键都搜 pdfText
  if (_findDebounceTimer) clearTimeout(_findDebounceTimer);
  const query = els.findInput.value.trim();
  if (!query) { hideFindDropdown(); return; }
  _findDebounceTimer = setTimeout(() => renderFindDropdown(query), 250);
});
els.findInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    findAgain(e.shiftKey);
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeFindBar();
  }
});
// v5：点 dropdown 结果 → 跳页（保留 scrollLeft）
els.findDropdown.addEventListener("click", (e) => {
  const item = e.target.closest(".find-result");
  if (!item) return;
  jumpToFindResult(Number(item.dataset.page));
});
// v5：点别处收起 dropdown（参考色板 / thread-list 同款 document mousedown）
document.addEventListener("mousedown", (e) => {
  if (els.findDropdown.hidden) return;
  if (e.target.closest("#findBar")) return;
  hideFindDropdown();
});

document.addEventListener("keydown", (e) => {
  if (!els.reader.classList.contains("active")) return;
  // ⌘/Ctrl + F 触发搜索（全局，即使焦点在 textarea 也接，便于"读到一段想搜"）
  if (e.key === "f" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    openFindBar();
    return;
  }
  // 搜索栏没开 + ESC：让 viewer 失焦（兜底）
  // 搜索栏开着时 ESC 的处理在 findInput 自己的 keydown 里
  // 输入框聚焦时不抢其他键（防止打字时被吃）
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea") return;
  // viewer 连续滚动 + ←/→ 已被官方 viewer 处理（翻页），这里不再额外绑定
});

// v4：chat textarea auto-grow —— scrollHeight 派（行业主流：ChatGPT / Claude / Slack / Linear）
// CSS 已 resize:none + box-sizing:border-box + min-height:44px / max-height:240px
// v3-polish-5：overflow-y 由 autoGrow 控制 —— 仅当 scrollHeight 超过 240（max-height）才显示滚动条
// CSS 默认 overflow-y: hidden；这样 5 行以内的输入完全没有内部 scrollbar 的视觉噪声
// 关键坑：programmatic 清空 value 不触发 input 事件 → 每处 chatInput.value="" 后都要手动调 autoGrow
function autoGrow(el) {
  if (!el) return;
  el.style.height = "auto";
  const target = Math.min(el.scrollHeight, 240);
  el.style.height = target + "px";
  el.style.overflowY = el.scrollHeight > 240 ? "auto" : "hidden";
}
els.chatInput.addEventListener("input", () => autoGrow(els.chatInput));

els.chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  // 流式中点击 = 中止生成。abort 后 sendMessage 的 catch(AbortError) + finally 会善后
  if (state.streaming) {
    state.abortCtl?.abort();
    return;
  }
  const text = els.chatInput.value.trim();
  if (!text) return;
  els.chatInput.value = "";
  autoGrow(els.chatInput);
  sendMessage(text);
});

// v3-δ：引用回链 click 委托 —— 点 〔p.N〕 → 滚到该页 + flash
// 挂在 chatMessages 上一次性绑定，所有 assistant 消息共享
els.chatMessages.addEventListener("click", (e) => {
  const link = e.target.closest(".cite-link");
  if (!link) return;
  e.preventDefault();
  const pageNum = parseInt(link.dataset.page, 10);
  if (!pageNum || !state.pdf) return;
  // 边缘 case：页码超出 PDF 总页数 → safe-fail（console.debug 留痕）
  if (pageNum < 1 || pageNum > state.totalPages) {
    console.debug("[cite-link] page out of range:", pageNum, "total=" + state.totalPages);
    return;
  }
  // v3-polish-3 #3：cite-link 跳页同样保留 scrollLeft（同款问题：pdf.js 重置水平位置）
  const prevScrollLeft = els.viewerContainer.scrollLeft;
  try {
    pdfViewer.scrollPageIntoView({ pageNumber: pageNum });
  } catch (err) {
    console.debug("[cite-link] scrollPageIntoView failed:", err);
    return;
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      els.viewerContainer.scrollLeft = prevScrollLeft;
    });
  });
  flashPage(pageNum);
});

els.chatInput.addEventListener("keydown", (e) => {
  // Enter 发送 / Shift+Enter 换行 —— 标准 chat 行为 (ChatGPT/Claude/iMessage)
  // 中文 IME 拼音组合中的 Enter 是确认候选词，不应触发发送 → 用 isComposing 守门
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    els.chatForm.dispatchEvent(new Event("submit"));
  }
});

// ────────────────────── v2-a 事件绑定 ──────────────────────

// mouseup on viewer：判断是否有选区 → 浮出色板
// 注意：mouseup 在选区刚定下来的下一帧才能可靠拿到 selection，用 setTimeout 0
// 不监听 selectionchange —— 它在拖选过程中疯狂触发，会反复闪
els.viewerContainer.addEventListener("mouseup", (e) => {
  // 点在色板 / 气泡上不重新判断（让它们自己的 click handler 处理）
  if (e.target.closest("#colorPalette") || e.target.closest("#hlBubble")) return;
  // 点击高亮 rect —— 由 rect 自己的 click handler 处理，不抢
  if (e.target.closest && e.target.closest(".hl-rect")) return;
  // v3-polish-4 #3：选段卡顿排查 —— 标记 mouseup → palette 整条路径耗时
  // 鸭鸭反馈"选段没选中似乎有点卡顿"。用 console.time/timeEnd 让 test 抓样本，
  // 后续若发现热点（如 getClientRects 数百个 rect）再做优化
  console.time("[selection] mouseup→palette");
  // v2-b：去掉 setTimeout(0)，改用 requestAnimationFrame
  // RAF 在浏览器下一帧执行，比 setTimeout(0) 更快、更顺滑（无 4ms clamp，对齐渲染节拍）
  requestAnimationFrame(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.toString().trim().length === 0) {
      hideColorPalette();
      console.timeEnd("[selection] mouseup→palette");
      return;
    }
    // 有选区 → 同时确保气泡不挡道
    hideHlBubble();
    console.time("[selection] describe+showPalette");
    showColorPalette();
    console.timeEnd("[selection] describe+showPalette");
    console.timeEnd("[selection] mouseup→palette");
  });
});

// 色板按钮点击：选色
// 关键：mousedown 上 preventDefault 阻止 button 抢焦点 → 选区不会被 collapse → selectionchange 不会误关
els.colorPalette.addEventListener("mousedown", (e) => {
  if (e.target.closest("button")) {
    e.preventDefault();
  }
});
els.colorPalette.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  // v3-polish：cp-close 已删；这里只剩"选色"路径
  const color = btn.dataset.color;
  if (color) createAnnotation(color);
});
// v3-polish-2 #1：选区一旦 collapse → 立刻 hide 色板（无任何守门 flag）
// 上轮 v3-polish 的 _paletteInteracting flag 不够可靠：mousedown 抢标 + mouseup 清标
// 之间任何路径出错（如 mousedown 没触发到 button）都会让 flag 卡 true、或反复闪
// 新设计：palette button 的 mousedown preventDefault 已经阻止 selection collapse，
//        所以"用户在点色板"时 selection 根本不 collapse → selectionchange 不会误关 →
//        无需任何 flag。任何 collapse 都是用户真的取消选区 → 应该 hide
document.addEventListener("selectionchange", () => {
  if (els.colorPalette.hidden) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.toString().trim().length === 0) {
    hideColorPalette();
  }
});

// 鼠标离开色板 → 150ms 缓冲后自动 hide；缓冲期内 mouseenter 取消（让用户能点按钮）
els.colorPalette.addEventListener("mouseleave", () => {
  if (_paletteHideTimer) clearTimeout(_paletteHideTimer);
  _paletteHideTimer = setTimeout(() => {
    _paletteHideTimer = null;
    hideColorPalette();
  }, HOVER_HIDE_DELAY);
});
els.colorPalette.addEventListener("mouseenter", () => {
  if (_paletteHideTimer) { clearTimeout(_paletteHideTimer); _paletteHideTimer = null; }
});

// 高亮 rect 点击：浮出气泡
// 用事件委托（rect 是动态创建的）
els.viewerContainer.addEventListener("click", (e) => {
  const rect = e.target.closest(".hl-rect");
  if (!rect) return;
  e.stopPropagation();
  const annId = rect.dataset.annId;
  const r = rect.getBoundingClientRect();
  showHlBubble(annId, r);
});

// 气泡按钮：引用 / 删除
els.hlBubble.addEventListener("mousedown", (e) => {
  // 防止气泡按钮夺焦后干扰 selection
  if (e.target.closest("button")) e.preventDefault();
});
els.hlBubble.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const annId = els.hlBubble.dataset.annId;
  const ann = state.annotations.find((a) => a.id === annId);
  // v3-polish-2 #1：无论 ann 是否存在、动作成功与否，**先**藏 bubble（鸭鸭：点完按钮气泡必须消失）
  //   把 hide 放到 handler 顶部，避免任何下游路径抛错导致 bubble 留在屏幕上
  hideHlBubble();
  if (!ann) return;
  if (btn.dataset.action === "quote") {
    // v2-b：点"引用"= 切到该 ann 的 thread 并写入引用块
    //   设计决策：单击高亮不切 thread（只浮气泡，不打扰阅读）；
    //   只有显式点"↪ 引用"才切，符合"动作=意图"原则
    // 这是显式切（用户意图）→ autoScroll 默认 true，滚到 anchorPage + 居中 hl-rect
    ensureAnnotationThread(ann);
    switchThread(ann.id);
    quoteAnnotationToChat(ann);
  } else if (btn.dataset.action === "delete") {
    deleteAnnotation(annId);
  }
});
// 鼠标离开气泡 → 150ms 缓冲后自动 hide；缓冲期内 mouseenter 取消
els.hlBubble.addEventListener("mouseleave", () => {
  if (_bubbleHideTimer) clearTimeout(_bubbleHideTimer);
  _bubbleHideTimer = setTimeout(() => {
    _bubbleHideTimer = null;
    hideHlBubble();
  }, HOVER_HIDE_DELAY);
});
els.hlBubble.addEventListener("mouseenter", () => {
  if (_bubbleHideTimer) { clearTimeout(_bubbleHideTimer); _bubbleHideTimer = null; }
});

// 点 viewer 空白处（不是高亮、不是色板/气泡、也没新选区）→ 关闭气泡
// 点 viewer 之外（如 chat 区域）→ 关闭色板和气泡
document.addEventListener("mousedown", (e) => {
  if (e.target.closest("#colorPalette") || e.target.closest("#hlBubble")) return;
  if (e.target.closest(".hl-rect")) return;
  hideHlBubble();
  // 点击不在 viewer 内 → 直接关色板（viewer 内由 mouseup 决定）
  if (!els.viewerContainer.contains(e.target)) hideColorPalette();
});

// 滚动时：高亮跟随 .page 自动走（百分比定位），但浮动 toolbar 不跟随 → 直接收起
els.viewerContainer.addEventListener("scroll", () => {
  if (!els.colorPalette.hidden) hideColorPalette();
  if (!els.hlBubble.hidden) hideHlBubble();
}, { passive: true });

// ────────────────────── v3-β 事件绑定 ──────────────────────

// 主题列表 "+ 新建主题"
els.newTopicBtn.addEventListener("click", openNewTopicModal);

// 主题页 "←" 返回主题列表
els.topicBack.addEventListener("click", () => switchToTopicList());

// 主题页 "查看色板"（只读 popover）
els.tpPaletteToggle.addEventListener("click", () => {
  const topic = state.topics[state.currentTopicId];
  if (!topic) return;
  if (els.paletteViewer.hidden) showPaletteViewer(topic);
  else hidePaletteViewer();
});
els.pvClose.addEventListener("click", hidePaletteViewer);

// v3-δ：导出笔记
els.tpExportBtn.addEventListener("click", async () => {
  if (els.tpExportBtn.disabled) return;
  // 防重复点（导出过程异步，避免重复触发下载）
  els.tpExportBtn.disabled = true;
  try {
    await downloadTopicMarkdown(state.currentTopicId);
  } finally {
    // 重新按 topic.pdfKeys 状态回算（导出过程中 pdfKeys 不会变，但保险）
    const topic = state.topics[state.currentTopicId];
    updateExportBtnState(topic);
  }
});

// 主题卡片 "..." 菜单
els.topicCardMenu.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  const id = _menuTargetTopicId;
  hideTopicCardMenu();
  if (!id || id === DEFAULT_TOPIC_ID) return;
  if (action === "rename") {
    const cur = state.topics[id]?.name || "";
    const next = window.prompt("新的主题名（≤ 30 字）：", cur);
    if (next == null) return;            // 取消
    const trimmed = next.trim().slice(0, 30);
    if (!trimmed || trimmed === cur) return;
    await renameTopic(id, trimmed);
    renderTopicGrid();
  } else if (action === "delete") {
    const topic = state.topics[id];
    if (!topic) return;
    const n = (topic.pdfKeys || []).length;
    const ok = window.confirm(
      `确认删除主题"${topic.name}"？\n` +
      `${n > 0 ? `该主题下的 ${n} 篇论文 + 围绕它们的所有 annotation / 讨论将一并清除。\n` : ""}` +
      `（不可撤销）`
    );
    if (!ok) return;
    await deleteTopic(id);
    renderTopicGrid();
  }
});
// 点空白关闭 ... 菜单
document.addEventListener("mousedown", (e) => {
  if (els.topicCardMenu.hidden) return;
  if (e.target.closest("#topicCardMenu")) return;
  if (e.target.closest(".tc-menu-btn")) return;
  hideTopicCardMenu();
});
// 点空白关闭 palette viewer（除非点的是 viewer 自己或触发按钮）
document.addEventListener("mousedown", (e) => {
  if (els.paletteViewer.hidden) return;
  if (e.target.closest("#paletteViewer")) return;
  if (e.target.closest("#tpPaletteToggle")) return;
  hidePaletteViewer();
});

// 新建主题 modal 控制
els.ntmClose.addEventListener("click", closeNewTopicModal);
els.newTopicModal.addEventListener("click", (e) => {
  // 点 mask（不是 modal 本身）= 取消
  if (e.target === els.newTopicModal) closeNewTopicModal();
});
els.ntmNameInput.addEventListener("input", () => {
  ntmDraft.name = els.ntmNameInput.value;
  ntmUpdateNextEnabled();
});
els.ntmNameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) {
    e.preventDefault();
    if (!els.ntmNext.disabled) els.ntmNext.click();
  }
});
els.ntmNext.addEventListener("click", () => {
  if (ntmDraft.step === 1) {
    ntmDraft.name = els.ntmNameInput.value.trim();
    if (!ntmDraft.name) return;
    ntmDraft.step = 2;
  } else if (ntmDraft.step === 2) {
    // 验证：每行 label 非空 + 至少 1 行
    if (ntmDraft.paletteDraft.length < MIN_PALETTE_ROWS) return;
    if (ntmDraft.paletteDraft.some((p) => !p.label || !p.label.trim())) return;
    ntmDraft.step = 3;
  }
  ntmRenderStep();
});
els.ntmPrev.addEventListener("click", () => {
  if (ntmDraft.step > 1) ntmDraft.step -= 1;
  ntmRenderStep();
});
els.ntmAddRow.addEventListener("click", ntmAddPaletteRow);
els.ntmConfirm.addEventListener("click", ntmDoCreate);

// ESC 关 modal / palette viewer / "..." 菜单
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!els.newTopicModal.hidden) { closeNewTopicModal(); return; }
  if (!els.paletteViewer.hidden) { hidePaletteViewer(); return; }
  if (!els.topicCardMenu.hidden) { hideTopicCardMenu(); return; }
});

// 启动后渲染主题列表：等 bootstrap 完成（加载完所有 topics）
// bootstrap 失败时 state.topics 至少有内存兜底的 default
_bootstrapPromise.then(() => {
  // 二次兜底：bootstrap 跑完，state.topics 仍空时塞个默认（极端 IDB 故障）
  if (Object.keys(state.topics).length === 0) {
    state.topics[DEFAULT_TOPIC_ID] = {
      id: DEFAULT_TOPIC_ID,
      name: "默认主题",
      palette: DEFAULT_PALETTE.map((p) => ({ ...p })),
      pdfKeys: [],
      createdAt: new Date().toISOString(),
    };
  }
  renderTopicGrid();
});
