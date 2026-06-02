/**
 * Co-Read Web · 前端
 * 单文件 vanilla JS，函数分区组织：state / pdfRenderer / chatClient / ui
 * v1 范围：官方 PDFViewer 接入（连续滚动 + text layer + 搜索）、文字抽取、流式对话、翻页同步给 agent
 * v2 待加：划线高亮、颜色分类、多对话、笔记导出
 * v3 待加：sidebar 缩略图 + outline
 */

// PDF.js 自托管：所有资源由本服务 /vendor/pdfjs/ 提供，消除 CDN 单点
// （cdnjs/jsdelivr 任何一环抖动都会让 worker 加载失败 → getDocument 静默 reject）
import * as pdfjsLib from "/vendor/pdfjs/build/pdf.min.mjs";
import * as pdfjsViewer from "/vendor/pdfjs/web/pdf_viewer.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/build/pdf.worker.min.mjs";

const PDFJS_ASSET_BASE = "/vendor/pdfjs/";
const PDFJS_DOC_OPTS = {
  cMapUrl: PDFJS_ASSET_BASE + "cmaps/",
  cMapPacked: true,
  standardFontDataUrl: PDFJS_ASSET_BASE + "standard_fonts/",
};

// ────────────────────── 轻量埋点（试用期）──────────────────────
// 只记行为信号 + 轻量元数据，绝不记内容（论文正文 / 批注 / AI 对话 / 划选原文 / PII 永不上报）。
// fire-and-forget：发到 /api/event，绝不阻塞 UI、绝不抛错。
const _SID = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
function track(event, meta) {
  try {
    fetch("/api/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, ts: Date.now(), sid: _SID, ...(meta || {}) }),
    }).catch(() => {});
  } catch (_) { /* 绝不抛错 */ }
}
track("session_start");

// ────────────────────── i18n（中/英语言切换）──────────────────────
// 语言存 localStorage（key: coread_lang，值 zh / en），默认 zh。
// I18N 字符串表只覆盖 app 自带界面文案 + 默认/示例内容；用户自建数据保持原文。
const LANG_KEY = "coread_lang";
function getLang() {
  try {
    const v = localStorage.getItem(LANG_KEY);
    return v === "en" ? "en" : "zh";
  } catch (_) { return "zh"; }
}
function setLang(lang) {
  const v = lang === "en" ? "en" : "zh";
  try { localStorage.setItem(LANG_KEY, v); } catch (_) {}
}
let LANG = getLang();

const I18N = {
  zh: {
    htmlLang: "zh",
    docTitle: "Co-Read · 论文伴读",
    // 首页
    tagline: "粘贴论文链接，开始深度伴读。",
    homeUrlPlaceholder: "arXiv 链接 / 直接 PDF URL →",
    homeSubmitAria: "开始伴读",
    homeHintPrefix: "支持 arXiv 链接 / 直接 PDF URL / ",
    fileLinkLabel: "本地 PDF",
    homeManage: "我的主题 →",
    recentHead: "最近在读",
    exampleBadge: "示例",
    // 主题列表
    topicListBack: "← 首页",
    topicsTitle: "主题",
    topicsTagline: "每个主题 = 一组论文 + 一套冻结色板 + 一份导出笔记。",
    newTopicBtn: "+ 新建主题",
    // 主题页
    topicBackAria: "返回主题列表",
    tpPaletteTitle: "主题创建后色板不可修改",
    tpUrlPlaceholder: "粘贴论文链接，加入本主题 →",
    tpSubmitAria: "加入主题",
    tpExportBtn: "[导出笔记]",
    tpExportTitle: "导出本主题为 markdown 笔记",
    tpExportEmptyTitle: "主题里还没有论文",
    tpPdfCount: (n) => `${n} 篇`,
    tpEmptyPdf: "还没有论文。粘贴一个链接或选本地 PDF 开始读。",
    tpMoreActions: "更多操作",
    tpRemoveTitle: "从本主题移除（不删 annotation 数据）",
    tpRemoveAria: "移除",
    tpRenameAria: "重命名主题",
    readerTopicHintTitle: (name) => `点击重命名（当前：${name}）`,
    // 新建主题 modal
    ntmTitle: "新建主题",
    ntmCancelAria: "取消",
    ntmNameLabel: "主题名（≤ 30 字）",
    ntmNamePlaceholder: "例如：LLM 综述 / 博士开题",
    ntmHintExample: 'e.g. "RAG 评估" / "我的研究方向"',
    ntmHintWarn: "⚠ 创建后整套色板将完全冻结",
    ntmAddRow: "+ 添加一行",
    ntmConfirmText: "即将创建主题：",
    ntmWarn: "⚠ 创建后 palette 不可改。确认创建？",
    ntmStepIndicator: (s) => `第 ${s} / 3 步`,
    ntmPrev: "← 上一步",
    ntmNext: "下一步 →",
    ntmConfirm: "确认创建",
    ntmUnnamedName: "(未命名)",
    ntmUnnamedTag: "(未命名标签)",
    ntmTagColorTitle: "标签颜色（创建后冻结）",
    ntmTagPlaceholder: "标签 ≤ 20 字",
    ntmDelRowTitle: "删除此行",
    ntmNewTagLabel: "新标签",
    // 主题卡片菜单
    cardRename: "重命名",
    cardDelete: "删除主题",
    // loading
    loadingDefault: "加载中…",
    loadingFetchPdf: "正在拉取 PDF…",
    loadingParse: (total, done) => `正在解析正文（共 ${total} 页，${done}/${total}）…`,
    loadFailed: (msg) => `加载失败：${msg}`,
    // 阅读器
    backReaderAria: "返回主题页",
    zoomAria: "缩放",
    zoomOut: "缩小",
    zoomIn: "放大",
    zoomPreset: "缩放预设",
    zoomFitWidth: "适合宽度",
    zoomFitPage: "适合页面",
    findPlaceholder: "搜索…",
    findPrevAria: "上一个匹配",
    findPrevTitle: "上一个 (Shift+Enter)",
    findNextAria: "下一个匹配",
    findNextTitle: "下一个 (Enter)",
    findCloseAria: "清空搜索",
    findCloseTitle: "清空",
    findDropdownAria: "搜索结果预览",
    findParsing: "正在解析正文…",
    findNoMatch: "无匹配",
    findCountCapped: (n, max) => `共 ${n}+ 处（仅显示前 ${max}）`,
    findCount: (n) => `共 ${n} 处匹配`,
    thumbSidebarAria: "页面缩略图",
    thumbPageAria: (i) => `第 ${i} 页`,
    colorPaletteAria: "高亮颜色选择",
    cmtComposePlaceholder: "写批注…  输入 @ 可召唤 AI",
    cmtComposeSend: "发送",
    cmtComposeStop: "停止",
    cmtSummaryPreparing: "准备中…",
    cmtSummaryEmpty: "还没有 comment —— 划线选色即可建一条",
    cmtSummaryCount: (n) => `${n} 条 comment`,
    commentListAria: "comment 列表",
    readerExportBtn: "导出笔记 ↓",
    readerExportTitle: "把本篇收入笔记的内容导出为 markdown",
    cmtTagFallback: "标签",
    cmtFulltextLabel: "全文",
    cmtFulltextQuote: "全文导读",
    cmtNoQuote: "(无原文)",
    cmtDelTitle: "删除这条高亮 + 讨论",
    cmtDelAria: "删除 comment",
    cmtShowHidden: (n) => `··· 展开折叠的 ${n} 条 ···`,
    roleUser: "你",
    roleAgent: "Agent",
    roleUserColon: "你：",
    roleAgentColon: "Agent：",
    noteInclude: "收入笔记",
    citeJumpTitle: (n) => `跳到第 ${n} 页`,
    confirmDeleteComment: (n) => `删除这条 comment？\n高亮原文 + ${n} 条讨论将一并清除（不可撤销）。`,
    promptRenameTopic: "新的主题名（≤ 30 字）：",
    confirmDeleteTopic: (name, n) =>
      `确认删除主题"${name}"？\n` +
      `${n > 0 ? `该主题下的 ${n} 篇论文 + 围绕它们的所有 annotation / 讨论将一并清除。\n` : ""}` +
      `（不可撤销）`,
    createTopicFailed: (msg) => `创建主题失败：${msg}`,
    localFileError: "本地文件无法保存，请重新选择 PDF 文件。",
    unknownPdfKey: (k) => `未知 PDF key 格式: ${k}`,
    // 导出页
    exportBackAria: "返回",
    exportTitle: "导出笔记",
    exportDownload: "下载 .md",
    exportScopeLabel: "范围",
    exportScopeCurrent: "当前篇",
    exportScopeTopic: "整个主题",
    exportGroupLabel: "分组",
    exportGroupTag: "按标签",
    exportGroupReading: "按阅读顺序",
    exportPreviewHint: "预览 —— 勾选要收入的内容，取消的不导出",
    exportPreviewFailed: "预览加载失败",
    exportNothing: "没有可导出的内容",
    exportEmptyPdf: "（这一篇暂无笔记）",
    exportSelectAll: "全选",
    exportDeselectAll: "全部取消",
    exportFulltextGroup: "📄 全文导读",
    exportOtherGroup: "其它",
    exportNoteFallback: "笔记",
    // 导出 markdown
    mdFulltext: "### 📄 全文导读",
    mdHighlightNotes: "### 划线笔记",
    mdOther: "### 其它",
    mdEmptyNote: "_（暂无笔记 —— 划线标记或 @AI 讨论后再导出）_",
    mdExportTime: (now, sub) => `> 导出时间 ${now} · ${sub}`,
    mdTagsLine: (tags) => `> 标签：${tags}`,
    mdTopicNoteTitle: (name) => `主题笔记：${name}`,
    mdTopicNoPdf: "_（主题里还没有论文）_",
    mdAnnReadFailed: "_（annotation 数据读取失败）_",
    mdNoteTitle: (title) => `笔记：${title}`,
    mdSubTopicPrefix: (name) => `主题 ${name} · `,
    mdSubGroupBody: (sub) => `收入笔记的内容，${sub}`,
    mdGroupReading: "按阅读顺序",
    mdGroupTag: "按标签归类",
    mdRoleUser: "你",
    mdRoleAgent: "Agent",
    mdExportTitlePrefix: (title) => `# 笔记：${title}`,
    // 错误
    errNotStream: "上游返回的不是流式响应。",
    errEmptyContent: "上游返回空内容（可能被安全过滤或额度耗尽）。",
    errBadFormat: "⚠ 上游返回格式异常（详情见 console）",
    errTopicNotExist: "主题不存在",
    aborted: "_（已中止）_",
    unnamedTopic: "未命名主题",
    unnamedPdf: "(未命名)",
    // 时间
    timeJustNow: "刚刚",
    timeMinAgo: (n) => `${n} 分钟前`,
    timeHourAgo: (n) => `${n} 小时前`,
    timeDayAgo: (n) => `${n} 天前`,
    // @ 联想
    mentionAria: "@ 联想",
    mentionAiHint: "召唤 AI 回复",
    // AI 提问
    primeKeyword: "核心总结",
    defaultQMain: () => `请给这篇论文一个 100 字以内的核心总结（What / Why / How / Result）。`,
    defaultQHighlight: "请帮我解读这段划线原文。",
    annContextNote: (page, text) =>
      `用户正在讨论第 ${page} 的一段划线原文：\n"""${text}"""\n回答请围绕这段原文。`,
    // 语言开关
    langSwitchAria: "语言 / Language",
    // 示例条目
    exampleRecentTitle: "Clio 论文（点开看 co-read 怎么用）",
    defaultTopicName: "示例主题",
    // 引用 / Cite
    citeBtn: "引用",
    citeBtnTitle: "生成本篇论文的引用",
    citeTitle: "引用本文",
    citeCloseAria: "关闭",
    citeMetaHead: "元数据（可编辑）",
    citeFieldTitle: "标题",
    citeFieldAuthors: "作者",
    citeFieldYear: "年份",
    citeFieldVenue: "出处 / 期刊",
    citeFieldDoi: "DOI / arXiv ID",
    citeAuthorsPlaceholder: "多位作者用分号或逗号分隔",
    citeFormatHead: "引用格式",
    citeOutputHead: "引用文本",
    citeCopyBtn: "复制",
    citeCopiedBtn: "已复制 ✓",
    citeFetching: "正在抓取元数据…",
    citeFetchFailed: "未能自动抓取，请手动填写。",
    citeEmptyHint: "暂无元数据，请填写后生成引用。",
  },
  en: {
    htmlLang: "en",
    docTitle: "Co-Read · Paper Companion",
    tagline: "Paste a paper link to start deep reading.",
    homeUrlPlaceholder: "arXiv link / direct PDF URL →",
    homeSubmitAria: "Start reading",
    homeHintPrefix: "Supports arXiv link / direct PDF URL / ",
    fileLinkLabel: "local PDF",
    homeManage: "My topics →",
    recentHead: "Recently reading",
    exampleBadge: "Example",
    topicListBack: "← Home",
    topicsTitle: "Topics",
    topicsTagline: "Each topic = a set of papers + a frozen palette + an exported note.",
    newTopicBtn: "+ New topic",
    topicBackAria: "Back to topic list",
    tpPaletteTitle: "The palette cannot be changed after the topic is created",
    tpUrlPlaceholder: "Paste a paper link to add to this topic →",
    tpSubmitAria: "Add to topic",
    tpExportBtn: "[Export note]",
    tpExportTitle: "Export this topic as a markdown note",
    tpExportEmptyTitle: "No papers in this topic yet",
    tpPdfCount: (n) => `${n} paper${n === 1 ? "" : "s"}`,
    tpEmptyPdf: "No papers yet. Paste a link or pick a local PDF to start reading.",
    tpMoreActions: "More actions",
    tpRemoveTitle: "Remove from this topic (annotation data is kept)",
    tpRemoveAria: "Remove",
    tpRenameAria: "Rename topic",
    readerTopicHintTitle: (name) => `Click to rename (current: ${name})`,
    ntmTitle: "New topic",
    ntmCancelAria: "Cancel",
    ntmNameLabel: "Topic name (≤ 30 chars)",
    ntmNamePlaceholder: "e.g. LLM survey / PhD proposal",
    ntmHintExample: 'e.g. "RAG evaluation" / "My research direction"',
    ntmHintWarn: "⚠ The whole palette will be fully frozen after creation",
    ntmAddRow: "+ Add a row",
    ntmConfirmText: "About to create topic:",
    ntmWarn: "⚠ The palette cannot be changed after creation. Confirm?",
    ntmStepIndicator: (s) => `Step ${s} / 3`,
    ntmPrev: "← Back",
    ntmNext: "Next →",
    ntmConfirm: "Create",
    ntmUnnamedName: "(unnamed)",
    ntmUnnamedTag: "(unnamed tag)",
    ntmTagColorTitle: "Tag color (frozen after creation)",
    ntmTagPlaceholder: "Tag ≤ 20 chars",
    ntmDelRowTitle: "Delete this row",
    ntmNewTagLabel: "New tag",
    cardRename: "Rename",
    cardDelete: "Delete topic",
    loadingDefault: "Loading…",
    loadingFetchPdf: "Fetching PDF…",
    loadingParse: (total, done) => `Parsing text (${total} pages, ${done}/${total})…`,
    loadFailed: (msg) => `Load failed: ${msg}`,
    backReaderAria: "Back to topic page",
    zoomAria: "Zoom",
    zoomOut: "Zoom out",
    zoomIn: "Zoom in",
    zoomPreset: "Zoom presets",
    zoomFitWidth: "Fit width",
    zoomFitPage: "Fit page",
    findPlaceholder: "Search…",
    findPrevAria: "Previous match",
    findPrevTitle: "Previous (Shift+Enter)",
    findNextAria: "Next match",
    findNextTitle: "Next (Enter)",
    findCloseAria: "Clear search",
    findCloseTitle: "Clear",
    findDropdownAria: "Search results preview",
    findParsing: "Parsing text…",
    findNoMatch: "No matches",
    findCountCapped: (n, max) => `${n}+ matches (showing first ${max})`,
    findCount: (n) => `${n} matches`,
    thumbSidebarAria: "Page thumbnails",
    thumbPageAria: (i) => `Page ${i}`,
    colorPaletteAria: "Highlight color picker",
    cmtComposePlaceholder: "Write a note…  type @ to summon AI",
    cmtComposeSend: "Send",
    cmtComposeStop: "Stop",
    cmtSummaryPreparing: "Preparing…",
    cmtSummaryEmpty: "No comments yet — highlight and pick a color to create one",
    cmtSummaryCount: (n) => `${n} comment${n === 1 ? "" : "s"}`,
    commentListAria: "Comment list",
    readerExportBtn: "Export note ↓",
    readerExportTitle: "Export the note-included content of this paper as markdown",
    cmtTagFallback: "Tag",
    cmtFulltextLabel: "Full text",
    cmtFulltextQuote: "Full-text overview",
    cmtNoQuote: "(no source text)",
    cmtDelTitle: "Delete this highlight + discussion",
    cmtDelAria: "Delete comment",
    cmtShowHidden: (n) => `··· Show ${n} collapsed ···`,
    roleUser: "You",
    roleAgent: "Agent",
    roleUserColon: "You: ",
    roleAgentColon: "Agent: ",
    noteInclude: "Include in note",
    citeJumpTitle: (n) => `Jump to page ${n}`,
    confirmDeleteComment: (n) => `Delete this comment?\nThe highlighted text + ${n} discussion message(s) will be removed (cannot be undone).`,
    promptRenameTopic: "New topic name (≤ 30 chars):",
    confirmDeleteTopic: (name, n) =>
      `Delete topic "${name}"?\n` +
      `${n > 0 ? `The ${n} paper(s) in this topic and all their annotations / discussions will be removed.\n` : ""}` +
      `(cannot be undone)`,
    createTopicFailed: (msg) => `Failed to create topic: ${msg}`,
    localFileError: "Local files cannot be saved, please re-select the PDF file.",
    unknownPdfKey: (k) => `Unknown PDF key format: ${k}`,
    exportBackAria: "Back",
    exportTitle: "Export note",
    exportDownload: "Download .md",
    exportScopeLabel: "Scope",
    exportScopeCurrent: "Current paper",
    exportScopeTopic: "Whole topic",
    exportGroupLabel: "Group by",
    exportGroupTag: "By tag",
    exportGroupReading: "By reading order",
    exportPreviewHint: "Preview — check items to include, unchecked items are excluded",
    exportPreviewFailed: "Failed to load preview",
    exportNothing: "Nothing to export",
    exportEmptyPdf: "(no notes for this paper yet)",
    exportSelectAll: "Select all",
    exportDeselectAll: "Deselect all",
    exportFulltextGroup: "📄 Full-text overview",
    exportOtherGroup: "Other",
    exportNoteFallback: "Note",
    mdFulltext: "### 📄 Full-text overview",
    mdHighlightNotes: "### Highlight notes",
    mdOther: "### Other",
    mdEmptyNote: "_(No notes yet — highlight or discuss with @AI, then export)_",
    mdExportTime: (now, sub) => `> Exported ${now} · ${sub}`,
    mdTagsLine: (tags) => `> Tags: ${tags}`,
    mdTopicNoteTitle: (name) => `Topic note: ${name}`,
    mdTopicNoPdf: "_(No papers in this topic yet)_",
    mdAnnReadFailed: "_(Failed to read annotation data)_",
    mdNoteTitle: (title) => `Note: ${title}`,
    mdSubTopicPrefix: (name) => `Topic ${name} · `,
    mdSubGroupBody: (sub) => `Note-included content, ${sub}`,
    mdGroupReading: "by reading order",
    mdGroupTag: "grouped by tag",
    mdRoleUser: "You",
    mdRoleAgent: "Agent",
    mdExportTitlePrefix: (title) => `# Note: ${title}`,
    errNotStream: "The upstream response is not a stream.",
    errEmptyContent: "The upstream returned empty content (possibly filtered by safety or quota exhausted).",
    errBadFormat: "⚠ Unexpected upstream response format (see console for details)",
    errTopicNotExist: "Topic does not exist",
    aborted: "_(aborted)_",
    unnamedTopic: "Untitled topic",
    unnamedPdf: "(untitled)",
    timeJustNow: "just now",
    timeMinAgo: (n) => `${n} min ago`,
    timeHourAgo: (n) => `${n} hr ago`,
    timeDayAgo: (n) => `${n} day${n === 1 ? "" : "s"} ago`,
    mentionAria: "@ suggestions",
    mentionAiHint: "Summon AI to reply",
    primeKeyword: "core summary",
    defaultQMain: () =>
      `Please give a core summary of this paper in under 100 words (What / Why / How / Result). Respond in English.`,
    defaultQHighlight: "Please help me interpret this highlighted text. Respond in English.",
    annContextNote: (page, text) =>
      `The user is discussing a highlighted passage on ${page}:\n"""${text}"""\nAnswer focused on this passage.`,
    langSwitchAria: "语言 / Language",
    exampleRecentTitle: "Clio paper (open it to see how co-read works)",
    defaultTopicName: "Sample topic",
    // 引用 / Cite
    citeBtn: "Cite",
    citeBtnTitle: "Generate a citation for this paper",
    citeTitle: "Cite this paper",
    citeCloseAria: "Close",
    citeMetaHead: "Metadata (editable)",
    citeFieldTitle: "Title",
    citeFieldAuthors: "Authors",
    citeFieldYear: "Year",
    citeFieldVenue: "Venue / Journal",
    citeFieldDoi: "DOI / arXiv ID",
    citeAuthorsPlaceholder: "Separate multiple authors with ; or ,",
    citeFormatHead: "Citation style",
    citeOutputHead: "Citation",
    citeCopyBtn: "Copy",
    citeCopiedBtn: "Copied ✓",
    citeFetching: "Fetching metadata…",
    citeFetchFailed: "Could not auto-fetch, please fill in manually.",
    citeEmptyHint: "No metadata yet — fill in fields to generate a citation.",
  },
};
// 取当前语言字符串：t("key") 或 t("key", ...args) 对函数型条目求值
function t(key, ...args) {
  const v = (I18N[LANG] && I18N[LANG][key]) ?? (I18N.zh[key]);
  return typeof v === "function" ? v(...args) : v;
}

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
  // v6：thread = comment 的 messages 容器（id → thread；"main" 是全文 comment）
  threads: {},
  // v3-α 主题
  currentTopicId: "default",
  topics: {},          // id → topic 对象
  // v3-β 视图状态机：topicList（landing）/ topicPage / reader
  // newTopic 是 modal（叠在 topicList 上），不算独立 view
  view: "topicList",
  // v3-β 阅读页面打开时来自哪个主题（用于 "← 返回主题页"）
  // 默认 = "default"；用户从某主题点 PDF 进 reader 时设为该主题 id
  readerFromTopicId: "default",
  // v6 comment 模型：右栏手风琴当前展开的 comment id（null = 全折叠）
  expandedCommentId: null,
  // v6：级别 2 折叠 —— 这些 comment 的中间轮次已被用户点开「展开全部」
  cmtShowAll: new Set(),
  // v6 Block 3：@AI 流式中的 comment id（null = 没在流）
  streamingCommentId: null,
  // v6 Block 3：最近一次 @AI 失败的错误 { commentId, text }，渲染在该卡片里，下次操作清掉
  streamError: null,
  // v6 Block 3：划线浮出 comment 框当前锚定的 comment id
  composeCommentId: null,
};
// 开发期方便 console 调试
window.__coread = state;
// v6 comment 模型调试入口（test / console 用；app.js 是 module，函数不在全局）
window.__coreadGetComments = () => getComments();
window.__coreadExportCurrent = (group) => generateCurrentPdfMarkdown(group);
window.__coreadExportTopic = (id, group) => generateTopicMarkdownFiles(id || state.currentTopicId, group);
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
function resetThreads() {
  state.threads = { main: makeMainThread() };
}

// ── comment 视图模型（v6 重构）──────────────────────────────
// comment = 一段划线高亮(annotation) + 围绕它的讨论(thread.messages) 的「逻辑视图」。
// 不是新存储：annotation 存 annotations store、messages 存 threads store，
// getComments() 只在内存里把两者 join 起来 —— thread.id === annotation.id 是这把钥匙。
// 「对话/thread」概念对用户退休，thread 退化成 comment 的 messages 容器。
//
// 特殊：main —— 不绑高亮的「全文 comment」，承载 primeSummary + 散点提问，永远置顶、不可删。
//
// comment 形状：{ id, isMain, annotation|null, thread, messages }
//   - 含 0 消息的纯标记高亮（划线选色后没填走掉）也是一条 comment
//   - 每次 render / 导出现算，不缓存（条目 < 100，cheap；避免 join 状态不一致）
function getComments() {
  const list = [];
  // 置顶：全文 comment（main thread）
  const main = state.threads.main || makeMainThread();
  list.push({ id: "main", isMain: true, annotation: null, thread: main, messages: main.messages });
  // 每条 annotation = 一条 comment，按创建时间升序（与 PDF 阅读时间线 / 导出顺序一致）
  const anns = [...state.annotations].sort(
    (a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0)
  );
  for (const ann of anns) {
    const thread = state.threads[ann.id] || ensureAnnotationThread(ann);
    list.push({ id: ann.id, isMain: false, annotation: ann, thread, messages: thread.messages });
  }
  return list;
}

// 单条消息是否「收入笔记」—— 缺字段（旧数据 / 兜底）默认视为收入
function isMsgIncluded(m) {
  return !!m && m.includedInNote !== false;
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
  home: $("home"),
  landing: $("landing"),
  topicPage: $("topicPage"),
  reader: $("reader"),
  // 首页（粘贴链接直接读）
  homeLoadForm: $("homeLoadForm"),
  homeUrlInput: $("homeUrlInput"),
  homeFileInput: $("homeFileInput"),
  homeRecent: $("homeRecent"),
  homeManageBtn: $("homeManageBtn"),
  // 主题列表（从首页"我的主题"进入）
  topicGrid: $("topicGrid"),
  newTopicBtn: $("newTopicBtn"),
  landingStatus: $("landingStatus"),
  topicListBack: $("topicListBack"),
  // v3-β topic page
  topicBack: $("topicBack"),
  tpName: $("tpName"),
  tpPaletteRow: $("tpPaletteRow"),
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
  // v3-β topic card "..." menu
  topicCardMenu: $("topicCardMenu"),
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
  // v6 comment 列表（右栏）
  cmtSummary: $("cmtSummary"),
  commentList: $("commentList"),
  readerExportBtn: $("readerExportBtn"),
  // 引用 / Cite
  readerCiteBtn: $("readerCiteBtn"),
  citeModal: $("citeModal"),
  citeClose: $("citeClose"),
  citeStatus: $("citeStatus"),
  citeTitleInput: $("citeTitleInput"),
  citeAuthorsInput: $("citeAuthorsInput"),
  citeYearInput: $("citeYearInput"),
  citeVenueInput: $("citeVenueInput"),
  citeDoiInput: $("citeDoiInput"),
  citeFormatSel: $("citeFormatSel"),
  citeOutput: $("citeOutput"),
  citeCopyBtn: $("citeCopyBtn"),
  // 导出页
  exportPage: $("exportPage"),
  exportBack: $("exportBack"),
  exportDownloadBtn: $("exportDownloadBtn"),
  exportPreview: $("exportPreview"),
  // v2-a 划线高亮
  colorPalette: $("colorPalette"),
  // v6 划线浮出 comment 框
  cmtCompose: $("cmtCompose"),
  cmtComposeInput: $("cmtComposeInput"),
  cmtComposeSend: $("cmtComposeSend"),
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
  // 语言切换控件（首页 + 阅读器）
  langSwitchHome: $("langSwitchHome"),
};

// ────────────────────── i18n：静态 HTML 文案应用 ──────────────────────
// 把 index.html 里写死的中文 UI 文案按当前语言重写一遍。
// 切换语言时也调用 —— 纯文本/属性替换，不动 DOM 结构、不碰已加载论文 / 标注。
function applyStaticI18n() {
  document.documentElement.setAttribute("lang", t("htmlLang"));
  document.title = t("docTitle");
  const setText = (sel, val) => { const e = document.querySelector(sel); if (e) e.textContent = val; };
  const setAttr = (sel, attr, val) => { const e = document.querySelector(sel); if (e) e.setAttribute(attr, val); };
  // 首页
  setText(".tagline", t("tagline"));
  setAttr("#homeUrlInput", "placeholder", t("homeUrlPlaceholder"));
  setAttr("#homeLoadForm button", "aria-label", t("homeSubmitAria"));
  const homeHint = document.querySelector("#home .hint");
  if (homeHint) {
    homeHint.firstChild && (homeHint.firstChild.textContent = t("homeHintPrefix"));
    const fl = homeHint.querySelector(".file-link");
    if (fl) fl.firstChild && (fl.firstChild.textContent = t("fileLinkLabel"));
  }
  setText("#homeManageBtn", t("homeManage"));
  // 主题列表
  setText("#topicListBack", t("topicListBack"));
  setText(".topics-header h1", t("topicsTitle"));
  setText(".topics-header .tagline", t("topicsTagline"));
  setText("#newTopicBtn", t("newTopicBtn"));
  // 主题页
  setAttr("#topicBack", "aria-label", t("topicBackAria"));
  setAttr("#topicBack", "title", t("topicBackAria"));
  setAttr("#tpPaletteRow", "title", t("tpPaletteTitle"));
  setAttr("#tpUrlInput", "placeholder", t("tpUrlPlaceholder"));
  setAttr("#tpLoadForm button", "aria-label", t("tpSubmitAria"));
  const tpHint = document.querySelector("#topicPage .hint");
  if (tpHint) {
    tpHint.firstChild && (tpHint.firstChild.textContent = t("homeHintPrefix"));
    const fl = tpHint.querySelector(".file-link");
    if (fl) fl.firstChild && (fl.firstChild.textContent = t("fileLinkLabel"));
  }
  setText("#tpExportBtn", t("tpExportBtn"));
  // 新建主题 modal
  setText("#ntmTitle", t("ntmTitle"));
  setAttr("#ntmClose", "aria-label", t("ntmCancelAria"));
  setText("#ntmStep1 .ntm-label", t("ntmNameLabel"));
  setAttr("#ntmNameInput", "placeholder", t("ntmNamePlaceholder"));
  setText("#ntmStep1 .ntm-hint", t("ntmHintExample"));
  setText("#ntmStep2 .ntm-hint-warn", t("ntmHintWarn"));
  setText("#ntmAddRow", t("ntmAddRow"));
  setText("#ntmStep3 .ntm-confirm-text", t("ntmConfirmText"));
  setText("#ntmStep3 .ntm-warn", t("ntmWarn"));
  setText("#ntmPrev", t("ntmPrev"));
  setText("#ntmNext", t("ntmNext"));
  setText("#ntmConfirm", t("ntmConfirm"));
  // 主题卡片菜单
  setText('#topicCardMenu [data-action="rename"]', t("cardRename"));
  setText('#topicCardMenu [data-action="delete"]', t("cardDelete"));
  // 阅读器 toolbar
  setAttr("#backHome", "aria-label", t("backReaderAria"));
  setAttr("#backHome", "title", t("backReaderAria"));
  setAttr(".zoom-bar", "aria-label", t("zoomAria"));
  setAttr("#zoomOut", "aria-label", t("zoomOut"));
  setAttr("#zoomOut", "title", t("zoomOut"));
  setAttr("#zoomIn", "aria-label", t("zoomIn"));
  setAttr("#zoomIn", "title", t("zoomIn"));
  setAttr("#zoomLevel", "title", t("zoomPreset"));
  setAttr("#zoomMenu", "aria-label", t("zoomPreset"));
  setText('#zoomMenu [data-scale="page-width"]', t("zoomFitWidth"));
  setText('#zoomMenu [data-scale="page-fit"]', t("zoomFitPage"));
  setAttr("#findInput", "placeholder", t("findPlaceholder"));
  setAttr("#findPrev", "aria-label", t("findPrevAria"));
  setAttr("#findPrev", "title", t("findPrevTitle"));
  setAttr("#findNext", "aria-label", t("findNextAria"));
  setAttr("#findNext", "title", t("findNextTitle"));
  setAttr("#findClose", "aria-label", t("findCloseAria"));
  setAttr("#findClose", "title", t("findCloseTitle"));
  setAttr("#findDropdown", "aria-label", t("findDropdownAria"));
  setAttr("#thumbnailSidebar", "aria-label", t("thumbSidebarAria"));
  setAttr("#colorPalette", "aria-label", t("colorPaletteAria"));
  setAttr("#cmtComposeInput", "placeholder", t("cmtComposePlaceholder"));
  // cmtComposeSend 文案在流式态会被改，非流式时同步
  if (!state.streaming) setText("#cmtComposeSend", t("cmtComposeSend"));
  setAttr("#commentList", "aria-label", t("commentListAria"));
  setText("#readerExportBtn", t("readerExportBtn"));
  setAttr("#readerExportBtn", "title", t("readerExportTitle"));
  // 引用 / Cite
  setText("#readerCiteBtn", t("citeBtn"));
  setAttr("#readerCiteBtn", "title", t("citeBtnTitle"));
  setText("#citeTitle", t("citeTitle"));
  setAttr("#citeClose", "aria-label", t("citeCloseAria"));
  setText("#citeMetaHead", t("citeMetaHead"));
  setText("#citeLblTitle", t("citeFieldTitle"));
  setText("#citeLblAuthors", t("citeFieldAuthors"));
  setText("#citeLblYear", t("citeFieldYear"));
  setText("#citeLblVenue", t("citeFieldVenue"));
  setText("#citeLblDoi", t("citeFieldDoi"));
  setAttr("#citeAuthorsInput", "placeholder", t("citeAuthorsPlaceholder"));
  setText("#citeFormatHead", t("citeFormatHead"));
  setText("#citeOutputHead", t("citeOutputHead"));
  if (!_citeCopiedFlash) setText("#citeCopyBtn", t("citeCopyBtn"));
  // 导出页
  setAttr("#exportBack", "aria-label", t("exportBackAria"));
  setAttr("#exportBack", "title", t("exportBackAria"));
  setText(".export-title", t("exportTitle"));
  setText("#exportDownloadBtn", t("exportDownload"));
  const sLabels = document.querySelectorAll(".export-setting-label");
  if (sLabels[0]) sLabels[0].textContent = t("exportScopeLabel");
  if (sLabels[1]) sLabels[1].textContent = t("exportGroupLabel");
  setText('.export-radio input[value="current"] + span', t("exportScopeCurrent"));
  setText('.export-radio input[value="topic"] + span', t("exportScopeTopic"));
  setText('.export-radio input[value="tag"] + span', t("exportGroupTag"));
  setText('.export-radio input[value="reading"] + span', t("exportGroupReading"));
  setText(".export-preview-hint", t("exportPreviewHint"));
  // 语言切换控件本身
  setAttr("#langSwitchHome", "aria-label", t("langSwitchAria"));
  refreshLangSwitchUI();
}

// 语言切换控件视觉：高亮当前语言
function refreshLangSwitchUI() {
  for (const sw of [els.langSwitchHome]) {
    if (!sw) continue;
    sw.querySelectorAll("button[data-lang]").forEach((b) => {
      b.classList.toggle("active", b.dataset.lang === LANG);
      b.setAttribute("aria-pressed", b.dataset.lang === LANG ? "true" : "false");
    });
  }
}

// 切换语言：写 localStorage → 重渲所有动态 UI（不破坏 reader / 已加载论文 / 标注）
function switchLang(lang) {
  const v = lang === "en" ? "en" : "zh";
  if (v === LANG) return;
  LANG = v;
  setLang(v);
  track("lang_switch", { lang: v });
  applyStaticI18n();
  // 动态视图重渲：每个 render 函数内部都读 t()，重调即可
  try { renderHomeRecent(); } catch (_) {}
  try { renderTopicGrid(); } catch (_) {}
  try { if (state.topics[state.currentTopicId]) renderTopicPage(state.topics[state.currentTopicId]); } catch (_) {}
  try { renderCommentList(); } catch (_) {}
  try { updateCommentSummary(); } catch (_) {}
  try { renderColorPalette(); } catch (_) {}
  try { if (state.view === "exportPage") refreshExportPreview(); } catch (_) {}
}

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

// arxiv 同一篇论文有 /abs/、/html/、/pdf/ 三种形态加可选版本号，全部归一到 arxiv:{id}。
// 非 arxiv URL 保持原 url:{full} 形态。改动这个就 invalidate 所有按 pdfKey 索引的东西
// （annotations / threads / topics.pdfKeys / EXAMPLE_PDF_KEY）—— 这是为什么 EXAMPLE_PDF_KEY
// 仍然手写常量、不走 derivePdfKey。
function derivePdfKey(url) {
  const m = url.match(/arxiv\.org\/(?:abs|html|pdf)\/(\d{4}\.\d{4,6})(?:v\d+)?/i);
  if (m) return `arxiv:${m[1]}`;
  return `url:${url}`;
}

async function loadPdf({ url, file, topicId }) {
  resetReaderState();
  showLoadingMask(t("loadingFetchPdf"));
  // v3-α: 确保启动期 bootstrap（默认主题 + annotation migration）已跑完
  // 防御：bootstrap promise 已在模块顶层 fire；这里 await 让首次 loadPdf 不抢跑
  // 失败的 bootstrap 已被 catch 吞掉，不会卡住此处
  await _bootstrapPromise;
  // 双保险：若 state.topics 还没填上（极端情况：bootstrap 失败、IDB 全坏），落回内存默认值
  if (!state.topics[DEFAULT_TOPIC_ID]) {
    state.topics[DEFAULT_TOPIC_ID] = {
      id: DEFAULT_TOPIC_ID,
      name: "示例主题",
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
      pdfKey = derivePdfKey(url);
    }
    state.pdf = await pdfjsLib.getDocument(docSrc).promise;
    state.totalPages = state.pdf.numPages;
    state.pdfTitle = title;
    state.pdfKey = pdfKey;

    // 埋点：只发页数 + 来源类型，不发 URL / 文件名 / 任何内容
    track("pdf_loaded", {
      pages: state.totalPages,
      source: file ? "file" : (/arxiv\.org/i.test(url || "") ? "arxiv" : "url"),
    });

    // v3-β: 把当前 PDF 关联到 targetTopic（pdfKeys 去重 push + 更新 lastOpened 时间）
    // 同一 pdfKey 在多个主题间可共享引用（PM 拍板：annotations 按 topicId 区分）
    // 异步写 IDB，不阻塞渲染；失败已在 saveTopic 内部 catch
    addPdfToTopic(state.currentTopicId, pdfKey, title).catch((e) =>
      console.warn("[addPdfToTopic]", e)
    );

    showLoadingMask(t("loadingParse", state.totalPages, 0));
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
    // fire-and-forget：渲染失败不阻塞主流程（用户还能正常读 PDF，只是 sidebar 不可用）
    renderThumbnails(state.pdf).catch((e) => console.warn("[renderThumbnails]", e));

    // v2-a：异步加载已保存的 annotation。pagerendered 时会按需 render
    // 用 .catch 不阻塞主流程（IndexedDB 不可用时已在内部降级到内存）
    // hydratePromise: 让下面的 maybePrimeSummary 等 hydrate 完了再判断"是否已总结过"，
    // 否则同一篇论文每次打开都会重新发一次 LLM 请求（main thread 还没 hydrate → 检测失败）
    const hydratePromise = loadAnnotations(pdfKey).then(async (list) => {
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
        // v6：messages 灌回内存后重渲右栏 comment 列表
        renderCommentList();
      } catch (e) {
        console.warn("[loadThreadsByPdfKey]", e);
      }
      // 当前已渲染的 page 立即补画一次（textlayerrendered 已经触发过的页）
      renderAllHighlights();
      renderCommentList();
    }).catch((e) => console.warn("[loadAnnotations]", e));

    await extractAllText((i, n) => {
      showLoadingMask(t("loadingParse", n, i));
    });
    hideLoadingMask();
    // v6：自动核心总结进「全文 comment」(main)
    // 必须等 hydratePromise —— 否则 main thread 历史 messages 还没灌进来，
    // maybePrimeSummary 的"已总结过"检测会失败 → 每次重开都重发 LLM 请求浪费 token
    await hydratePromise.catch(() => {});
    maybePrimeSummary();
  } catch (e) {
    console.error("[loadPdf]", e);
    hideLoadingMask();
    const msg = t("loadFailed", e.message || e);
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
  els.loadingText.textContent = text || t("loadingDefault");
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

// ══════════════════════ 引用 / Cite ══════════════════════
// 阅读器右栏「引用」按钮 → 打开 cite modal：可编辑元数据 + 三格式实时生成 + 一键复制。
// 元数据来源：① metadata store 缓存（pdfKey → paper 记录）② Semantic Scholar API 抓取
// ③ 用户手填。抓取失败优雅降级（字段留空）。所有改动按 pdfKey 持久化进 metadata store。
const CITE_META_PREFIX = "paper:";              // metadata store key 前缀
let _citeCurrentFmt = "apa";
let _citeMeta = null;                            // { title, authors:[], year, venue, doi, arxivId }
let _citeFetchedKey = null;                      // 已抓过的 pdfKey（防重复抓）
let _citeCopiedFlash = false;                    // 复制按钮「已复制」闪烁态

// 从 pdfKey 提取 arXiv ID（url:https://arxiv.org/abs/2412.13678 → 2412.13678）
function citeArxivIdFromKey(pdfKey) {
  if (!pdfKey || !pdfKey.startsWith("url:")) return "";
  const m = pdfKey.slice(4).match(/arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]{4,5})(?:v\d+)?/i);
  return m ? m[1] : "";
}

// 扫已抽取的 PDF 全文找 DOI
function citeDoiFromText(text) {
  if (!text) return "";
  const m = text.match(/10\.\d{4,}\/[^\s"<>]+/);
  // 去掉尾部标点（DOI 后常跟句号/括号）
  return m ? m[0].replace(/[.,;)\]]+$/, "") : "";
}

// HTML entity 解码（Crossref / S2 偶尔在 venue / title 里塞 `&amp;` / `&quot;`）
function citeDecodeEntities(s) {
  if (!s || typeof s !== "string") return s;
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// 通用 JSON fetch + 超时；失败返回 null（不抛错）
async function citeFetchJSON(url, timeoutMs = 8000) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const resp = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) return null;
    return await resp.json();
  } catch (_) {
    return null; // 网络断 / CORS / 超时 / 限流 → 优雅降级
  }
}

// Semantic Scholar 返回 → 统一 meta 对象
function citeNormalizeS2(data) {
  if (!data) return null;
  const ext = data.externalIds || {};
  return {
    title: citeDecodeEntities(data.title || ""),
    authors: (data.authors || []).map((a) => a.name).filter(Boolean),
    year: data.year ? String(data.year) : "",
    venue: citeDecodeEntities(data.venue || ""),
    doi: ext.DOI || "",
    arxivId: ext.ArXiv || "",
  };
}

// Crossref 返回 → 统一 meta 对象（DOI 注册局，对主流出版商几乎 100% 命中）
function citeNormalizeCrossref(payload, doi) {
  const m = payload && payload.message;
  if (!m) return null;
  // 作者：优先 given+family（出版商 deposit 的原文），机构作者退回 name/literal
  const authors = (m.author || [])
    .map((a) => {
      if (a.family || a.given) return [a.given, a.family].filter(Boolean).join(" ");
      return a.name || a.literal || "";
    })
    .filter(Boolean);
  // 年份：issued > published-print > published-online > created
  const issued = m.issued || m["published-print"] || m["published-online"] || m.created;
  const year = issued && issued["date-parts"] && issued["date-parts"][0]
    ? String(issued["date-parts"][0][0] || "") : "";
  return {
    title: citeDecodeEntities((m.title || [])[0] || ""),
    authors,
    year,
    venue: citeDecodeEntities((m["container-title"] || [])[0] || ""),
    doi: m.DOI || doi || "",
    arxivId: "",
  };
}

// 抓取元数据：
//   arXiv 论文 → Semantic Scholar（对 arXiv 覆盖好）
//   DOI 论文   → Crossref 主源（出版商原数据） + S2 兜底
// 失败返回 null（modal 会保持字段为空，让用户手填）。
async function citeFetchMeta(arxivId, doi) {
  if (arxivId) {
    const fields = "fields=title,authors,year,venue,externalIds";
    return citeNormalizeS2(await citeFetchJSON(
      `https://api.semanticscholar.org/graph/v1/paper/arXiv:${encodeURIComponent(arxivId)}?${fields}`
    ));
  }
  if (!doi) return null;
  // Crossref 命中即返回，省下打 S2 的限流配额；只在主源失败时才兜底
  const cr = citeNormalizeCrossref(
    await citeFetchJSON(`https://api.crossref.org/works/${encodeURIComponent(doi)}`),
    doi,
  );
  if (cr && cr.title) return cr;
  const fields = "fields=title,authors,year,venue,externalIds";
  return citeNormalizeS2(await citeFetchJSON(
    `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}?${fields}`
  ));
}

// 持久化：按 pdfKey 存进 metadata store（key = "paper:<pdfKey>"）
function citePersist(pdfKey, meta) {
  if (!pdfKey || !meta) return;
  writeMeta(CITE_META_PREFIX + pdfKey, meta).catch((e) => console.warn("[citePersist]", e));
}

// ── 格式化函数（纯函数：meta → string）──
// meta = { title, authors:[string], year, venue, doi, arxivId }

// 把作者名拆成 { last, given }（given 是名，可能多段）
function citeSplitName(full) {
  const s = (full || "").trim();
  if (!s) return null;
  if (s.includes(",")) {
    // "Lastname, First M." 形式
    const [last, rest] = s.split(",");
    return { last: last.trim(), given: (rest || "").trim() };
  }
  const parts = s.split(/\s+/);
  if (parts.length === 1) return { last: parts[0], given: "" };
  return { last: parts[parts.length - 1], given: parts.slice(0, -1).join(" ") };
}

// 名 → 首字母缩写："John Michael" → "J. M."
function citeInitials(given) {
  return (given || "")
    .split(/[\s.]+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + ".")
    .join(" ");
}

// APA 7th
function citeFormatAPA(meta) {
  const names = (meta.authors || []).map(citeSplitName).filter(Boolean);
  let authorStr = "";
  if (names.length) {
    const fmt = (n) => {
      const ini = citeInitials(n.given);
      return ini ? `${n.last}, ${ini}` : n.last;
    };
    if (names.length === 1) authorStr = fmt(names[0]);
    else if (names.length <= 20) {
      authorStr = names.slice(0, -1).map(fmt).join(", ") + ", & " + fmt(names[names.length - 1]);
    } else {
      authorStr = names.slice(0, 19).map(fmt).join(", ") + ", ... " + fmt(names[names.length - 1]);
    }
  }
  const year = meta.year ? `(${meta.year}).` : "(n.d.).";
  const title = meta.title ? `${meta.title}.` : "";
  let tail;
  if (meta.arxivId) {
    tail = `arXiv. https://arxiv.org/abs/${meta.arxivId}`;
  } else if (meta.venue) {
    tail = `${meta.venue}.`;
    if (meta.doi) tail += ` https://doi.org/${meta.doi}`;
  } else if (meta.doi) {
    tail = `https://doi.org/${meta.doi}`;
  } else {
    tail = "";
  }
  // 作者块末尾若已是缩写点（"D."）则不再叠加句点，避免 "D.."
  const authorBlock = authorStr ? (/\.$/.test(authorStr) ? authorStr : authorStr + ".") : "";
  return [authorBlock, year, title, tail].filter(Boolean).join(" ").trim();
}

// GB/T 7714-2015（期刊论文 [J]；超 3 位作者用「等 / et al.」）
function citeFormatGBT(meta) {
  const names = (meta.authors || []).map(citeSplitName).filter(Boolean);
  // GB/T：姓在前名在后，姓全大写不强制；这里用「姓 名首字母」近似（兼容中英文名）
  const fmtName = (raw, n) => {
    // 中文名（无空格、非 ASCII）直接用原文
    if (/[^\x00-\x7f]/.test(raw) && !raw.includes(" ")) return raw;
    const ini = citeInitials(n.given);
    return ini ? `${n.last} ${ini.replace(/\./g, "")}` : n.last;
  };
  const rawAuthors = meta.authors || [];
  let authorStr = "";
  if (rawAuthors.length) {
    const elided = rawAuthors.length > 3 ? rawAuthors.slice(0, 3) : rawAuthors;
    authorStr = elided
      .map((raw, i) => fmtName(raw, names[i]))
      .join(", ");
    if (rawAuthors.length > 3) {
      authorStr += /[^\x00-\x7f]/.test(rawAuthors[0]) ? ", 等" : ", et al";
    }
  }
  const parts = [];
  if (authorStr) parts.push(authorStr + ".");
  if (meta.title) parts.push(`${meta.title}[J].`);
  let venueYear = "";
  if (meta.venue && meta.year) venueYear = `${meta.venue}, ${meta.year}.`;
  else if (meta.venue) venueYear = `${meta.venue}.`;
  else if (meta.year) venueYear = `${meta.year}.`;
  if (venueYear) parts.push(venueYear);
  if (meta.arxivId) parts.push(`arXiv:${meta.arxivId}.`);
  else if (meta.doi) parts.push(`DOI: ${meta.doi}.`);
  return parts.join(" ").trim();
}

// 生成 BibTeX cite key：firstauthorlast + year + 标题首词
function citeBibKey(meta) {
  const names = (meta.authors || []).map(citeSplitName).filter(Boolean);
  let first = names.length ? names[0].last : "anon";
  first = first.toLowerCase().replace(/[^a-z0-9]/g, "") || "anon";
  const year = meta.year || "nd";
  const word = (meta.title || "")
    .split(/\s+/)
    .map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter((w) => w && w.length > 3)[0] || "";
  return first + year + word;
}

// BibTeX（arXiv 用 @misc + eprint/archivePrefix；否则 @article）
function citeFormatBibTeX(meta) {
  const key = citeBibKey(meta);
  const authorField = (meta.authors || []).join(" and ");
  const lines = [];
  const F = (k, v) => { if (v) lines.push(`  ${k} = {${v}}`); };
  if (meta.arxivId) {
    F("title", meta.title);
    F("author", authorField);
    F("year", meta.year);
    F("eprint", meta.arxivId);
    lines.push(`  archivePrefix = {arXiv}`);
    if (meta.venue) F("note", meta.venue);
    return `@misc{${key},\n${lines.join(",\n")}\n}`;
  }
  F("title", meta.title);
  F("author", authorField);
  F("year", meta.year);
  F("journal", meta.venue);
  F("doi", meta.doi);
  return `@article{${key},\n${lines.join(",\n")}\n}`;
}

function citeFormat(meta, fmt) {
  if (!meta) return "";
  if (fmt === "gbt") return citeFormatGBT(meta);
  if (fmt === "bibtex") return citeFormatBibTeX(meta);
  return citeFormatAPA(meta);
}

// 从输入框收集当前 meta（authors 用 ; 或 , 拆分）
function citeReadInputs() {
  const authorsRaw = els.citeAuthorsInput.value.trim();
  return {
    title: els.citeTitleInput.value.trim(),
    authors: authorsRaw ? authorsRaw.split(/\s*[;,]\s*/).filter(Boolean) : [],
    year: els.citeYearInput.value.trim(),
    venue: els.citeVenueInput.value.trim(),
    doi: els.citeDoiInput.value.trim(),
    arxivId: (_citeMeta && _citeMeta.arxivId) || "",
  };
}

// 把 meta 灌进输入框
function citeFillInputs(meta) {
  els.citeTitleInput.value = meta.title || "";
  els.citeAuthorsInput.value = (meta.authors || []).join("; ");
  els.citeYearInput.value = meta.year || "";
  els.citeVenueInput.value = meta.venue || "";
  // DOI 框：arXiv 论文优先显示 arXiv ID
  els.citeDoiInput.value = meta.arxivId ? `arXiv:${meta.arxivId}` : (meta.doi || "");
}

// 重新渲染引用文本输出
function citeRenderOutput() {
  const meta = citeReadInputs();
  const out = citeFormat(meta, _citeCurrentFmt);
  els.citeOutput.textContent = out || t("citeEmptyHint");
}

function citeSetStatus(msg) {
  if (!msg) { els.citeStatus.hidden = true; return; }
  els.citeStatus.hidden = false;
  els.citeStatus.textContent = msg;
}

// 打开 cite modal：加载缓存 / 首次抓取
async function openCiteModal() {
  if (!state.pdfKey) return;
  const pdfKey = state.pdfKey;
  els.citeModal.hidden = false;
  citeSetStatus("");
  track("cite_open", {});

  // 1. 先读 metadata store 缓存
  let cached = null;
  try { cached = await readMeta(CITE_META_PREFIX + pdfKey); } catch (_) {}
  if (cached) {
    _citeMeta = cached;
    citeFillInputs(cached);
    citeRenderOutput();
    return;
  }

  // 2. 无缓存：用标题兜底先填一个，再尝试抓取
  const arxivId = citeArxivIdFromKey(pdfKey);
  const doi = arxivId ? "" : citeDoiFromText(state.pdfText);
  _citeMeta = {
    title: state.pdfTitle && !/\.pdf$/i.test(state.pdfTitle) ? state.pdfTitle : "",
    authors: [], year: "", venue: "", doi: doi, arxivId: arxivId,
  };
  citeFillInputs(_citeMeta);
  citeRenderOutput();

  // 3. 抓取（只抓一次）
  if (_citeFetchedKey === pdfKey) return;
  if (!arxivId && !doi) {
    citeSetStatus(t("citeFetchFailed"));
    return;
  }
  citeSetStatus(t("citeFetching"));
  const fetched = await citeFetchMeta(arxivId, doi);
  // 抓取期间用户可能已关 modal / 切论文 —— 校验后再写
  if (state.pdfKey !== pdfKey) return;
  _citeFetchedKey = pdfKey;
  if (fetched) {
    // 抓到的字段优先；保留本地已识别的 arxivId/doi
    _citeMeta = {
      title: fetched.title || _citeMeta.title,
      authors: fetched.authors && fetched.authors.length ? fetched.authors : _citeMeta.authors,
      year: fetched.year || _citeMeta.year,
      venue: fetched.venue || _citeMeta.venue,
      doi: fetched.doi || _citeMeta.doi,
      arxivId: fetched.arxivId || _citeMeta.arxivId,
    };
    citeFillInputs(_citeMeta);
    citeRenderOutput();
    citeSetStatus("");
    citePersist(pdfKey, _citeMeta);
  } else {
    citeSetStatus(t("citeFetchFailed"));
  }
}

function closeCiteModal() {
  els.citeModal.hidden = true;
}

// 用户编辑输入框 → 实时更新输出 + 持久化
function citeOnInput() {
  // DOI 框可能填 "arXiv:xxxx"，解析回 arxivId
  const doiVal = els.citeDoiInput.value.trim();
  const am = doiVal.match(/arxiv:\s*([0-9]{4}\.[0-9]{4,5})/i);
  if (am) {
    _citeMeta = { ..._citeMeta, arxivId: am[1], doi: "" };
  } else {
    _citeMeta = { ..._citeMeta, arxivId: "", doi: doiVal };
  }
  citeRenderOutput();
  if (state.pdfKey) citePersist(state.pdfKey, citeReadInputs());
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
// 需求：输入关键词、还没回车，就在 findBar 下方浮出匹配预览。
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
    tip.textContent = t("findParsing");
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
    head.textContent = t("findNoMatch");
    dd.appendChild(head);
    dd.hidden = false;
    return;
  }
  head.textContent = truncated
    ? t("findCountCapped", results.length, FIND_DD_MAX)
    : t("findCount", results.length);
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

// pdf.js find / scrollPageIntoView 跳到匹配时只对齐垂直、会顺手重置水平 scrollLeft。
// 需求：搜索跳转时左右滚动条不动。find 的滚动是异步的（搜索算完才滚），
// 单次 rAF 赶不上 → 连续钉若干帧把 scrollLeft 锁回原值（~330ms 覆盖异步滚动）。
function withPreservedScrollLeft(trigger) {
  const prev = els.viewerContainer.scrollLeft;
  trigger();
  let frame = 0;
  const pin = () => {
    els.viewerContainer.scrollLeft = prev;
    if (++frame < 20) requestAnimationFrame(pin);
  };
  requestAnimationFrame(pin);
}

// 点 dropdown 结果 → 跳页（跳转 + 页内高亮全程锁定水平 scrollLeft）
function jumpToFindResult(pageNum) {
  if (!pageNum || !state.pdf) return;
  if (pageNum < 1 || pageNum > state.totalPages) {
    console.debug("[find-result] page out of range:", pageNum);
    return;
  }
  hideFindDropdown();
  withPreservedScrollLeft(() => {
    try {
      pdfViewer.scrollPageIntoView({ pageNumber: pageNum });
    } catch (err) {
      console.debug("[find-result] scrollPageIntoView failed:", err);
      return;
    }
    // 让 pdf.js 在该页高亮这个词（沿用现有 findController 流程）
    dispatchFind("");
  });
  // 点结果项 = 用户主动确认这个查询 → 之后按 Enter 走"找下一个"
  _findDispatchedQuery = els.findInput.value.trim();
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
// 标签色 hex 回退表（palette 里查不到 tag 时用；与 DEFAULT_PALETTE 的 color 对齐）
const PALETTE_HEX = {
  red: "#ff5e5e", green: "#54d062", blue: "#4a9eff",
  purple: "#b06dff", yellow: "#f5d042", gray: "#b8b8b8",
};

// ────────────────────── v3-α 主题数据层 ──────────────────────
// 默认主题色板：6 个内置 tag。按产品决策（G3 + G4）：emoji 固定 6 个、保持现 6 色不调整。
// 字段（task 简化）：{ id, emoji, label, color }
//   - id 是内部锚（不展示给用户），用于 annotation.color 旧索引兼容（'red'/'green'/...）
//   - 给 LLM 的 system 注入只 emit emoji + label，不 emit id（system_prompt.md 已更新格式）
//   - 用户后续在主题编辑器里可改 label/color/增删行（不在 v3-α 范围内，UI 不动）
const DEFAULT_PALETTE = [
  { id: "red",    emoji: "🔴", label: "没懂",   color: "#ff5e5e", aiHint: "把这段彻底讲透，用最简单的话拆解，确认他懂了再停" },
  { id: "yellow", emoji: "🟡", label: "重点",   color: "#f5d042", aiHint: "帮他把这段压缩成能直接进笔记的精炼表述" },
  { id: "blue",   emoji: "🔵", label: "可借鉴", color: "#4a9eff", aiHint: "帮他想清楚这个方法/思路怎么迁移到他自己的研究" },
  { id: "purple", emoji: "🟣", label: "存疑",   color: "#b06dff", aiHint: "顺着他的疑问深挖，给支持或反驳的依据，不和稀泥" },
  { id: "green",  emoji: "🟢", label: "要引用", color: "#54d062" },
  { id: "gray",   emoji: "⚪", label: "待查",   color: "#b8b8b8", aiHint: "帮他判断这个说法可不可信、该怎么核实" },
];
const DEFAULT_TOPIC_ID = "default";

// 默认/示例色板的 6 个内置标签：双语 label。
// 仅用于「默认主题」+「示例主题」—— 用户自建主题的自定义标签不在此表，保持原文。
// 切语言时按 tag.id 查表翻译 label（zh ↔ en 互认，避免把用户编辑过的标签误翻）。
const DEFAULT_TAG_LABELS = {
  red:    { zh: "没懂",   en: "Confused" },
  yellow: { zh: "重点",   en: "Key point" },
  blue:   { zh: "可借鉴", en: "Reusable" },
  purple: { zh: "存疑",   en: "Doubtful" },
  green:  { zh: "要引用", en: "To cite" },
  gray:   { zh: "待查",   en: "To verify" },
};
const DEFAULT_TAG_AIHINTS = {
  red: {
    zh: "把这段彻底讲透，用最简单的话拆解，确认他懂了再停",
    en: "Explain this passage thoroughly in the simplest terms; don't stop until they get it",
  },
  yellow: {
    zh: "帮他把这段压缩成能直接进笔记的精炼表述",
    en: "Help compress this passage into a concise statement ready for notes",
  },
  blue: {
    zh: "帮他想清楚这个方法/思路怎么迁移到他自己的研究",
    en: "Help them figure out how to transfer this method/idea to their own research",
  },
  purple: {
    zh: "顺着他的疑问深挖，给支持或反驳的依据，不和稀泥",
    en: "Dig into their doubt, give supporting or refuting evidence, don't sit on the fence",
  },
  gray: {
    zh: "帮他判断这个说法可不可信、该怎么核实",
    en: "Help them judge whether the claim is credible and how to verify it",
  },
};
// 判断某 tag 是否仍是「内置默认标签」（label 没被用户改过 —— zh/en 任一版本都算）。
function isDefaultTag(tag) {
  const m = DEFAULT_TAG_LABELS[tag && tag.id];
  return !!m && (tag.label === m.zh || tag.label === m.en);
}
// 显示用 label：内置默认标签按当前语言翻译；用户自定义标签原样返回。
function displayTagLabel(tag) {
  if (!tag) return "";
  return isDefaultTag(tag) ? DEFAULT_TAG_LABELS[tag.id][LANG] : (tag.label || "");
}
// 默认主题名（app 自带内容）→ 按当前语言翻译；用户改过名则原样返回。
const DEFAULT_TOPIC_NAMES = ["默认主题", "Default topic", "示例主题", "Sample topic"];
function displayTopicName(topic) {
  if (!topic) return "";
  if (topic.id === DEFAULT_TOPIC_ID && DEFAULT_TOPIC_NAMES.includes(topic.name)) {
    return t("defaultTopicName");
  }
  return topic.name || "";
}
// 给 LLM 的 aiHint：内置默认标签按当前语言；用户自定义 aiHint 原样。
function displayTagAiHint(tag) {
  if (!tag) return "";
  if (isDefaultTag(tag) && DEFAULT_TAG_AIHINTS[tag.id]) {
    return DEFAULT_TAG_AIHINTS[tag.id][LANG];
  }
  return (tag.aiHint || "");
}

// 构建 palette 注入字符串（追加到 system message 末尾，给 LLM 看 tag 规则）
// 设计：每行一个 tag —— 有 aiHint 就 "标签：提示"，没有就只输出标签名。
//       按 palette 数组原顺序 —— 这是 caching 前缀稳定的关键（同 palette 永远相同字节序列，
//       不掺时间戳/随机）。改 palette = cache 失效（合理，按 V3_DESIGN C.3）。
// aiHint 是可选字段：自定义主题的 tag 没有它也正常工作。
function buildPaletteRules(palette) {
  if (!palette || palette.length === 0) return "";
  const lines = palette.map((p) => {
    const label = displayTagLabel(p) || p.label;
    const hint = (displayTagAiHint(p) || "").trim();
    return hint ? `- ${label}: ${hint}` : `- ${label}`;
  });
  const heading = LANG === "en"
    ? "## Tag rules\nThe user marks passages with colored tags. Adjust your response by tag:"
    : "## 标签规则\n用户用颜色标签标记论文里的段落，按标签调整你的回应：";
  return `${heading}\n${lines.join("\n")}`;
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
      name: "示例主题",
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

// ──────────────────────────────────────────
// 首页示例 paper：首次访问 seeding
// ──────────────────────────────────────────
// 新访客首页空空如也，看不到产品长什么样。这里预置一条「示例」——
// Anthropic Clio 论文（arXiv 2412.13678），带 3 条不同颜色的标注 + 已生成的
// primeSummary 摘要 + 一段人机讨论。访客点开 = 正常打开阅读器，后续功能（含 live @AI）全部正常。
//
// 设计要点：
//   - EXAMPLE_SEED 是「烤进去」的常量：topic + 3 annotations + 4 threads（含 main 的 primeSummary）。
//     thread 里已带 assistant 回复 → 访客点开不会再触发一次 AI 调用（省钱、省时）。
//   - 示例 topic 直接占据「默认主题」的位置（id = DEFAULT_TOPIC_ID）：首次访客 seed 示例后
//     IDB 里就有了默认主题，ensureDefaultTopic 复用它、不再另建空默认主题；用户想要自己的
//     主题自行新建。这样首次流程是「seed 示例 → 显示首页 → 无 modal」。
//   - localStorage 标志位 EXAMPLE_SEED_FLAG 控制幂等：注入过 / 用户已删 → 不再注入。
//   - 在 _bootstrapPromise 里、_isFirstRun 判定「之前」跑：seeding 后 IDB 里就有 topic 了，
//     首次访客不会再被弹「新建主题」modal，直接看到示例。
//   - createdAt 用固定值（非 Date.now()）→ 常量稳定，不破坏任何缓存前缀。
const EXAMPLE_SEED_FLAG = "coread_example_seeded";
// 示例 topic 的 id = DEFAULT_TOPIC_ID（"default"）—— 示例主题即默认主题。
// 示例 PDF 的 pdfKey（renderHomeRecent 凭这个识别示例条目：换标题 + 加「示例」小标签）。
const EXAMPLE_PDF_KEY = "url:https://arxiv.org/abs/2412.13678";
const EXAMPLE_RECENT_TITLE = "Clio 论文（点开看 co-read 怎么用）";
const EXAMPLE_SEED =
  {
    "pdfKey": "url:https://arxiv.org/abs/2412.13678",
    // 引用元数据：预烤进去，示例论文的「引用」面板秒开、不依赖网络
    "paperMeta": {
      "title": "Clio: Privacy-Preserving Insights into Real-World AI Use",
      "authors": [
        "Alex Tamkin", "Miles McCain", "Kunal Handa", "Esin Durmus",
        "Liane Lovitt", "Ankur Rathi", "Saffron Huang", "Alfred Mountfield",
        "Jerry Hong", "Stuart Ritchie", "Michael Stern", "Brian Clarke",
        "Landon Goldberg", "Theodore R. Sumers", "Jared Mueller",
        "William McEachen", "Wes Mitchell", "Shan Carter", "Jack Clark",
        "Jared Kaplan", "Deep Ganguli"
      ],
      "year": "2024",
      "venue": "arXiv preprint",
      "doi": "",
      "arxivId": "2412.13678"
    },
    "topic": {
      "id": "default",
      "name": "示例主题",
      "palette": [
        {
          "id": "red",
          "emoji": "🔴",
          "label": "没懂",
          "color": "#ff5e5e",
          "aiHint": "把这段彻底讲透，用最简单的话拆解，确认他懂了再停"
        },
        {
          "id": "yellow",
          "emoji": "🟡",
          "label": "重点",
          "color": "#f5d042",
          "aiHint": "帮他把这段压缩成能直接进笔记的精炼表述"
        },
        {
          "id": "blue",
          "emoji": "🔵",
          "label": "可借鉴",
          "color": "#4a9eff",
          "aiHint": "帮他想清楚这个方法/思路怎么迁移到他自己的研究"
        },
        {
          "id": "purple",
          "emoji": "🟣",
          "label": "存疑",
          "color": "#b06dff",
          "aiHint": "顺着他的疑问深挖，给支持或反驳的依据，不和稀泥"
        },
        {
          "id": "green",
          "emoji": "🟢",
          "label": "要引用",
          "color": "#54d062"
        },
        {
          "id": "gray",
          "emoji": "⚪",
          "label": "待查",
          "color": "#b8b8b8",
          "aiHint": "帮他判断这个说法可不可信、该怎么核实"
        }
      ],
      "pdfKeys": [
        "url:https://arxiv.org/abs/2412.13678"
      ],
      "createdAt": "2025-01-01T00:00:00.000Z"
    },
    "annotations": [
      {
        "id": "2430dfca-9d83-4076-974f-d39fbb7e689e",
        "color": "yellow",
        "text": "issues, we present Clio (Claude insights and observations), a privacy-preservingplatform that uses AI assistants themselves to analyze and surface aggregated usagepatterns across millions of conversations, without the need for human reviewers toread raw conversations. We validate this can be done with a high degree of accuracyand privacy by conducting extensive evaluations. We demonstrate Clio’s usefulness",
        "pages": [
          {
            "page": 1,
            "text": "issues, we present Clio (Claude insights and observations), a privacy-preservingplatform that uses AI assistants themselves to analyze and surface aggregated usagepatterns across millions of conversations, without the need for human reviewers toread raw conversations. We validate this can be done with a high degree of accuracyand privacy by conducting extensive evaluations. We demonstrate Clio’s usefulness",
            "rects": [
              {
                "leftPct": 0.2350933908045977,
                "topPct": 0.4566193812430633,
                "widthPct": 0.16895281035324622,
                "heightPct": 0.017758046614872364
              },
              {
                "leftPct": 0.3963945761494253,
                "topPct": 0.45939407602663707,
                "widthPct": 0.016908886788905352,
                "heightPct": 0.012572835738068812
              },
              {
                "leftPct": 0.3963945761494253,
                "topPct": 0.4566193812430633,
                "widthPct": 0.016908886788905352,
                "heightPct": 0.017758046614872364
              },
              {
                "leftPct": 0.4129961386494253,
                "topPct": 0.45939407602663707,
                "widthPct": 0.03181128666318696,
                "heightPct": 0.012572835738068812
              },
              {
                "leftPct": 0.4129961386494253,
                "topPct": 0.4566193812430633,
                "widthPct": 0.03181128666318696,
                "heightPct": 0.017758046614872364
              },
              {
                "leftPct": 0.44429103807471265,
                "topPct": 0.45939407602663707,
                "widthPct": 0.005421605603448276,
                "heightPct": 0.012572835738068812
              },
              {
                "leftPct": 0.44429103807471265,
                "topPct": 0.4566193812430633,
                "widthPct": 0.005421605603448276,
                "heightPct": 0.017758046614872364
              },
              {
                "leftPct": 0.44839933548850575,
                "topPct": 0.45939407602663707,
                "widthPct": 0.004175646551724138,
                "heightPct": 0.012572835738068812
              },
              {
                "leftPct": 0.44839933548850575,
                "topPct": 0.4566193812430633,
                "widthPct": 0.004175646551724138,
                "heightPct": 0.017758046614872364
              },
              {
                "leftPct": 0.45299030172413796,
                "topPct": 0.45939407602663707,
                "widthPct": 0.07865300671807651,
                "heightPct": 0.012572835738068812
              },
              {
                "leftPct": 0.45299030172413796,
                "topPct": 0.4566193812430633,
                "widthPct": 0.07865300671807651,
                "heightPct": 0.017758046614872364
              },
              {
                "leftPct": 0.5279947916666666,
                "topPct": 0.45939407602663707,
                "widthPct": 0.005421605603448276,
                "heightPct": 0.012572835738068812
              },
              {
                "leftPct": 0.5279947916666666,
                "topPct": 0.4566193812430633,
                "widthPct": 0.005421605603448276,
                "heightPct": 0.017758046614872364
              },
              {
                "leftPct": 0.5320918642241379,
                "topPct": 0.45939407602663707,
                "widthPct": 0.009541127873563218,
                "heightPct": 0.012572835738068812
              },
              {
                "leftPct": 0.5320918642241379,
                "topPct": 0.4566193812430633,
                "widthPct": 0.009541127873563218,
                "heightPct": 0.017758046614872364
              },
              {
                "leftPct": 0.5403982579022989,
                "topPct": 0.45939407602663707,
                "widthPct": 0.2370715086487518,
                "heightPct": 0.012572835738068812
              },
              {
                "leftPct": 0.5403982579022989,
                "topPct": 0.4566193812430633,
                "widthPct": 0.2370715086487518,
                "heightPct": 0.017758046614872364
              },
              {
                "leftPct": 0.2350933908045977,
                "topPct": 0.47319818257491675,
                "widthPct": 0.12212972531373474,
                "heightPct": 0.012572835738068812
              },
              {
                "leftPct": 0.2350933908045977,
                "topPct": 0.47042348779134296,
                "widthPct": 0.12212972531373474,
                "heightPct": 0.017758046614872364
              },
              {
                "leftPct": 0.3488909841954023,
                "topPct": 0.47319818257491675,
                "widthPct": 0.005421605603448276,
                "heightPct": 0.012572835738068812
              },
              {
                "leftPct": 0.3488909841954023,
                "topPct": 0.47042348779134296,
                "widthPct": 0.005421605603448276,
                "heightPct": 0.017758046614872364
              },
              {
                "leftPct": 0.35269621048850575,
                "topPct": 0.47319818257491675,
                "widthPct": 0.15891695570671696,
                "heightPct": 0.012572835738068812
              },
              {
                "leftPct": 0.35269621048850575,
                "topPct": 0.47042348779134296,
                "widthPct": 0.15891695570671696,
                "heightPct": 0.017758046614872364
              },
              {
                "leftPct": 0.5063981681034483,
                "topPct": 0.47319818257491675,
                "widthPct": 0.005421605603448276,
                "heightPct": 0.012572835738068812
              },
              {
                "leftPct": 0.5063981681034483,
                "topPct": 0.47042348779134296,
                "widthPct": 0.005421605603448276,
                "heightPct": 0.017758046614872364
              },
              {
                "leftPct": 0.5100911458333334,
                "topPct": 0.47319818257491675,
                "widthPct": 0.26711580123024425,
                "heightPct": 0.012572835738068812
              },
              {
                "leftPct": 0.5100911458333334,
                "topPct": 0.47042348779134296,
                "widthPct": 0.26711580123024425,
                "heightPct": 0.017758046614872364
              },
              {
                "leftPct": 0.2350933908045977,
                "topPct": 0.48699361820199777,
                "widthPct": 0.5622340235216864,
                "heightPct": 0.012572835738068812
              },
              {
                "leftPct": 0.2350933908045977,
                "topPct": 0.484218923418424,
                "widthPct": 0.5622340235216864,
                "heightPct": 0.017758046614872364
              },
              {
                "leftPct": 0.2350933908045977,
                "topPct": 0.5007977247502775,
                "widthPct": 0.5605806372631555,
                "heightPct": 0.012572835738068812
              },
              {
                "leftPct": 0.2350933908045977,
                "topPct": 0.49802302996670367,
                "widthPct": 0.5605806372631555,
                "heightPct": 0.017758046614872364
              },
              {
                "leftPct": 0.2350933908045977,
                "topPct": 0.5117230854605993,
                "widthPct": 0.556329135237069,
                "heightPct": 0.017758046614872364
              }
            ]
          }
        ],
        "topicId": "default",
        "createdAt": "2025-01-01T00:00:00.000Z"
      },
      {
        "id": "f5af7756-be07-4386-a7cc-68afb3ce016b",
        "color": "red",
        "text": "(e.g., conversations in Japanese discuss elder care and aging populations at higher-than-typical rates). Second, we use Clio to",
        "pages": [
          {
            "page": 1,
            "text": "(e.g., conversations in Japanese discuss elder care and aging populations at higher-than-typical rates). Second, we use Clio to",
            "rects": [
              {
                "leftPct": 0.23449847341954022,
                "topPct": 0.5944176609322974,
                "widthPct": 0.5625661214192709,
                "heightPct": 0.017758046614872364
              },
              {
                "leftPct": 0.2350933908045977,
                "topPct": 0.6082217674805771,
                "widthPct": 0.2905711908450072,
                "heightPct": 0.017758046614872364
              }
            ]
          }
        ],
        "topicId": "default",
        "createdAt": "2025-01-01T00:00:00.000Z"
      },
      {
        "id": "d2c4ed6a-3826-4252-a275-ace1e8a4ebd6",
        "color": "blue",
        "text": "make our systems safer by identifyingcoordinated attempts to abuse our systems, monitoring for unknown unknownsduring critical periods like launches of new capabilities or major world events, andimproving our existing monitoring systems. We also discuss the limitations of our",
        "pages": [
          {
            "page": 1,
            "text": "make our systems safer by identifyingcoordinated attempts to abuse our systems, monitoring for unknown unknownsduring critical periods like launches of new capabilities or major world events, andimproving our existing monitoring systems. We also discuss the limitations of our",
            "rects": [
              {
                "leftPct": 0.5112922054597702,
                "topPct": 0.6082217674805771,
                "widthPct": 0.16721370302397628,
                "heightPct": 0.017758046614872364
              },
              {
                "leftPct": 0.6706963900862069,
                "topPct": 0.6109964622641509,
                "widthPct": 0.005421605603448276,
                "heightPct": 0.012572835738068812
              },
              {
                "leftPct": 0.6706963900862069,
                "topPct": 0.6082217674805771,
                "widthPct": 0.005421605603448276,
                "heightPct": 0.017758046614872364
              },
              {
                "leftPct": 0.6746924389367817,
                "topPct": 0.6109964622641509,
                "widthPct": 0.09666644567730782,
                "heightPct": 0.012572835738068812
              },
              {
                "leftPct": 0.6746924389367817,
                "topPct": 0.6082217674805771,
                "widthPct": 0.09666644567730782,
                "heightPct": 0.017758046614872364
              },
              {
                "leftPct": 0.2350933908045977,
                "topPct": 0.6246965177580466,
                "widthPct": 0.5611909011314655,
                "heightPct": 0.012572835738068812
              },
              {
                "leftPct": 0.2350933908045977,
                "topPct": 0.6219218229744728,
                "widthPct": 0.5611909011314655,
                "heightPct": 0.017758046614872364
              },
              {
                "leftPct": 0.2350933908045977,
                "topPct": 0.6384919533851277,
                "widthPct": 0.5630961451037176,
                "heightPct": 0.012572835738068812
              },
              {
                "leftPct": 0.2350933908045977,
                "topPct": 0.6357172586015538,
                "widthPct": 0.5630961451037176,
                "heightPct": 0.017758046614872364
              },
              {
                "leftPct": 0.2350933908045977,
                "topPct": 0.6495213651498335,
                "widthPct": 0.5632817060097881,
                "heightPct": 0.017758046614872364
              }
            ]
          }
        ],
        "topicId": "default",
        "createdAt": "2025-01-01T00:00:00.000Z"
      }
    ],
    "threads": [
      {
        "id": "2430dfca-9d83-4076-974f-d39fbb7e689e",
        "topicId": "default",
        "pdfKey": "url:https://arxiv.org/abs/2412.13678",
        "annotationId": "2430dfca-9d83-4076-974f-d39fbb7e689e",
        "anchorPage": 1,
        "anchorColor": "yellow",
        "label": "p.1 · 🟡",
        "customName": "",
        "quotedText": "issues, we present Clio (Claude insights and observations), a privacy-preservingplatform that uses AI assistants themselves to analyze and surface aggregated usagepatterns across millions of conversations, without the need for human reviewers toread raw conversations. We validate this can be done with a high degree of accuracyand privacy by conducting extensive evaluations. We demonstrate Clio’s usefulness",
        "messages": [
          {
            "role": "user",
            "content": "论文一句话定义：用 AI 自己分析海量对话，全程不让人读原始对话。这是 Clio 的核心卖点。",
            "contentEn": "One-line definition: use AI itself to analyze massive volumes of conversations, with no human ever reading the raw conversations. This is Clio's core selling point.",
            "includedInNote": true
          }
        ],
        "createdAt": 1735689600000
      },
      {
        "id": "d2c4ed6a-3826-4252-a275-ace1e8a4ebd6",
        "topicId": "default",
        "pdfKey": "url:https://arxiv.org/abs/2412.13678",
        "annotationId": "d2c4ed6a-3826-4252-a275-ace1e8a4ebd6",
        "anchorPage": 1,
        "anchorColor": "blue",
        "label": "p.1 · 🔵",
        "customName": "",
        "quotedText": "make our systems safer by identifyingcoordinated attempts to abuse our systems, monitoring for unknown unknownsduring critical periods like launches of new capabilities or major world events, andimproving our existing monitoring systems. We also discuss the limitations of our",
        "messages": [
          {
            "role": "user",
            "content": "可借鉴：把分析平台同时用作安全监控（发现协同滥用、监测 unknown unknowns）这个双重定位，值得迁移到我自己的系统评估里。",
            "contentEn": "Reusable idea: positioning the analysis platform simultaneously as a safety monitor (detecting coordinated abuse, watching for unknown unknowns) — this dual role is worth transferring into my own system evaluation.",
            "includedInNote": true
          }
        ],
        "createdAt": 1735689600000
      },
      {
        "id": "f5af7756-be07-4386-a7cc-68afb3ce016b",
        "topicId": "default",
        "pdfKey": "url:https://arxiv.org/abs/2412.13678",
        "annotationId": "f5af7756-be07-4386-a7cc-68afb3ce016b",
        "anchorPage": 1,
        "anchorColor": "red",
        "label": "p.1 · 🔴",
        "customName": "",
        "quotedText": "(e.g., conversations in Japanese discuss elder care and aging populations at higher-than-typical rates). Second, we use Clio to",
        "messages": [
          {
            "role": "user",
            "content": "[CURRENT_PAGE: 1]\n这句里说日语对话讨论养老的比例偏高，这个发现是怎么得出来的？Clio 是怎么保证这种跨语言模式不是噪声的？",
            "contentEn": "[CURRENT_PAGE: 1]\nThis sentence says Japanese conversations discuss elder care at higher-than-typical rates — how was that finding derived? How does Clio ensure such cross-lingual patterns aren't just noise?",
            "includedInNote": true
          },
          {
            "role": "assistant",
            "content": "这个发现来自 Clio 的多语言分析流程。具体来说，Clio 先对每段对话提取 facets，包括识别对话使用的语言（通过 Claude 3 Haiku 分类，再用 `langcodes` 等工具验证〔p.38〕），以及提取对话主题（比如 \"What task is the model being asked to perform?\" 这个 facet〔p.7〕）。然后通过语义聚类——先用 `all-mpnet-base-v2` 做 embedding，再用 k-means 聚类〔p.22–23〕——把日语对话中关于 \"elder care\" 的集群单独识别出来。\n\n**这种跨语言模式不是噪声，而是有双层校验支撑的：**\n\n1. **统计显著性检验**：Clio 会比较每个语言在某个集群中的占比 vs. 该语言在整体样本中的基数比例（base rate），计算\"相对于基数的倍数\"——Figure 7 里就是用的这个方法〔p.9〕。日语在 elder care 集群中的比例如果显著高于它在全部对话中的比例，才被视作有意义的差异。\n\n2. **多语言端到端验证**：附录 C 的合成数据实验表明，Clio 在 15 种语言上的主题重建准确率都在 **92% 以上**（日语 94.4%）〔p.29〕。这说明聚类和标签生成对日语这类非英语语料同样可靠，而不是因为 embedding 模型对日语有偏而导致误分类。\n\n此外，在隐私层（Min. accounts ≥ N）和聚类聚合阈值之后，还经过人工抽样审查（Appendix C.1），确认集群标题和内容一致——所以 \"elder care\" 集群不是零散的噪声形成的偶然模式〔p.26〕。",
            "contentEn": "This finding comes from Clio's multilingual analysis pipeline. Specifically, Clio first extracts facets from each conversation, including identifying the conversation's language (classified by Claude 3 Haiku, then validated with tools like `langcodes` 〔p.38〕) and extracting conversation topics (e.g. the facet \"What task is the model being asked to perform?\" 〔p.7〕). It then uses semantic clustering — first embedding with `all-mpnet-base-v2`, then k-means clustering 〔p.22-23〕 — to isolate the \"elder care\" cluster among Japanese conversations.\n\n**This cross-lingual pattern is not noise; it is backed by two layers of validation:**\n\n1. **Statistical significance testing**: Clio compares each language's share within a cluster against that language's base rate in the overall sample, computing the \"multiple over base rate\" — this is the method used in Figure 7 〔p.9〕. Japanese is only treated as a meaningful difference if its share in the elder-care cluster is significantly above its share across all conversations.\n\n2. **End-to-end multilingual validation**: The synthetic-data experiments in Appendix C show Clio reconstructs topics with **over 92%** accuracy across 15 languages (94.4% for Japanese) 〔p.29〕. This indicates clustering and label generation are equally reliable for non-English corpora like Japanese, rather than misclassification from embedding bias.\n\nMoreover, after the privacy layer (Min. accounts ≥ N) and clustering aggregation thresholds, there is also manual sample review (Appendix C.1) confirming cluster titles match their contents — so the \"elder care\" cluster is not an incidental pattern formed by scattered noise 〔p.26〕.",
            "includedInNote": true
          }
        ],
        "createdAt": 1735689600000
      },
      {
        "id": "main",
        "topicId": "default",
        "pdfKey": "url:https://arxiv.org/abs/2412.13678",
        "annotationId": null,
        "anchorPage": null,
        "anchorColor": null,
        "label": "主对话",
        "customName": "",
        "quotedText": "",
        "messages": [
          {
            "role": "user",
            "content": "[CURRENT_PAGE: 1]\n请给这篇论文一个 100 字以内的核心总结（What / Why / How / Result）。",
            "contentEn": "[CURRENT_PAGE: 1]\nPlease give a core summary of this paper in under 100 words (What / Why / How / Result). Respond in English.",
            "includedInNote": true
          },
          {
            "role": "assistant",
            "content": "这篇论文介绍 **Clio**，一个利用 AI 模型本身对百万级用户对话进行隐私保护的聚合分析平台。**目的**是解决理解真实世界 AI 使用情况时面临的隐私、伦理和规模难题。**方法**是通过对话摘要、语义聚类和层级可视化来提取洞察。**结果**揭示了 Claude.ai 上编码、写作和研究的常见用例，并成功发现了滥用模式，提升了安全监控能力。",
            "contentEn": "This paper introduces **Clio**, a privacy-preserving platform that uses AI models themselves to perform aggregated analysis over millions of user conversations. **Why**: to solve the privacy, ethical, and scale challenges of understanding real-world AI usage. **How**: by extracting insights through conversation summarization, semantic clustering, and hierarchical visualization. **Result**: it reveals common use cases on Claude.ai such as coding, writing, and research, and successfully surfaces abuse patterns, improving safety monitoring.",
            "includedInNote": true
          }
        ],
        "createdAt": 1735689600000
      }
    ]
  };

// 把 EXAMPLE_SEED 写进 IndexedDB（topic + annotations + threads）。
// 幂等：localStorage 标志位已设 → 直接跳过（注入过，或用户删了示例后不再恢复）。
// 失败容忍：IDB 不可用时各 save* 函数内部已降级到内存兜底；这里整体 try/catch 兜底。
// 返回值：true = 本次注入了；false = 跳过。
async function seedExampleData() {
  try {
    if (localStorage.getItem(EXAMPLE_SEED_FLAG)) return false;
  } catch (_) {
    // localStorage 不可用（隐私模式 / 禁用）→ 无法记标志，干脆不 seed，避免每次启动重复注入
    return false;
  }
  try {
    const seed = EXAMPLE_SEED;
    await saveTopic(seed.topic);
    await saveAnnotations(seed.pdfKey, seed.annotations);
    // 预烤引用元数据进 metadata store —— 示例论文的「引用」面板秒开、不依赖网络
    if (seed.paperMeta) {
      await writeMeta(CITE_META_PREFIX + seed.pdfKey, seed.paperMeta);
    }
    for (const th of seed.threads) {
      // threads store keyPath=id；直接 put 整条记录（含 topicId / pdfKey / messages）
      await new Promise((resolve) => {
        openIdb().then((db) => {
          const tx = db.transaction(IDB_STORE_THREADS, "readwrite");
          tx.objectStore(IDB_STORE_THREADS).put(th);
          tx.oncomplete = resolve;
          tx.onerror = resolve;
        }).catch(() => { _memThreads.set(th.id, th); resolve(); });
      });
    }
    try { localStorage.setItem(EXAMPLE_SEED_FLAG, "1"); } catch (_) {}
    console.log("[seedExampleData] example paper seeded");
    return true;
  } catch (e) {
    console.warn("[seedExampleData]", e);
    return false;
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

// 启动期总入口：先探测是否首次使用，再决定 ensure default / 弹首次 modal
// 在模块顶层 fire-and-forget 跑；后续 loadPdf 用到 state.topics 时若还没好会落到 ensureDefaultTopic 兜底
// v3-β：额外把 IDB 里所有 topics 拉到内存里，topic grid 渲染时用
//
// palette 改版：首次使用（IDB 里从没建过任何 topic）→ 不静默建默认主题，
//   而是标记 _isFirstRun，由 _bootstrapPromise.then 里弹 3 步「新建主题」modal 让用户走一遍。
//   非首次 → 照旧 ensureDefaultTopic 兜底（保证 default 一直在）。
let _isFirstRun = false;
const _bootstrapPromise = (async () => {
  // 首次访问 seeding：把示例 Clio 论文写进 IDB（幂等，localStorage 标志位防重）。
  // 必须在「看 IDB 里有没有 topic」之前跑 —— seeding 后 IDB 里就有默认主题（含示例）了，
  // 下面的 existing.length 判定就不会把首次访客当 _isFirstRun，从而跳过「新建主题」modal，
  // 直接让访客在首页看到示例条目。ensureDefaultTopic 之后也会直接复用这个 default，不另建空主题。
  const seeded = await seedExampleData();
  // 先看 IDB 里有没有 topic（不能先 ensureDefaultTopic，否则它会静默建出 default）
  const existing = await loadAllTopics();
  if (existing.length === 0 && !seeded) {
    // 首次使用且没 seed（如 localStorage 不可用）：不建默认主题，留给 modal 流程。
    // migration 仍要跑（幂等、无害）。
    _isFirstRun = true;
    await runMigrations();
    return;
  }
  // 非首次（或刚 seed 了示例）：确保 default 存在 + 迁移 + 全量加载
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
    // trade-off：极端 mix 字号文档（小字标题/角标）可能误杀，但跨页选段把脚注混进高亮的体验更糟，产品上可接受
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
// v6：按行合并 rect —— range.getClientRects() 对一行文字会返回多个近似重叠的 rect
// （pdf.js textLayer 的 span 切分 + 1-3px 抖动）。不合并的话半透明 .hl-rect 叠加 →
// 深色块（颜色重叠）+ 右侧毛边。这里把竖向重叠的 rect 并成一行一个 bounding-box。
// 只在渲染时做，不动存储的 ann.pages[].rects（也修好用户已存在的旧高亮）。
function mergeRectsByLine(rects) {
  if (!rects || rects.length === 0) return [];
  const sorted = [...rects].sort((a, b) => a.topPct - b.topPct || a.leftPct - b.leftPct);
  const lines = [];
  for (const r of sorted) {
    const rBottom = r.topPct + r.heightPct;
    const line = lines[lines.length - 1];
    // 与当前行竖向重叠超过自身高度 60% → 判为同一行
    if (line) {
      const overlap = Math.min(rBottom, line.bottom) - Math.max(r.topPct, line.top);
      if (overlap > 0.6 * r.heightPct) {
        line.left = Math.min(line.left, r.leftPct);
        line.right = Math.max(line.right, r.leftPct + r.widthPct);
        line.top = Math.min(line.top, r.topPct);
        line.bottom = Math.max(line.bottom, rBottom);
        continue;
      }
    }
    lines.push({ left: r.leftPct, right: r.leftPct + r.widthPct, top: r.topPct, bottom: rBottom });
  }
  return lines.map((l) => ({
    leftPct: l.left,
    topPct: l.top,
    widthPct: l.right - l.left,
    heightPct: l.bottom - l.top,
  }));
}

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
    for (const rect of mergeRectsByLine(pageEntry.rects)) {
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
    // v6：与 renderHighlightsForPage 对齐 —— 按行合并 rect，消除半透明叠加深色斑块 + 右侧毛边
    for (const rect of mergeRectsByLine(pageEntry.rects)) {
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
    btn.title = tag.label || tag.id;
    btn.setAttribute("aria-label", tag.label || tag.id);
    // 纯色块图标：取标签 color hex
    const sw = document.createElement("span");
    sw.className = "cp-swatch";
    sw.style.background = tag.color || "#b8b8b8";
    btn.appendChild(sw);
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
  // 埋点：只发标签色 id，不发划选原文
  track("highlight_created", { color });
  // 清掉浏览器选区（视觉上让用户感受到"动作完成"）
  window.getSelection()?.removeAllRanges();
  // v3-polish #6：增量画新 ann 的 rect（不再 replaceChildren 整层重建）
  // 旧路径：renderHighlightsForPage → layer.replaceChildren + 遍历 state.annotations 全画
  //         随高亮数量线性变慢 + 同页所有 hl-rect 闪一下（GPU 重 layout）
  // 新路径：只 append 本 ann 的 rect 到 highlight-layer，O(本次 rect 数)
  appendAnnotationRects(ann);
  // saveAnnotations 是 IDB 异步写（put）；不会阻塞主线程，保留原 fire-and-forget
  saveAnnotations(state.pdfKey, state.annotations).catch((e) => console.warn("[save]", e));
  // v6：划完高亮 = 建了一条 comment。右栏列表加上卡片（折叠态），并在原文旁浮出 comment 框。
  // A 方案：不填走掉 = 纯标记高亮（annotation 已存、无 messages）；填了发送 = 保存进这条 comment。
  ensureAnnotationThread(ann);
  renderCommentList();
  showCmtCompose(ann.id);
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
  // 2. 从 state 移除
  state.annotations.splice(idx, 1);
  // 3. v2-b：联动删 thread（comment 的 messages 容器一并清掉）
  if (state.threads[id]) {
    delete state.threads[id];
    // v3-δ：联动删 IDB thread record（避免下次 hydrate 时出现孤儿 thread）
    deleteThreadById(id).catch((e) => console.warn("[deleteThreadById]", e));
  }
  // 4. 若被删的正是当前展开的 comment → 收起
  if (state.expandedCommentId === id) state.expandedCommentId = null;
  state.cmtShowAll.delete(id);
  // 5. 重新渲染受影响页，让其他 ann 的叠色重排到位（同步，但只动这几页）
  for (const p of ann.pages) renderHighlightsForPage(p.page);
  // 6. 右栏 comment 列表同步
  renderCommentList();
  // 7. 异步存
  saveAnnotations(state.pdfKey, state.annotations).catch((e) => console.warn("[save]", e));
  // 埋点：纯行为信号
  track("comment_deleted");
}

// 用 CSS class 闪一下对应 ann 的 rect（视觉强化"定位到这条高亮"）
function flashAnnotation(annId) {
  const rects = els.viewer.querySelectorAll(`.hl-rect[data-ann-id="${annId}"]`);
  rects.forEach((el) => {
    el.classList.add("hl-flash");
    // 一次性动画，结束后清掉 class（不影响后续 hover/style）
    setTimeout(() => el.classList.remove("hl-flash"), 900);
  });
}

// ══════════════════════ v6 comment 列表（右栏）══════════════════════
// 右栏 = getComments() 的一列卡片。手风琴：同一时刻最多一张展开（state.expandedCommentId）。
// 级别 2 折叠：展开卡片若消息 > CC_FOLD_THRESHOLD，中间未收入笔记的消息折起，收入的常驻。

const CC_FOLD_THRESHOLD = 6;

// annotation 页码标签："p.3" / "p.3-5"
function annPageLabel(ann) {
  const ps = (ann.pages || []).map((p) => p.page);
  if (ps.length === 0) return "p.?";
  return ps.length === 1 ? `p.${ps[0]}` : `p.${ps[0]}-${ps[ps.length - 1]}`;
}

// comment 标签信息（emoji + label + page + 标签色 hex）；main 用中性色（无 hex）。
// emoji / label / color 优先取自当前主题 palette，回退全局 COLOR_MAP（hex 用 PALETTE_HEX）。
function commentTag(comment) {
  if (comment.isMain) {
    return { emoji: "📄", label: t("cmtFulltextLabel"), page: "", hex: null, isMain: true };
  }
  const ann = comment.annotation;
  const palette = state.topics[state.currentTopicId]?.palette || [];
  const tag = palette.find((p) => p.id === ann.color);
  const emoji = tag?.emoji || COLOR_MAP[ann.color]?.emoji || "●";
  const label = (tag ? displayTagLabel(tag) : "") || COLOR_MAP[ann.color]?.label || "";
  const hex = tag?.color || PALETTE_HEX[ann.color] || null;
  return { emoji, label, page: annPageLabel(ann), hex, isMain: false };
}

// comment 原文（单行连缀、trim）
function commentQuoteText(comment) {
  if (comment.isMain) return t("cmtFulltextQuote");
  const txt = (comment.annotation.text || "").replace(/\s+/g, " ").trim();
  return txt || t("cmtNoQuote");
}

function updateCommentSummary() {
  if (!els.cmtSummary) return;
  const n = state.annotations.length; // main 之外的 comment 数（含纯标记高亮）
  els.cmtSummary.textContent = n === 0
    ? t("cmtSummaryEmpty")
    : t("cmtSummaryCount", n);
}

// 主渲染入口：清空 #commentList 重建所有卡片
function renderCommentList() {
  if (!els.commentList) return;
  const comments = getComments();
  els.commentList.replaceChildren();
  for (const c of comments) els.commentList.appendChild(buildCommentCard(c));
  updateCommentSummary();
}

// 单张 comment 卡片（折叠态只渲染头；展开态额外渲染体）
function buildCommentCard(comment) {
  const expanded = state.expandedCommentId === comment.id;
  const card = document.createElement("div");
  card.className = "cmt-card"
    + (comment.isMain ? " cmt-main" : "")
    + (expanded ? " expanded" : "");
  card.dataset.commentId = comment.id;
  card.setAttribute("role", "listitem");

  // 标签色：唯一从「标签」入口进来的颜色 —— 左色条 + chip 都用这个
  // main（全文导读）无标签色，CSS 回退到中性灰
  const tagInfo = commentTag(comment);
  if (tagInfo.hex) card.style.setProperty("--cmt-color", tagInfo.hex);

  // ── 头（折叠态一行：标签 + 原文 + 💬N [+ 🗑]）──
  const head = document.createElement("div");
  head.className = "cmt-card-head";
  head.setAttribute("role", "button");
  head.tabIndex = 0;
  head.setAttribute("aria-expanded", expanded ? "true" : "false");

  // 标签 chip：实心小圆点（标签色）+ label 文字 + 页码
  const tag = document.createElement("span");
  tag.className = "cc-tag" + (tagInfo.isMain ? " cc-tag-main" : "");
  const dot = document.createElement("span");
  dot.className = "cc-tag-dot";
  dot.setAttribute("aria-hidden", "true");
  const tagLabel = document.createElement("span");
  tagLabel.className = "cc-tag-label";
  tagLabel.textContent = tagInfo.label || t("cmtTagFallback");
  tag.append(dot, tagLabel);
  if (tagInfo.page) {
    const tagPage = document.createElement("span");
    tagPage.className = "cc-tag-page";
    tagPage.textContent = tagInfo.page;
    tag.appendChild(tagPage);
  }
  const quote = document.createElement("span");
  quote.className = "cc-quote";
  quote.textContent = comment.isMain ? commentQuoteText(comment) : `"${commentQuoteText(comment)}"`;
  const count = document.createElement("span");
  count.className = "cc-count";
  count.textContent = `💬 ${comment.messages.length}`;
  head.append(tag, quote, count);

  if (!comment.isMain) {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "cc-del";
    del.dataset.action = "delete-comment";
    del.title = t("cmtDelTitle");
    del.setAttribute("aria-label", t("cmtDelAria"));
    del.textContent = "🗑";
    head.appendChild(del);
  }
  card.appendChild(head);

  // ── 体（仅展开态渲染内容，省 DOM）──
  const body = document.createElement("div");
  body.className = "cmt-card-body";
  if (expanded) {
    if (!comment.isMain) {
      const fq = document.createElement("div");
      fq.className = "cc-fullquote";
      fq.textContent = `"${commentQuoteText(comment)}"`;
      body.appendChild(fq);
    }
    body.appendChild(renderCommentMessages(comment));
    body.appendChild(buildCommentInput(comment));
  }
  card.appendChild(body);
  return card;
}

// 展开态的消息区（含级别 2 折叠 + 流式占位气泡 + 错误提示）
function renderCommentMessages(comment) {
  const wrap = document.createElement("div");
  wrap.className = "cc-messages";
  const msgs = comment.messages;
  const streamingThis = state.streamingCommentId === comment.id;

  if (msgs.length === 0 && !streamingThis) {
    // 无消息：不渲染占位文案（输入框 placeholder 已足够提示，多说冗余）
  } else {
    // 级别 2 折叠：消息多且未「展开全部」→ 只显示首条 + 末条 + 收入笔记的；中间折起
    const showAll = state.cmtShowAll.has(comment.id);
    let visibleIdx;
    if (msgs.length <= CC_FOLD_THRESHOLD || showAll) {
      visibleIdx = msgs.map((_, i) => i);
    } else {
      const keep = new Set([0, msgs.length - 1]);
      msgs.forEach((m, i) => { if (isMsgIncluded(m)) keep.add(i); });
      visibleIdx = [...keep].sort((a, b) => a - b);
    }
    const hiddenCount = msgs.length - visibleIdx.length;
    let prev = -1, toggleInserted = false;
    for (const i of visibleIdx) {
      if (!toggleInserted && i - prev > 1) {
        const foldBtn = document.createElement("button");
        foldBtn.type = "button";
        foldBtn.className = "cc-fold-toggle";
        foldBtn.dataset.action = "unfold";
        foldBtn.textContent = t("cmtShowHidden", hiddenCount);
        wrap.appendChild(foldBtn);
        toggleInserted = true;
      }
      wrap.appendChild(buildMessageEl(msgs[i], i));
      prev = i;
    }
  }

  // 流式占位气泡：sendToComment 把 delta 写进这个 .content
  if (streamingThis) {
    const el = document.createElement("div");
    el.className = "msg assistant streaming";
    const role = document.createElement("div");
    role.className = "role";
    role.textContent = "Agent";
    const content = document.createElement("div");
    content.className = "content";
    content.textContent = "…";
    el.append(role, content);
    wrap.appendChild(el);
  }
  // @AI 失败的错误提示（下次操作清掉）
  if (state.streamError && state.streamError.commentId === comment.id) {
    const err = document.createElement("div");
    err.className = "err";
    err.textContent = state.streamError.text;
    wrap.appendChild(err);
  }
  return wrap;
}

// 单条消息 DOM（复用 .msg 样式）+「收入笔记」勾选
function buildMessageEl(m, index) {
  const el = document.createElement("div");
  el.className = `msg ${m.role}` + (isMsgIncluded(m) ? "" : " note-excluded");

  const roleEl = document.createElement("div");
  roleEl.className = "role";
  roleEl.textContent = m.role === "user" ? t("roleUser") : t("roleAgent");

  const contentEl = document.createElement("div");
  contentEl.className = "content";
  const text = m.role === "user" ? _stripPageTag(msgContent(m)) : msgContent(m);
  if (m.role === "assistant") renderAssistant(contentEl, text);
  else contentEl.textContent = text;

  // 「收入笔记」勾选 —— 默认勾，导出按此过滤
  const note = document.createElement("label");
  note.className = "msg-note";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = isMsgIncluded(m);
  cb.dataset.action = "toggle-note";
  cb.dataset.msgIndex = String(index);
  const noteTxt = document.createElement("span");
  noteTxt.textContent = t("noteInclude");
  note.append(cb, noteTxt);

  el.append(roleEl, contentEl, note);
  return el;
}

// 卡片内输入：纯批注（不调 LLM）/ 含 @AI（召唤 AI）。流式中本卡片按钮变「停止」，其他卡片禁用。
function buildCommentInput(comment) {
  const form = document.createElement("form");
  form.className = "cc-input";
  form.dataset.commentId = comment.id;
  const ta = document.createElement("textarea");
  ta.rows = 1;
  ta.placeholder = t("cmtComposePlaceholder");
  const btn = document.createElement("button");
  btn.type = "submit";
  const streamingThis = state.streaming && state.streamingCommentId === comment.id;
  if (streamingThis) {
    btn.textContent = t("cmtComposeStop");
    btn.classList.add("stopping");
  } else {
    btn.textContent = t("cmtComposeSend");
    if (state.streaming) { ta.disabled = true; btn.disabled = true; }
  }
  form.append(ta, btn);
  return form;
}

// ── comment 手风琴：展开 / 收起 / 切换 ──
// opts.scrollPdf：是否把 PDF 滚到锚定高亮（点列表卡片 true；划线刚建 false 不跳页）
function expandComment(id, opts) {
  const o = opts || {};
  // 流式中切到别的 comment → abort（回复不会落到错的卡片）
  if (state.streaming && state.abortCtl && state.streamingCommentId !== id) {
    state.abortCtl.abort();
  }
  if (state.streamError && state.streamError.commentId !== id) state.streamError = null;
  state.expandedCommentId = id;
  renderCommentList();
  const card = els.commentList?.querySelector(`.cmt-card[data-comment-id="${id}"]`);
  if (card) card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  if (o.scrollPdf !== false && id !== "main" && state.pdf) {
    const ann = state.annotations.find((a) => a.id === id);
    if (ann && ann.pages[0]) {
      try { pdfViewer.scrollPageIntoView({ pageNumber: ann.pages[0].page }); } catch (_) {}
      requestAnimationFrame(() => {
        const rect = els.viewer.querySelector(`.hl-rect[data-ann-id="${id}"]`);
        if (rect) {
          // 让目标高亮落在视口偏上（约 28%）—— 定位到这句、继续往下读
          const cont = els.viewerContainer;
          const contBox = cont.getBoundingClientRect();
          const rectBox = rect.getBoundingClientRect();
          const target = rectBox.top - contBox.top + cont.scrollTop - contBox.height * 0.28;
          cont.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
        }
        flashAnnotation(id);
      });
    }
  }
}
function collapseComment() {
  if (state.streaming && state.abortCtl) state.abortCtl.abort();
  state.expandedCommentId = null;
  state.streamError = null;
  renderCommentList();
}
function toggleComment(id) {
  if (state.expandedCommentId === id) collapseComment();
  else expandComment(id);
}

// ── 划线浮出 comment 框（A 方案：不填走掉 = 纯高亮；填了发送 = 保存）──
// 选色建好 annotation 后浮在原文旁；用 hl-rect 的屏幕坐标定位（同旧 hl-bubble 思路）
function showCmtCompose(annId) {
  const rectEl = els.viewer.querySelector(`.hl-rect[data-ann-id="${annId}"]`);
  if (!rectEl) return;        // 高亮 rect 没画出来就放弃浮框（右栏卡片仍在，不影响）
  state.composeCommentId = annId;
  const anchor = rectEl.getBoundingClientRect();
  const cont = els.viewerContainer.getBoundingClientRect();
  const BOX_W = 320, GAP = 8;
  // 默认放高亮下方
  let top = anchor.bottom - cont.top + els.viewerContainer.scrollTop + GAP;
  let left = anchor.left - cont.left + els.viewerContainer.scrollLeft;
  const maxLeft = els.viewerContainer.scrollLeft + cont.width - BOX_W - 8;
  if (left > maxLeft) left = Math.max(8, maxLeft);
  if (left < els.viewerContainer.scrollLeft + 8) left = els.viewerContainer.scrollLeft + 8;
  els.cmtCompose.style.left = `${left}px`;
  els.cmtCompose.style.top = `${top}px`;
  els.cmtComposeInput.value = "";
  els.cmtCompose.hidden = false;
  autoGrow(els.cmtComposeInput);
  els.cmtComposeInput.focus();
}
function hideCmtCompose() {
  if (els.cmtCompose) els.cmtCompose.hidden = true;
  state.composeCommentId = null;
}
// 浮框发送：不填走掉 = 纯高亮（annotation 已存、无 messages）；填了 = 走 @AI 路由
function submitCmtCompose() {
  const id = state.composeCommentId;
  const text = (els.cmtComposeInput.value || "").trim();
  hideCmtCompose();
  if (!id || !text) return;
  routeCommentInput(id, text, "compose");
}

// Block 2：往 comment 里加一条纯批注（用户消息，不调 LLM）。@AI 召唤由 Block 3 接入。
function addBareNote(commentId, text) {
  const t = (text || "").trim();
  if (!t) return;
  let thread = state.threads[commentId];
  if (!thread && commentId !== "main") {
    const ann = state.annotations.find((a) => a.id === commentId);
    if (ann) thread = ensureAnnotationThread(ann);
  }
  if (!thread) return;
  thread.messages.push({ role: "user", content: t, includedInNote: true });
  persistThread(thread);
  // 埋点：纯批注，不发批注文字
  track("note_added");
  renderCommentList();
}

// 翻转某条消息的「收入笔记」状态
function toggleMsgIncluded(commentId, msgIndex) {
  const thread = state.threads[commentId];
  if (!thread || !thread.messages[msgIndex]) return;
  const m = thread.messages[msgIndex];
  m.includedInNote = !isMsgIncluded(m);
  persistThread(thread);
  renderCommentList();
}

// ────────────────────── chatClient（v6 comment 模型）──────────────────────
// 收发都基于一条 comment：thread.messages 是该 comment 的讨论历史。
// caching：稳定大前缀 = server.py 注入的 SYSTEM_PROMPT + pdf_text + 前端 palette 规则；
//          本 comment 上下文 = 高亮原文 system note + thread.messages。
//          大前缀字节稳定 → comment 之间共享缓存命中（不掺时间戳/UUID）。

// @AI 默认问题（用户只打 @AI 不带问题时）
// 英文模式下显式带 "Respond in English."（见 I18N.en.defaultQMain），让 AI 也英文回复。
function defaultQuestion(commentId) {
  return commentId === "main"
    ? t("defaultQMain")
    : t("defaultQHighlight");
}

// comment 输入路由：含 @AI → 召唤 AI；否则 → 纯批注。compose 框与卡片输入共用。
// from：埋点来源（compose / card），透传给 sendToComment。
function routeCommentInput(commentId, text, from) {
  const t = (text || "").trim();
  if (!t) return;
  state.streamError = null;
  state.expandedCommentId = commentId; // 确保结果在右栏可见
  if (/@ai/i.test(t)) {
    const q = t.replace(/@ai/ig, "").trim();
    sendToComment(commentId, q || defaultQuestion(commentId), from || "card");
  } else {
    addBareNote(commentId, t);
  }
}

// 把一条问题发给某条 comment 的 AI。用户消息 + AI 回复都进 thread.messages，
// 流式渲染进右栏展开卡片里的 .msg.assistant.streaming 占位气泡。
async function sendToComment(commentId, question, from) {
  if (state.streaming) return;
  const q = (question || "").trim();
  if (!q) return;
  // 埋点：只发来源类型，不发问题文字
  track("ai_invoked", { from: from || "card" });
  let thread = state.threads[commentId];
  if (!thread && commentId !== "main") {
    const ann = state.annotations.find((a) => a.id === commentId);
    if (ann) thread = ensureAnnotationThread(ann);
  }
  if (!thread) return;

  // 用户消息入 thread（带当前页标签，给 AI 做 〔p.N〕 引用；显示时 _stripPageTag 去掉）
  thread.messages.push({
    role: "user",
    content: `[CURRENT_PAGE: ${state.currentPage}]\n${q}`,
    includedInNote: true,
  });
  persistThread(thread);

  // 进入流式态 + 展开该 comment → renderCommentList 渲出空的 streaming 气泡
  state.streaming = true;
  state.streamingCommentId = commentId;
  state.streamError = null;
  state.expandedCommentId = commentId;
  state.abortCtl = new AbortController();
  renderCommentList();

  // 流式目标：展开卡片里 .msg.assistant.streaming 的 .content（每次重新查，防 DOM 被重建）
  const findContentEl = () => {
    const card = els.commentList?.querySelector(`.cmt-card[data-comment-id="${commentId}"]`);
    return card ? card.querySelector(".msg.assistant.streaming .content") : null;
  };
  const c0 = findContentEl();
  if (c0) c0.textContent = "…";

  // ── 拼 LLM 请求：palette 规则 + 高亮原文 system note + thread.messages ──
  const paletteRules = buildPaletteRules(state.topics[state.currentTopicId]?.palette);
  const sys = [];
  if (paletteRules) sys.push({ role: "system", content: paletteRules });
  // i18n：英文模式下显式要求 AI 用英文回复（system_prompt.md 默认中文回复；
  // 加这条 system 指令让自动总结 / 用户 @AI 在英文界面下也出英文，不碰 server.py）。
  if (LANG === "en") {
    sys.push({ role: "system", content: "Respond in English." });
  }
  const ann = state.annotations.find((a) => a.id === commentId);
  if (ann) {
    sys.push({
      role: "system",
      content: t("annContextNote", annPageLabel(ann), ann.text),
    });
  }
  const messagesForLLM = [...sys, ...thread.messages];

  let fullText = "";
  let _replyOk = false;
  try {
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: messagesForLLM, pdf_text: state.pdfText }),
      signal: state.abortCtl.signal,
    });
    if (!r.ok) {
      const errBody = await r.text();
      throw new Error(extractErrorMessage(errBody) || `HTTP ${r.status}`);
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "", sawAnySSE = false, rawAll = "";
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
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        sawAnySSE = true;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const j = JSON.parse(data);
          if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
          const delta = j.choices?.[0]?.delta?.content || "";
          if (delta) {
            fullText += delta;
            const el = findContentEl();
            if (el) renderAssistant(el, fullText);
          }
        } catch (e) {
          // 单行 JSON 解析失败多半是分片，继续；真 Error 上抛
          if (e instanceof Error && e.message && !e.message.startsWith("Unexpected")) throw e;
        }
      }
    }
    if (!sawAnySSE) throw new Error(extractErrorMessage(rawAll) || t("errNotStream"));
    if (!fullText.trim()) throw new Error(t("errEmptyContent"));
    thread.messages.push({ role: "assistant", content: fullText, includedInNote: true });
    persistThread(thread);
    _replyOk = true;
  } catch (e) {
    if (e.name === "AbortError") {
      // 中止：有半成品就留下（标注已中止），没有就只留用户消息
      if (fullText) {
        thread.messages.push({ role: "assistant", content: fullText + "\n\n" + t("aborted"), includedInNote: true });
        persistThread(thread);
      }
    } else {
      console.error("[sendToComment]", e);
      const rawMsg = String(e.message || e);
      const looksLikeHtml = /<[a-zA-Z!\/]/.test(rawMsg);
      if (rawMsg.length > 200 || looksLikeHtml) {
        console.warn("[sendToComment] 上游原始错误内容:", rawMsg);
        state.streamError = { commentId, text: t("errBadFormat") };
      } else {
        state.streamError = { commentId, text: `⚠ ${rawMsg}` };
      }
      // 用户消息保留 —— 它本身是一条合法批注；错误提示渲染在卡片里
    }
  } finally {
    state.streaming = false;
    state.streamingCommentId = null;
    state.abortCtl = null;
    // 埋点：只发成功/失败布尔，不发回复内容
    track("ai_reply", { ok: _replyOk });
    renderCommentList();
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
// i18n：检测词需同时识别中/英两版（用户切语言后仍要识别上次 prime 过的 main thread，避免重发）。
const PRIME_KEYWORDS = [I18N.zh.primeKeyword, I18N.en.primeKeyword];

async function primeSummary() {
  // 自动总结进「全文 comment」(main)。文案含 PRIME_KEYWORD（见 defaultQuestion），供 maybePrimeSummary 检测
  await sendToComment("main", defaultQuestion("main"), "prime");
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
      (m) => m && m.role === "user" && typeof m.content === "string" &&
        PRIME_KEYWORDS.some((kw) => m.content.includes(kw))
    );
  if (alreadyPrimed) {
    console.debug("[primeSummary] already done in prior session, skipping");
    return;
  }
  await primeSummary();
}

// ────────────────────── UI 工具 ──────────────────────
// v6：appendMsgBubble 已退休 —— 消息渲染见 buildMessageEl（comment 卡片内）

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
      return `<a class="cite-link" data-page="${n}" title="${t("citeJumpTitle", n)}">〔p.${n}〕</a>`;
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
  els.home.classList.remove("active");
  els.landing.classList.remove("active");
  els.topicPage.classList.remove("active");
  els.reader.classList.remove("active");
  if (els.exportPage) els.exportPage.classList.remove("active");
}
// 首页：粘贴链接直接读 —— 极简入口，主题管理后置
function switchToHome() {
  _hideAllViews();
  hideTopicCardMenu();
  els.home.classList.add("active");
  state.view = "home";
  renderHomeRecent();
}

// 渲染首页"最近在读" —— 跨所有主题收集 url 类型 PDF
// （file 类型本地 PDF 无法重开、需重选文件 → 不进列表，见 openPdfFromTopic）
function renderHomeRecent() {
  const box = els.homeRecent;
  box.replaceChildren();
  const items = [];
  for (const tid of Object.keys(state.topics)) {
    const topic = state.topics[tid];
    if (!topic) continue;
    for (const k of (topic.pdfKeys || [])) {
      if (k.startsWith("url:")) items.push({ pdfKey: k, topicId: tid, topicName: displayTopicName(topic) });
    }
  }
  if (items.length === 0) return;   // 没读过 → 不渲染（首页保持干净）
  items.reverse();                  // pdfKeys 按 push 顺序 → 倒序近似"最近"
  const recent = items.slice(0, 8);
  const head = document.createElement("div");
  head.className = "home-recent-head";
  head.textContent = t("recentHead");
  box.appendChild(head);
  const list = document.createElement("div");
  list.className = "home-recent-list";
  for (const it of recent) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "home-recent-item";
    card.dataset.pdfKey = it.pdfKey;
    card.dataset.topicId = it.topicId;
    const isExample = it.pdfKey === EXAMPLE_PDF_KEY;
    const name = document.createElement("span");
    name.className = "hr-name";
    // 示例条目用特殊标题，和真实论文区分；并加一个浅色「示例」小标签
    name.textContent = isExample ? t("exampleRecentTitle") : deriveTitleFromPdfKey(it.pdfKey);
    if (isExample) {
      card.classList.add("home-recent-item-example");
      const badge = document.createElement("span");
      badge.className = "hr-badge";
      badge.textContent = t("exampleBadge");
      name.appendChild(badge);
    }
    const topic = document.createElement("span");
    topic.className = "hr-topic";
    topic.textContent = it.topicName;
    card.append(name, topic);
    list.appendChild(card);
  }
  box.appendChild(list);
}

function switchToTopicList() {
  _hideAllViews();
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
  hideTopicCardMenu();
  els.reader.classList.add("active");
  state.view = "reader";
  setLandingStatus("");
  // v3-γ：切到 reader 时按当前主题重渲色板（loadPdf 已经在切完后再渲一次，这里是兜底入口）
  renderColorPalette();
  // v6：右栏 comment 列表兜底渲染（loadPdf hydration 会再渲一次）
  renderCommentList();
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
  // v6：重置 comment 列表 + 流式 + 浮框 UI 状态
  state.expandedCommentId = null;
  state.cmtShowAll.clear();
  state.streamingCommentId = null;
  state.streamError = null;
  state.streaming = false;
  if (els.commentList) els.commentList.replaceChildren();
  if (state.abortCtl) state.abortCtl.abort();
  // 隐藏色板 + 浮出 comment 框 + 清掉 viewer 残留的高亮 DOM
  hideColorPalette();
  hideCmtCompose();
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
  if (els.cmtSummary) els.cmtSummary.textContent = t("cmtSummaryPreparing");
  els.pdfTitle.textContent = "";
  els.readerTopicHint.textContent = "";
}

function setLandingStatus(text, isError = false) {
  if (!text) { els.landingStatus.hidden = true; els.landingStatus.textContent = ""; return; }
  els.landingStatus.hidden = false;
  els.landingStatus.textContent = text;
  els.landingStatus.classList.toggle("error", !!isError);
}

// v6：setStreaming 已退休 —— 流式态由 sendToComment 直接管 state.streaming，
//     按钮态在 buildCommentInput 里按 state.streamingCommentId 渲染

// v6：thread 切换器 / thread list / 行内重命名 已退休 —— 右栏改为 comment 列表（见 renderCommentList）

// ────────────────────── v3-β 主题 UI ──────────────────────
// 三层视图：topicList (landing) / topicPage / reader
// 关键设计决策（PM 拍板，严格遵守）：
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
  const ts = new Date(iso).getTime();
  if (!ts) return "";
  const diff = Date.now() - ts;
  const min = 60 * 1000, hour = 60 * min, day = 24 * hour;
  if (diff < min) return t("timeJustNow");
  if (diff < hour) return t("timeMinAgo", Math.floor(diff / min));
  if (diff < day) return t("timeHourAgo", Math.floor(diff / hour));
  if (diff < 30 * day) return t("timeDayAgo", Math.floor(diff / day));
  try { return new Date(iso).toISOString().slice(0, 10); } catch { return ""; }
}

// 从 pdfKey 反推可读标题（file:foo.pdf:123 / url:https://... → 截尾）
function deriveTitleFromPdfKey(pdfKey, fallback = "") {
  if (!pdfKey) return fallback || t("unnamedPdf");
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
  name.textContent = displayTopicName(topic);

  // palette 色块预览
  const pal = document.createElement("div");
  pal.className = "tc-palette";
  for (const p of (topic.palette || [])) {
    const sw = document.createElement("span");
    sw.className = "tc-swatch";
    sw.style.background = p.color;
    sw.title = displayTagLabel(p);
    pal.appendChild(sw);
  }

  // 元信息：PDF 数 + 创建时间
  const meta = document.createElement("div");
  meta.className = "tc-meta";
  const pdfCount = (topic.pdfKeys || []).length;
  const m1 = document.createElement("span");
  m1.textContent = t("tpPdfCount", pdfCount);
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
    menuBtn.setAttribute("aria-label", t("tpMoreActions"));
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
  els.tpName.textContent = displayTopicName(topic);
  // palette 行（只读小标签）
  els.tpPaletteRow.replaceChildren();
  for (const p of (topic.palette || [])) {
    const tag = document.createElement("span");
    tag.className = "tp-tag";
    tag.title = t("tpPaletteTitle");
    const sw = document.createElement("span");
    sw.className = "tp-tag-swatch";
    sw.style.background = p.color || "#b8b8b8";
    const lb = document.createElement("span");
    lb.textContent = displayTagLabel(p);
    tag.append(sw, lb);
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
    empty.textContent = t("tpEmptyPdf");
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
    removeBtn.title = t("tpRemoveTitle");
    removeBtn.setAttribute("aria-label", t("tpRemoveAria"));
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
    setTpStatus(t("localFileError"), true);
    els.tpFileInput.click();
  } else {
    setTpStatus(t("unknownPdfKey", pdfKey), true);
  }
}

// ── reader 顶栏 topic hint 更新 ──
// v3-polish-2 #3：去掉主题名前面的彩色 dot（产品反馈"emoji 加回去"指的是引用块，不是主题 dot）
//   ::before 的 dot 已在 CSS 中删除；这里不再注入 --topic-dot-color
function updateReaderTopicHint() {
  const topic = state.topics[state.currentTopicId];
  if (!topic) {
    els.readerTopicHint.textContent = "";
    els.readerTopicHint.removeAttribute("data-editable");
    return;
  }
  els.readerTopicHint.textContent = displayTopicName(topic);
  // 任何主题（含默认）点击都可 inline 改名
  els.readerTopicHint.setAttribute("data-editable", "1");
  els.readerTopicHint.title = t("readerTopicHintTitle", displayTopicName(topic));
}

// v3-polish #5：reader 顶栏主题名 inline 重命名
// 点击 → 切到 input；Enter / blur 保存；ESC 取消恢复
let _topicHintEditing = false;
function startEditReaderTopicHint() {
  if (_topicHintEditing) return;
  const topic = state.topics[state.currentTopicId];
  if (!topic) return;
  _topicHintEditing = true;
  const oldName = topic.name;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "reader-topic-hint-input";
  input.value = oldName;
  input.maxLength = 30;
  input.setAttribute("aria-label", t("tpRenameAria"));
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

// 主题页大标题 #tpName inline 重命名（复用 renameTopic，默认主题也可改）
// 点标题 → input；Enter / blur 保存；ESC 取消
let _tpNameEditing = false;
function startEditTpName(topicId) {
  if (_tpNameEditing) return;
  const topic = state.topics[topicId];
  if (!topic) return;
  _tpNameEditing = true;
  const oldName = topic.name;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "tp-name-input";
  input.value = oldName;
  input.maxLength = 30;
  input.setAttribute("aria-label", t("tpRenameAria"));
  els.tpName.textContent = "";
  els.tpName.appendChild(input);
  input.focus();
  input.select();

  let finished = false;
  const commit = async (save) => {
    if (finished) return;
    finished = true;
    _tpNameEditing = false;
    const nextName = input.value.trim().slice(0, 30);
    if (!save || !nextName || nextName === oldName) {
      els.tpName.textContent = displayTopicName(topic);
      return;
    }
    try {
      await renameTopic(topicId, nextName);
    } catch (e) {
      console.warn("[renameTopic]", e);
    }
    els.tpName.textContent = displayTopicName(topic);
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
// id 可选：首次使用流程传 DEFAULT_TOPIC_ID，让"第一个主题"就是默认主题；否则生成 uuid
async function createTopic({ name, palette, id }) {
  const tid = id || _uuid();
  const now = new Date().toISOString();
  const topic = {
    id: tid,
    name: (name || "").trim() || t("unnamedTopic"),
    // 深拷贝 palette（防 modal 编辑器后续 mutate）
    palette: (palette || []).map((p) => ({ ...p })),
    pdfKeys: [],
    createdAt: now,
    // v3-fixup-2: palette 创建即冻结，记录冻结时间戳（修 A2 long-term issue）
    // 老主题（v3-α/β 创建无此字段）保持 undefined，不主动 migrate（避免 IDB 写风暴）
    paletteFrozenAt: now,
  };
  state.topics[tid] = topic;
  await saveTopic(topic);
  return topic;
}

// 重命名（默认主题也允许改名；"不可删除"限制保留）
async function renameTopic(id, newName) {
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

// i18n：取消息的展示文案。示例种子消息带 contentEn（英文版）—— 英文模式优先用它。
// 用户真实消息没有 contentEn，回退到 content（保持用户输入原文）。
function msgContent(m) {
  if (!m) return "";
  if (LANG === "en" && typeof m.contentEn === "string" && m.contentEn) return m.contentEn;
  return m.content || "";
}

// 文件名安全化：替换 windows / unix 不合法字符为 -
// 主题名含 "测试/X" → "测试-X"
function _safeFileName(name) {
  // 关键：替换 "." 为 "-"。否则像 "2412.13678" 这样的 arxiv ID 拼上时间戳后变成
  // "2412.13678-20260602.md" —— macOS Finder 把 ".13678-..." 当成未知扩展名、
  // 隐藏真正的 .md 后缀，用户感觉文件"没后缀打不开"。
  return (name || t("unnamedTopic"))
    .replace(/[\\/:*?"<>|.]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60) || t("unnamedTopic");
}

// yyyyMMdd-HHmm（按本地时区）
function _formatStamp(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// ── v6 导出：收入笔记的内容，按标签归类 ──────────────────────
// 一条 comment 的消息里，只有 includedInNote !== false 的进导出（用户可逐条取消）。
// 高亮原文（annotation.text）是 comment 的锚，始终导出 —— 划线本身就是一种标记。

// 把一组 messages 里「收入笔记」的渲染成导出行
function _exportMsgLines(messages) {
  const out = [];
  for (const m of (messages || [])) {
    if (!isMsgIncluded(m)) continue;
    const role = m.role === "user" ? t("mdRoleUser") : t("mdRoleAgent");
    const content = (m.role === "user" ? _stripPageTag(msgContent(m)) : msgContent(m)).trim();
    if (!content) continue;
    // main 全文导读不在 blockquote 里，直接平铺加粗角色
    out.push(`**${role}**${LANG === "en" ? ": " : "："}${content}`, "");
  }
  return out;
}

// comment 级是否收入笔记 —— annotation.includedInNote 缺字段视为 true
function isAnnIncluded(ann) {
  return !!ann && ann.includedInNote !== false;
}

// 一条 annotation 的导出行：整块包进 blockquote，模拟预览页 L2/L3 层级缩进
// （quote 是 block 的"锚"，下面 @AI 对话视觉上从属于这条 quote）
function _exportCommentLines(ann, getThread) {
  const out = [];
  const quote = (ann.text || "").replace(/\s+/g, " ").trim();
  out.push(`> "${quote}" — ${annPageLabel(ann)}`);
  const msgs = (getThread(ann.id) || {}).messages || [];
  for (const m of msgs) {
    if (!isMsgIncluded(m)) continue;
    const role = m.role === "user" ? t("mdRoleUser") : t("mdRoleAgent");
    const content = (m.role === "user" ? _stripPageTag(msgContent(m)) : msgContent(m)).trim();
    if (!content) continue;
    out.push(">");
    // 多行内容每行前缀 "> " 才能保持在同一 blockquote 内
    const lines = content.split("\n");
    out.push(`> **${role}**${LANG === "en" ? ": " : "："}${lines[0]}`);
    for (let i = 1; i < lines.length; i++) out.push(`> ${lines[i]}`);
  }
  out.push("");  // 与下一条 ann 之间留空行 → markdown 视觉上分块
  return out;
}

// 构建单篇 PDF 的笔记段落：全文导读 + 高亮 comment
//   anns: 该 PDF 的 annotation 数组；getThread(id) → thread；palette: 主题色板
//   groupMode: "tag"（按标签归类）/ "reading"（按创建时间平铺）
function buildPdfNoteSection(anns, getThread, palette, groupMode = "tag") {
  const lines = [];
  // 1. 全文导读（main comment）—— 有收入笔记的消息才出小节
  const mainMsgs = _exportMsgLines((getThread("main") || {}).messages);
  if (mainMsgs.length) lines.push(t("mdFulltext"), "", ...mainMsgs);

  // 高亮 comment：过滤掉整条取消（ann.includedInNote === false）的
  const included = (anns || []).filter(isAnnIncluded);

  if (groupMode === "reading") {
    // 按创建时间（页码近似）平铺，不分组
    const sorted = [...included].sort(
      (a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0)
    );
    if (sorted.length) lines.push(t("mdHighlightNotes"), "");
    for (const ann of sorted) {
      lines.push(..._exportCommentLines(ann, getThread));
    }
  } else {
    // 按标签归类（palette 顺序；色不在 palette → 末尾「其它」）
    const groups = (palette || []).map((tag) => ({ tag, anns: [] }));
    const other = { tag: null, anns: [] };
    for (const ann of included) {
      const g = groups.find((x) => x.tag.id === ann.color);
      (g || other).anns.push(ann);
    }
    for (const g of [...groups, other]) {
      if (g.anns.length === 0) continue;
      lines.push(g.tag ? `### ${g.tag.emoji} ${displayTagLabel(g.tag)}` : t("mdOther"), "");
      const sorted = [...g.anns].sort(
        (a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0)
      );
      for (const ann of sorted) {
        lines.push(..._exportCommentLines(ann, getThread));
      }
    }
  }
  if (lines.length === 0) lines.push(t("mdEmptyNote"), "");
  return lines;
}

function _exportHeader(title, sub, palette) {
  const lines = [`# ${title}`, ""];
  const now = new Date().toISOString().slice(0, 16).replace("T", " ");
  lines.push(t("mdExportTime", now, sub), "");
  if (palette && palette.length) {
    lines.push(t("mdTagsLine", palette.map((p) => `${p.emoji} ${displayTagLabel(p)}`).join(" / ")), "");
  }
  lines.push("---", "");
  return lines;
}

// 导出整个主题：返回 [{name, text}]，每篇论文一个独立 .md
// 上层调用方把数组打包成 zip 给用户。
async function generateTopicMarkdownFiles(topicId, groupMode = "tag") {
  const topic = state.topics[topicId];
  if (!topic) throw new Error(t("errTopicNotExist"));
  const pdfKeys = topic.pdfKeys || [];
  const palette = topic.palette || [];
  const subGroup = groupMode === "reading" ? t("mdGroupReading") : t("mdGroupTag");
  const files = [];
  const seen = new Map();  // 文件名去重（同名加 -2 / -3 后缀）
  for (const pdfKey of pdfKeys) {
    const title = deriveTitleFromPdfKey(pdfKey);
    let anns, getThread;
    if (pdfKey === state.pdfKey) {
      anns = (state.annotations || []).filter((a) => !a.topicId || a.topicId === topicId);
      getThread = (id) => state.threads[id];
    } else {
      let threadRecs = [];
      anns = [];
      try {
        anns = (await loadAnnotations(pdfKey) || []).filter((a) => !a.topicId || a.topicId === topicId);
      } catch (e) {
        console.warn("[generateTopicMarkdownFiles] loadAnnotations", pdfKey, e);
      }
      try {
        threadRecs = (await loadThreadsByPdfKey(pdfKey) || []).filter((t) => !t.topicId || t.topicId === topicId);
      } catch (e) {
        console.warn("[generateTopicMarkdownFiles] loadThreadsByPdfKey", pdfKey, e);
      }
      const tmap = new Map(threadRecs.map((t) => [t.id, t]));
      getThread = (id) => tmap.get(id);
    }
    const sub = `${t("mdSubTopicPrefix", displayTopicName(topic))}${t("mdSubGroupBody", subGroup)}`;
    const lines = _exportHeader(t("mdNoteTitle", title), sub, palette);
    lines.push(...buildPdfNoteSection(anns, getThread, palette, groupMode));
    const base = _safeFileName(title);
    const dupCount = seen.get(base) || 0;
    seen.set(base, dupCount + 1);
    const fname = dupCount === 0 ? `${base}.md` : `${base}-${dupCount + 1}.md`;
    files.push({ name: fname, text: lines.join("\n") });
  }
  return files;
}

// 导出当前阅读的这一篇（reader 顶栏按钮）—— 直接用内存 state，反映屏幕上的最新勾选
function generateCurrentPdfMarkdown(groupMode = "tag") {
  const topic = state.topics[state.currentTopicId];
  const palette = topic ? topic.palette || [] : [];
  const title = state.pdfTitle || deriveTitleFromPdfKey(state.pdfKey) || t("exportNoteFallback");
  const subGroup = groupMode === "reading" ? t("mdGroupReading") : t("mdGroupTag");
  const sub = `${topic ? t("mdSubTopicPrefix", displayTopicName(topic)) : ""}${t("mdSubGroupBody", subGroup)}`;
  const lines = _exportHeader(t("mdNoteTitle", title), sub, palette);
  lines.push(...buildPdfNoteSection(state.annotations, (id) => state.threads[id], palette, groupMode));
  return lines.join("\n");
}

// 触发浏览器下载一段文本为 .md 文件（topic / 当前篇导出共用）
function _downloadBlob(text, fname) {
  _triggerDownload(new Blob([text], { type: "text/markdown;charset=utf-8" }), fname);
}

function _triggerDownload(blob, fname) {
  let url = null;
  try {
    url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

// 零依赖 ZIP（store mode，不压缩）—— 避免再引外部 CDN lib。
// 主题导出多篇笔记时打成 .zip 给用户，每篇 .md 一个条目，解压后直接拖进
// Obsidian vault 就是一个文件夹。
const _ZIP_CRC32_TABLE = (() => {
  const tab = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    tab[n] = c >>> 0;
  }
  return tab;
})();
function _zipCrc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = _ZIP_CRC32_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
// files: [{ name: string, text: string }]  → Blob (application/zip)
function _makeZipBlob(files) {
  const enc = new TextEncoder();
  const localParts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = enc.encode(f.text);
    const crc = _zipCrc32(data);
    const size = data.length;
    // local file header (30 bytes + name)
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);            // version
    lh.setUint16(6, 0, true);             // flags
    lh.setUint16(8, 0, true);             // method = 0 (stored)
    lh.setUint16(10, 0, true);            // mod time
    lh.setUint16(12, 0, true);            // mod date
    lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true);         // compressed size = size (stored)
    lh.setUint32(22, size, true);         // uncompressed size
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true);            // extra len
    localParts.push(new Uint8Array(lh.buffer), nameBytes, data);
    // central directory entry (46 bytes + name)
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, 0, true);
    cd.setUint16(14, 0, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, size, true);
    cd.setUint32(24, size, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint16(30, 0, true);
    cd.setUint16(32, 0, true);
    cd.setUint16(34, 0, true);
    cd.setUint16(36, 0, true);
    cd.setUint32(38, 0, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), nameBytes);
    offset += 30 + nameBytes.length + size;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const p of central) cdSize += p.length;
  // end of central directory (22 bytes)
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(4, 0, true);
  eocd.setUint16(6, 0, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, cdStart, true);
  eocd.setUint16(20, 0, true);
  return new Blob([...localParts, ...central, new Uint8Array(eocd.buffer)], { type: "application/zip" });
}

// ────────────────────── 导出页 ──────────────────────
// 设计：复用 includedInNote 数据 —— 不另搞导出专属选择。
//   - message.includedInNote（已存在）；annotation.includedInNote（新增字段，缺 = true）
//   - 标签级 = 纯派生批量开关
// 范围 current：当前篇，直接用内存 state（实时、可编辑）。
// 范围 topic：当前篇用 state；其余 pdfKey 载入成「可编辑工作集」（annsByKey/threadsByKey），
//   勾选改动写回该工作集 + saveAnnotations / saveThread 持久化。
const exportState = {
  fromView: "reader",   // 来时的视图："reader" / "topicPage"
  topicId: "default",
  scope: "current",     // "current" / "topic"
  group: "tag",         // "tag" / "reading"
  hasCurrent: false,    // 是否有「当前在读的篇」
  // topic 范围的非当前篇工作集
  annsByKey: {},        // pdfKey → annotation[]
  threadsByKey: {},     // pdfKey → Map(threadId → threadRecord)
};

// 进入导出页。opts.from = "reader" / "topicPage"
async function switchToExportPage(opts = {}) {
  if (state.abortCtl) state.abortCtl.abort();
  _hideAllViews();
  hideTopicCardMenu();
  els.exportPage.classList.add("active");
  state.view = "exportPage";

  exportState.fromView = opts.from || "reader";
  exportState.topicId = state.currentTopicId || DEFAULT_TOPIC_ID;
  exportState.hasCurrent = !!state.pdf && !!state.pdfKey;
  exportState.scope = exportState.fromView === "reader" && exportState.hasCurrent
    ? "current" : "topic";
  // 埋点：只发范围类型，不发笔记内容
  track("export_opened", { range: exportState.scope });
  exportState.group = "tag";
  exportState.annsByKey = {};
  exportState.threadsByKey = {};

  // 同步设置条 radio
  for (const r of document.querySelectorAll('input[name="exportScope"]')) {
    r.checked = r.value === exportState.scope;
    // 没有当前在读的篇 → 禁用「当前篇」选项
    if (r.value === "current") r.disabled = !exportState.hasCurrent;
  }
  for (const r of document.querySelectorAll('input[name="exportGroup"]')) {
    r.checked = r.value === exportState.group;
  }
  await refreshExportPreview();
}

// 加载 topic 范围下「非当前篇」的 annotation / thread 工作集（可编辑、可写回）
async function _loadExportTopicWorkset() {
  const topic = state.topics[exportState.topicId];
  if (!topic) return;
  for (const pdfKey of (topic.pdfKeys || [])) {
    if (pdfKey === state.pdfKey) continue;        // 当前篇用 state，跳过
    if (exportState.annsByKey[pdfKey]) continue;  // 已载入
    try {
      const anns = (await loadAnnotations(pdfKey) || [])
        .filter((a) => !a.topicId || a.topicId === exportState.topicId);
      exportState.annsByKey[pdfKey] = anns;
    } catch (e) {
      console.warn("[export workset] loadAnnotations", pdfKey, e);
      exportState.annsByKey[pdfKey] = [];
    }
    try {
      const recs = (await loadThreadsByPdfKey(pdfKey) || [])
        .filter((t) => !t.topicId || t.topicId === exportState.topicId);
      exportState.threadsByKey[pdfKey] = new Map(recs.map((t) => [t.id, t]));
    } catch (e) {
      console.warn("[export workset] loadThreadsByPdfKey", pdfKey, e);
      exportState.threadsByKey[pdfKey] = new Map();
    }
  }
}

// 收集导出页要渲染的「篇」列表：{ pdfKey, title, anns, getThread, isCurrent }
async function _collectExportDocs() {
  const docs = [];
  if (exportState.scope === "current") {
    if (!exportState.hasCurrent) return docs;
    docs.push({
      pdfKey: state.pdfKey,
      title: state.pdfTitle || deriveTitleFromPdfKey(state.pdfKey) || t("exportNoteFallback"),
      anns: state.annotations || [],
      getThread: (id) => state.threads[id],
      isCurrent: true,
    });
    return docs;
  }
  // topic 范围
  await _loadExportTopicWorkset();
  const topic = state.topics[exportState.topicId];
  for (const pdfKey of (topic?.pdfKeys || [])) {
    if (pdfKey === state.pdfKey) {
      docs.push({
        pdfKey,
        title: state.pdfTitle || deriveTitleFromPdfKey(pdfKey),
        anns: (state.annotations || []).filter((a) => !a.topicId || a.topicId === exportState.topicId),
        getThread: (id) => state.threads[id],
        isCurrent: true,
      });
    } else {
      const tmap = exportState.threadsByKey[pdfKey] || new Map();
      docs.push({
        pdfKey,
        title: deriveTitleFromPdfKey(pdfKey),
        anns: exportState.annsByKey[pdfKey] || [],
        getThread: (id) => tmap.get(id),
        isCurrent: false,
      });
    }
  }
  return docs;
}

// 持久化某篇的 annotation 改动（current → state；topic 非当前篇 → 工作集已是同一引用）
function _persistExportAnns(doc) {
  saveAnnotations(doc.pdfKey, doc.anns).catch((e) => console.warn("[export saveAnns]", e));
}

// 持久化某篇的 thread 改动
function _persistExportThread(doc, thread) {
  if (!thread || !thread.id) return;
  if (doc.isCurrent) {
    persistThread(thread);   // 当前篇走标准入口（注入 state 上下文）
  } else {
    const rec = {
      ...thread,
      pdfKey: doc.pdfKey,
      topicId: thread.topicId || exportState.topicId,
    };
    saveThread(rec).catch((e) => console.warn("[export saveThread]", e));
  }
}

// 渲染导出页预览树
async function refreshExportPreview() {
  const box = els.exportPreview;
  box.replaceChildren();
  const palette = state.topics[exportState.topicId]?.palette || [];
  let docs;
  try {
    docs = await _collectExportDocs();
  } catch (e) {
    console.error("[refreshExportPreview]", e);
    const err = document.createElement("p");
    err.className = "export-empty";
    err.textContent = t("exportPreviewFailed");
    box.appendChild(err);
    return;
  }
  if (docs.length === 0) {
    const empty = document.createElement("p");
    empty.className = "export-empty";
    empty.textContent = t("exportNothing");
    box.appendChild(empty);
    return;
  }
  for (const doc of docs) {
    const titleEl = document.createElement("div");
    titleEl.className = "export-doc-title";
    titleEl.textContent = t("mdExportTitlePrefix", doc.title);
    box.appendChild(titleEl);
    box.appendChild(_renderExportDocTree(doc, palette));
  }
}

// 一条 message 行
function _exportMsgRow(doc, thread, m, msgIndex) {
  const row = document.createElement("div");
  row.className = "export-msg" + (isMsgIncluded(m) ? "" : " export-row-off");
  const label = document.createElement("label");
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = isMsgIncluded(m);
  cb.addEventListener("change", () => {
    m.includedInNote = cb.checked;
    _persistExportThread(doc, thread);
    refreshExportPreview();
  });
  const role = document.createElement("span");
  role.className = "export-msg-role";
  role.textContent = m.role === "user" ? t("roleUserColon") : t("roleAgentColon");
  const txt = document.createElement("span");
  txt.className = "export-msg-text";
  txt.textContent = (m.role === "user" ? _stripPageTag(msgContent(m)) : msgContent(m)).trim();
  label.append(cb, role, txt);
  row.appendChild(label);
  return row;
}

// 一条 comment（annotation）块：原文行 + 它的消息
function _exportCommentBlock(doc, ann, palette, showInlineTag) {
  const wrap = document.createElement("div");
  wrap.className = "export-comment";
  const off = !isAnnIncluded(ann);

  const head = document.createElement("div");
  head.className = "export-comment-head" + (off ? " export-row-off" : "");
  const label = document.createElement("label");
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = !off;
  cb.addEventListener("change", () => {
    ann.includedInNote = cb.checked;
    _persistExportAnns(doc);
    refreshExportPreview();
  });
  // 阅读顺序模式：comment 行内显示小色块标签
  if (showInlineTag) {
    const tag = palette.find((t) => t.id === ann.color);
    const sw = document.createElement("span");
    sw.className = "export-swatch";
    sw.style.background = tag?.color || PALETTE_HEX[ann.color] || "#bbb";
    label.append(cb, sw);
  } else {
    label.appendChild(cb);
  }
  const quote = document.createElement("span");
  quote.className = "export-quote";
  quote.textContent = `"${(ann.text || "").replace(/\s+/g, " ").trim()}"`;
  const page = document.createElement("span");
  page.className = "export-page-label";
  page.textContent = annPageLabel(ann);
  label.append(quote, page);
  head.appendChild(label);
  wrap.appendChild(head);

  // comment 的消息
  const thread = doc.getThread(ann.id);
  const msgs = (thread && thread.messages) || [];
  msgs.forEach((m, i) => {
    if (off) return;  // 整条取消 → 不展开消息（取消即整组灰掉）
    const content = (m.role === "user" ? _stripPageTag(msgContent(m)) : msgContent(m)).trim();
    if (!content) return;
    wrap.appendChild(_exportMsgRow(doc, thread, m, i));
  });
  return wrap;
}

// main「全文导读」块：comment 级勾选 = 它所有消息的批量开关（派生态）
function _exportMainBlock(doc) {
  const thread = doc.getThread("main");
  const msgs = (thread && thread.messages) || [];
  const real = msgs.filter((m) => {
    const c = (m.role === "user" ? _stripPageTag(msgContent(m)) : msgContent(m)).trim();
    return !!c;
  });
  if (real.length === 0) return null;

  const allOn = real.every((m) => isMsgIncluded(m));
  const group = document.createElement("div");
  group.className = "export-group";
  const headRow = document.createElement("div");
  headRow.className = "export-group-head";
  const label = document.createElement("label");
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = allOn;
  cb.addEventListener("change", () => {
    for (const m of real) m.includedInNote = cb.checked;
    _persistExportThread(doc, thread);
    refreshExportPreview();
  });
  const name = document.createElement("span");
  name.textContent = t("exportFulltextGroup");
  label.append(cb, name);
  headRow.appendChild(label);
  group.appendChild(headRow);
  for (const m of real) {
    const i = msgs.indexOf(m);
    group.appendChild(_exportMsgRow(doc, thread, m, i));
  }
  return group;
}

// 渲染一篇 PDF 的勾选树
function _renderExportDocTree(doc, palette) {
  const frag = document.createDocumentFragment();
  let any = false;

  // 1. 全文导读
  const mainBlock = _exportMainBlock(doc);
  if (mainBlock) { frag.appendChild(mainBlock); any = true; }

  // 2. 高亮 comment
  if (exportState.group === "reading") {
    const sorted = [...doc.anns].sort(
      (a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0)
    );
    if (sorted.length) {
      const group = document.createElement("div");
      group.className = "export-group";
      for (const ann of sorted) {
        group.appendChild(_exportCommentBlock(doc, ann, palette, true));
      }
      frag.appendChild(group);
      any = true;
    }
  } else {
    // 按标签归类
    const groups = palette.map((tag) => ({ tag, anns: [] }));
    const other = { tag: null, anns: [] };
    for (const ann of doc.anns) {
      const g = groups.find((x) => x.tag.id === ann.color);
      (g || other).anns.push(ann);
    }
    for (const g of [...groups, other]) {
      if (g.anns.length === 0) continue;
      any = true;
      const sorted = [...g.anns].sort(
        (a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0)
      );
      const allOn = sorted.every((a) => isAnnIncluded(a));
      const group = document.createElement("div");
      group.className = "export-group";
      const headRow = document.createElement("div");
      headRow.className = "export-group-head";
      const label = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = allOn;
      cb.addEventListener("change", () => {
        for (const a of sorted) a.includedInNote = cb.checked;
        _persistExportAnns(doc);
        refreshExportPreview();
      });
      if (g.tag) {
        const sw = document.createElement("span");
        sw.className = "export-swatch";
        sw.style.background = g.tag.color || "#bbb";
        const name = document.createElement("span");
        name.textContent = g.tag.label;
        label.append(cb, sw, name);
      } else {
        const name = document.createElement("span");
        name.textContent = t("exportOtherGroup");
        label.append(cb, name);
      }
      headRow.appendChild(label);
      // 〔全选/取消〕
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "export-group-toggle";
      const groupAllOn = sorted.every((a) => isAnnIncluded(a));
      toggle.textContent = groupAllOn ? t("exportDeselectAll") : t("exportSelectAll");
      toggle.addEventListener("click", () => {
        const next = !groupAllOn;
        for (const a of sorted) a.includedInNote = next;
        _persistExportAnns(doc);
        refreshExportPreview();
      });
      headRow.appendChild(toggle);
      group.appendChild(headRow);
      for (const ann of sorted) {
        group.appendChild(_exportCommentBlock(doc, ann, palette, false));
      }
      frag.appendChild(group);
    }
  }

  if (!any) {
    const empty = document.createElement("p");
    empty.className = "export-empty";
    empty.textContent = t("exportEmptyPdf");
    frag.appendChild(empty);
  }
  return frag;
}

// 导出页「下载 .md」
async function downloadFromExportPage() {
  try {
    const stamp = _formatStamp(new Date());
    if (exportState.scope === "current") {
      if (!state.pdf) return;
      const md = generateCurrentPdfMarkdown(exportState.group);
      const base = _safeFileName(state.pdfTitle || deriveTitleFromPdfKey(state.pdfKey) || t("exportNoteFallback"));
      _downloadBlob(md, `${base}-${stamp}.md`);
    } else {
      // 整个主题：每篇论文一个独立 .md，打包成 zip 给用户
      const topic = state.topics[exportState.topicId];
      if (!topic) return;
      const files = await generateTopicMarkdownFiles(exportState.topicId, exportState.group);
      if (files.length === 0) return;
      if (files.length === 1) {
        // 只有一篇 → 直接给 .md，不用 zip 兜个空壳
        _downloadBlob(files[0].text, files[0].name);
      } else {
        const zipBlob = _makeZipBlob(files);
        _triggerDownload(zipBlob, `${_safeFileName(topic.name)}-${stamp}.zip`);
      }
    }
  } catch (e) {
    console.error("[downloadFromExportPage]", e);
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
  // i18n：默认 label / aiHint 按当前语言写入草稿（用户随后可改 → 变成用户数据）
  ntmDraft.paletteDraft = DEFAULT_PALETTE.map((p) => ({
    ...p,
    label: DEFAULT_TAG_LABELS[p.id] ? DEFAULT_TAG_LABELS[p.id][LANG] : p.label,
    ...(p.aiHint != null && DEFAULT_TAG_AIHINTS[p.id]
      ? { aiHint: DEFAULT_TAG_AIHINTS[p.id][LANG] }
      : {}),
  }));
  els.ntmNameInput.value = "";
  els.newTopicModal.hidden = false;
  ntmRenderStep();
  setTimeout(() => els.ntmNameInput.focus(), 50);
}
function closeNewTopicModal() {
  els.newTopicModal.hidden = true;
  // 首次使用时用户没建主题就关掉 modal → 兜底建默认主题，别让 app 处于"无 topic"状态
  if (_isFirstRun && !state.topics[DEFAULT_TOPIC_ID]) {
    _isFirstRun = false;
    ensureDefaultTopic().catch((e) => console.warn("[firstRun fallback]", e));
  }
}

function ntmRenderStep() {
  // 显示对应 step
  els.ntmStep1.classList.toggle("active", ntmDraft.step === 1);
  els.ntmStep2.classList.toggle("active", ntmDraft.step === 2);
  els.ntmStep3.classList.toggle("active", ntmDraft.step === 3);
  els.ntmStepIndicator.textContent = t("ntmStepIndicator", ntmDraft.step);

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
    em.className = "ntm-swatch";
    em.style.background = p.color || "#b8b8b8";
    em.title = t("ntmTagColorTitle");

    const lb = document.createElement("input");
    lb.type = "text";
    lb.maxLength = 20;
    lb.placeholder = t("ntmTagPlaceholder");
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
    del.title = t("ntmDelRowTitle");
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
    label: t("ntmNewTagLabel"),
    color: nextColor,
  });
  ntmRenderPaletteEditor();
  ntmUpdateNextEnabled();
}

function ntmRenderConfirm() {
  els.ntmConfirmName.textContent = ntmDraft.name || t("ntmUnnamedName");
  els.ntmConfirmPalette.replaceChildren();
  for (const p of ntmDraft.paletteDraft) {
    const row = document.createElement("div");
    row.className = "ntm-cp-row";
    const sw = document.createElement("span");
    sw.className = "ntm-cp-swatch";
    sw.style.background = p.color;
    const lb = document.createElement("span");
    lb.textContent = (isDefaultTag(p) ? displayTagLabel(p) : p.label) || t("ntmUnnamedTag");
    row.appendChild(sw);
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
  // 首次使用：这一个主题就是「默认主题」(id=default)，让首页粘链接等照常落到 default
  const firstRun = _isFirstRun && !state.topics[DEFAULT_TOPIC_ID];
  els.ntmConfirm.disabled = true;
  try {
    const topic = await createTopic(
      firstRun ? { name, palette, id: DEFAULT_TOPIC_ID } : { name, palette }
    );
    // 埋点：纯行为信号，不发主题名 / palette 内容
    track("topic_created");
    if (firstRun) _isFirstRun = false;   // 必须在 closeNewTopicModal 前清，否则触发兜底
    closeNewTopicModal();
    if (firstRun) switchToHome();         // 首次：回首页，让用户粘链接开始读
    else switchToTopicPage(topic.id);     // 平时：进新主题页
  } catch (e) {
    console.error("[createTopic]", e);
    setLandingStatus(t("createTopicFailed", e.message || e), true);
  } finally {
    els.ntmConfirm.disabled = false;
  }
}

// ────────────────────── 事件绑定 ──────────────────────
// v3-β: 主题页 "添加论文" 表单——把 URL / 文件加到当前主题
// 首页：粘贴链接 / 选本地 PDF → 直接进 reader，论文归入默认主题
els.homeLoadForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = els.homeUrlInput.value.trim();
  if (!url) return;
  els.homeUrlInput.value = "";
  await loadPdf({ url, topicId: DEFAULT_TOPIC_ID });
});
els.homeFileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (file) await loadPdf({ file, topicId: DEFAULT_TOPIC_ID });
});
els.homeManageBtn.addEventListener("click", () => switchToTopicList());
els.homeRecent.addEventListener("click", (e) => {
  const card = e.target.closest(".home-recent-item");
  if (card) openPdfFromTopic(card.dataset.topicId, card.dataset.pdfKey);
});

// 语言切换控件（仅首页）
for (const sw of [els.langSwitchHome]) {
  if (!sw) continue;
  sw.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-lang]");
    if (btn) switchLang(btn.dataset.lang);
  });
}

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

// 主题页大标题点击 → inline 重命名（任何主题，含默认）
els.tpName.addEventListener("click", (e) => {
  if (e.target.closest("input")) return;
  if (state.currentTopicId) startEditTpName(state.currentTopicId);
});

// v6：thread 切换器事件绑定已退休 —— 右栏 comment 列表的事件委托见下方「v6 comment 列表事件绑定」段

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
// 串行 await：50+ 页大 PDF 会卡 5-10 秒，日常论文 < 30 页可接受；分批 lazy 留 v3.1
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
    wrap.setAttribute("aria-label", t("thumbPageAria", i));

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
  els.zoomLevel.textContent = `${pct}%`;
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

// v5-fix（Bug 1 抖动）：打字时 **只** 做 dropdown 预览，绝不碰 PDF 页面。
//   旧路径在 input 实时事件里 dispatchFind("") → pdf.js find → 自动 scroll 到匹配，
//   用户每打一个字就滚一次 = 整页乱抖。
//   正确语义（"还没回车前先出现下拉框预览"）：
//     - input 阶段：纯 grep dropdown 预览，不 dispatch pdf.js find / 不高亮 / 不滚动
//     - 只有 Enter / 点 dropdown 结果 时，才 dispatchFind → 页内高亮 + 跳转
//   _findDispatchedQuery 记录"已经 dispatch 给 pdf.js find 的 query"，
//   用于判断 Enter 是首次新查询（dispatchFind）还是同查询找下一个（findAgain）。
let _findDispatchedQuery = null;
els.findInput.addEventListener("input", () => {
  // 打字阶段查询变了 → pdf.js 那边的搜索状态已经过时。
  // 若之前对某个 query dispatch 过 pdf.js find，页内还留着它的淡色高亮——query 一变
  // 这些高亮就过时了，必须清掉（否则删空/改写搜索框后旧高亮永久残留）。
  if (_findDispatchedQuery !== null) clearFindHighlights();
  _findDispatchedQuery = null;
  // v5：实时下拉预览 —— debounce 250ms，避免快速打字每键都搜 pdfText
  if (_findDebounceTimer) clearTimeout(_findDebounceTimer);
  const query = els.findInput.value.trim();
  if (!query) { hideFindDropdown(); return; }
  _findDebounceTimer = setTimeout(() => renderFindDropdown(query), 250);
});
els.findInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const query = els.findInput.value.trim();
    if (!query) return;   // 空 query 回车 → 什么都不做（不崩）
    if (query === _findDispatchedQuery) {
      // 同一个查询再次回车 → 找下一个 / 上一个匹配（锁定水平 scrollLeft）
      withPreservedScrollLeft(() => findAgain(e.shiftKey));
    } else {
      // 首次对这个 query 回车 → 新查询：dispatch pdf.js find（页内高亮 + 跳第一个匹配）
      _findDispatchedQuery = query;
      withPreservedScrollLeft(() => dispatchFind(""));
    }
  } else if (e.key === "Escape") {
    e.preventDefault();
    _findDispatchedQuery = null;
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
// ══════ v6 comment 列表（右栏）事件绑定 ══════
// 全部事件委托挂在 #commentList 上 —— 卡片每次 renderCommentList 都整体重建

els.commentList.addEventListener("click", (e) => {
  const card = e.target.closest(".cmt-card");
  if (!card) return;
  const commentId = card.dataset.commentId;

  // 删除 comment（🗑）
  if (e.target.closest(".cc-del")) {
    e.stopPropagation();
    const ann = state.annotations.find((a) => a.id === commentId);
    if (!ann) return;
    const n = state.threads[commentId] ? state.threads[commentId].messages.length : 0;
    const ok = window.confirm(t("confirmDeleteComment", n));
    if (ok) deleteAnnotation(commentId);
    return;
  }
  // 级别 2 折叠 toggle：展开折起的中间轮次
  if (e.target.closest(".cc-fold-toggle")) {
    state.cmtShowAll.add(commentId);
    renderCommentList();
    return;
  }
  // 引用回链 〔p.N〕→ 跳页 + flash（逻辑同旧 chatMessages 委托）
  const link = e.target.closest(".cite-link");
  if (link) {
    e.preventDefault();
    const pageNum = parseInt(link.dataset.page, 10);
    if (!pageNum || !state.pdf) return;
    if (pageNum < 1 || pageNum > state.totalPages) {
      console.debug("[cite-link] page out of range:", pageNum, "total=" + state.totalPages);
      return;
    }
    const prevScrollLeft = els.viewerContainer.scrollLeft;
    try {
      pdfViewer.scrollPageIntoView({ pageNumber: pageNum });
    } catch (err) {
      console.debug("[cite-link] scrollPageIntoView failed:", err);
      return;
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { els.viewerContainer.scrollLeft = prevScrollLeft; });
    });
    flashPage(pageNum);
    return;
  }
  // 点卡片头 → 展开 / 收起（点卡片体内不触发）
  if (e.target.closest(".cmt-card-head")) toggleComment(commentId);
});

// 卡片头键盘可达性 + 卡片内输入框 Enter 提交
els.commentList.addEventListener("keydown", (e) => {
  const head = e.target.closest(".cmt-card-head");
  if (head && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    toggleComment(head.closest(".cmt-card").dataset.commentId);
    return;
  }
  // Enter 提交批注 / Shift+Enter 换行；中文 IME 组合中的 Enter 不提交
  if (e.target.matches(".cc-input textarea")
      && e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    e.target.closest("form").requestSubmit();
  }
});

// 「收入笔记」勾选切换
els.commentList.addEventListener("change", (e) => {
  const cb = e.target.closest('input[data-action="toggle-note"]');
  if (!cb) return;
  toggleMsgIncluded(cb.closest(".cmt-card").dataset.commentId, Number(cb.dataset.msgIndex));
});

// 卡片内输入框提交：含 @AI → 召唤 AI；否则纯批注。流式中点「停止」= abort。
els.commentList.addEventListener("submit", (e) => {
  const form = e.target.closest(".cc-input");
  if (!form) return;
  e.preventDefault();
  const commentId = form.dataset.commentId;
  if (state.streaming) {
    if (commentId === state.streamingCommentId) state.abortCtl?.abort();
    return;
  }
  const text = (form.querySelector("textarea")?.value || "").trim();
  if (!text) return;
  routeCommentInput(commentId, text, "card");  // 内部会 renderCommentList 重建 DOM
  // 纯批注（未进流式）→ 重建后焦点还给新输入框，方便连续记多条
  if (!state.streaming) {
    const ta = els.commentList.querySelector(`.cmt-card[data-comment-id="${commentId}"] .cc-input textarea`);
    ta && ta.focus();
  }
});

// 卡片内输入框 auto-grow
els.commentList.addEventListener("input", (e) => {
  if (e.target.matches(".cc-input textarea")) autoGrow(e.target);
});

// ────────────────────── v2-a 事件绑定 ──────────────────────

// mouseup on viewer：判断是否有选区 → 浮出色板
// 注意：mouseup 在选区刚定下来的下一帧才能可靠拿到 selection，用 setTimeout 0
// 不监听 selectionchange —— 它在拖选过程中疯狂触发，会反复闪
els.viewerContainer.addEventListener("mouseup", (e) => {
  // 点在色板上不重新判断（让它自己的 click handler 处理）
  if (e.target.closest("#colorPalette")) return;
  // 点击高亮 rect —— 由 rect 自己的 click handler 处理，不抢
  if (e.target.closest && e.target.closest(".hl-rect")) return;
  // v3-polish-4 #3：选段卡顿排查 —— 标记 mouseup → palette 整条路径耗时
  // 用户反馈"选段没选中似乎有点卡顿"。用 console.time/timeEnd 让 test 抓样本，
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

// v6：点 PDF 高亮 → 右栏展开对应 comment（b 方案；旧的 hl-bubble 已退休）
// 用事件委托（rect 是动态创建的）
els.viewerContainer.addEventListener("click", (e) => {
  const rect = e.target.closest(".hl-rect");
  if (!rect) return;
  e.stopPropagation();
  const annId = rect.dataset.annId;
  // scrollPdf:false —— 高亮就在用户眼前，没必要再滚 PDF；只展开右栏 + flash
  expandComment(annId, { scrollPdf: false });
  flashAnnotation(annId);
});

// 点 viewer 之外（如右栏）→ 关闭色板；点浮出 comment 框之外 → 收起浮框（不填走掉 = 纯高亮）
document.addEventListener("mousedown", (e) => {
  // 收起浮出 comment 框：点的不是浮框自身、不是色板、也不是 @ 联想下拉
  // （.mention-dropdown 挂在 body 上、不在 #cmtCompose 里 —— 不排除的话点它选 @AI 会误收浮框）
  if (!e.target.closest("#cmtCompose") && !e.target.closest("#colorPalette")
      && !e.target.closest(".mention-dropdown")) hideCmtCompose();
  if (e.target.closest("#colorPalette")) return;
  if (e.target.closest(".hl-rect")) return;
  // 点击不在 viewer 内 → 直接关色板（viewer 内由 mouseup 决定）
  if (!els.viewerContainer.contains(e.target)) hideColorPalette();
});

// ══════ 引用 / Cite 事件绑定 ══════
els.readerCiteBtn.addEventListener("click", () => { openCiteModal(); });
els.citeClose.addEventListener("click", closeCiteModal);
els.citeModal.addEventListener("click", (e) => {
  if (e.target === els.citeModal) closeCiteModal();
});
for (const inp of [els.citeTitleInput, els.citeAuthorsInput, els.citeYearInput,
                    els.citeVenueInput, els.citeDoiInput]) {
  inp.addEventListener("input", citeOnInput);
}
els.citeFormatSel.addEventListener("click", (e) => {
  const btn = e.target.closest(".cite-fmt-btn");
  if (!btn) return;
  _citeCurrentFmt = btn.dataset.fmt;
  els.citeFormatSel.querySelectorAll(".cite-fmt-btn").forEach((b) => {
    const on = b === btn;
    b.classList.toggle("active", on);
    b.setAttribute("aria-checked", on ? "true" : "false");
  });
  citeRenderOutput();
});
els.citeCopyBtn.addEventListener("click", async () => {
  const text = els.citeOutput.textContent || "";
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    // 剪贴板 API 不可用（非 HTTPS / 权限）→ 退回 execCommand
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (_) {}
    ta.remove();
  }
  track("cite_copy", { fmt: _citeCurrentFmt });
  _citeCopiedFlash = true;
  els.citeCopyBtn.textContent = t("citeCopiedBtn");
  setTimeout(() => {
    _citeCopiedFlash = false;
    els.citeCopyBtn.textContent = t("citeCopyBtn");
  }, 1500);
});

// ══════ v6 划线浮出 comment 框 事件绑定 ══════
els.cmtComposeSend.addEventListener("click", submitCmtCompose);
els.cmtComposeInput.addEventListener("input", () => autoGrow(els.cmtComposeInput));
els.cmtComposeInput.addEventListener("keydown", (e) => {
  // Enter 发送 / Shift+Enter 换行（中文 IME 组合中的 Enter 不发送）
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submitCmtCompose();
  } else if (e.key === "Escape") {
    // Esc = 不填走掉（纯高亮保留）
    e.preventDefault();
    hideCmtCompose();
  }
});

// 滚动时：高亮跟随 .page 自动走（百分比定位），但浮动色板不跟随 → 直接收起
els.viewerContainer.addEventListener("scroll", () => {
  if (!els.colorPalette.hidden) hideColorPalette();
}, { passive: true });

// ────────────────────── v3-β 事件绑定 ──────────────────────

// 主题列表 "+ 新建主题"
els.newTopicBtn.addEventListener("click", openNewTopicModal);

// 主题页 "←" 返回主题列表
els.topicBack.addEventListener("click", () => switchToTopicList());

// 主题列表 "← 首页"
els.topicListBack.addEventListener("click", () => switchToHome());

// 导出整个主题（主题页底部按钮）—— 打开导出页（范围默认整个主题）
els.tpExportBtn.addEventListener("click", () => {
  if (els.tpExportBtn.disabled) return;
  switchToExportPage({ from: "topicPage" });
});

// 导出当前阅读这一篇（reader 顶栏按钮）—— 打开导出页（范围默认当前篇）
els.readerExportBtn.addEventListener("click", () => {
  switchToExportPage({ from: "reader" });
});

// 导出页：← 返回来时的视图
els.exportBack.addEventListener("click", () => {
  if (exportState.fromView === "topicPage") {
    switchToTopicPage(exportState.topicId);
  } else {
    switchToReader();
  }
});

// 导出页：下载 .md
els.exportDownloadBtn.addEventListener("click", () => {
  downloadFromExportPage();
});

// 导出页：范围 / 分组设置条 —— 改即刷新预览
document.querySelectorAll('input[name="exportScope"]').forEach((r) => {
  r.addEventListener("change", async () => {
    if (!r.checked) return;
    exportState.scope = r.value;
    await refreshExportPreview();
  });
});
document.querySelectorAll('input[name="exportGroup"]').forEach((r) => {
  r.addEventListener("change", async () => {
    if (!r.checked) return;
    exportState.group = r.value;
    await refreshExportPreview();
  });
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
    const next = window.prompt(t("promptRenameTopic"), cur);
    if (next == null) return;            // 取消
    const trimmed = next.trim().slice(0, 30);
    if (!trimmed || trimmed === cur) return;
    await renameTopic(id, trimmed);
    renderTopicGrid();
  } else if (action === "delete") {
    const topic = state.topics[id];
    if (!topic) return;
    const n = (topic.pdfKeys || []).length;
    const ok = window.confirm(t("confirmDeleteTopic", displayTopicName(topic), n));
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

// ESC 关 modal / "..." 菜单
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!els.citeModal.hidden) { closeCiteModal(); return; }
  if (!els.newTopicModal.hidden) { closeNewTopicModal(); return; }
  if (!els.topicCardMenu.hidden) { hideTopicCardMenu(); return; }
});

// ══════ @ 自动联想（comment 输入框）══════
// 用户在 comment 输入框打 `@` → 浮出候选下拉。首版只一个候选 @AI。
// 适用：右栏卡片内 .cc-input textarea（每次 renderCommentList 重建 → 事件委托）
//       + 划线浮框 #cmtComposeInput。
// 锚定到 textarea 元素本身（position:fixed + getBoundingClientRect），不算光标像素坐标。
const mention = (() => {
  // 候选表 —— 结构上可扩展，首版只放 @AI（@多角色 是后期功能，不做）
  const CANDIDATES = [
    { insert: "AI", label: "@AI", hintKey: "mentionAiHint" },
  ];

  const dropdown = document.createElement("div");
  dropdown.className = "mention-dropdown";
  dropdown.setAttribute("role", "listbox");
  dropdown.setAttribute("aria-label", t("mentionAria"));
  dropdown.hidden = true;
  document.body.appendChild(dropdown);

  let activeInput = null;   // 当前关联的 textarea
  let items = [];           // 当前过滤后的候选
  let sel = 0;              // 高亮项索引
  let atPos = -1;           // `@` 在 value 里的位置

  // 判断 textarea 是否是受管输入框
  function isManaged(el) {
    return el && el.matches && (el.matches(".cc-input textarea") || el.id === "cmtComposeInput");
  }

  // 从光标往回找最近的 `@token`：返回 {at, query} 或 null
  // 规则：`@` 前是行首或空白；`@` 到光标之间不含空白（含空白即视为已选完/无效）
  function scanAt(el) {
    const pos = el.selectionStart;
    if (pos == null || pos !== el.selectionEnd) return null;
    const v = el.value;
    let i = pos - 1;
    while (i >= 0) {
      const ch = v[i];
      if (ch === "@") {
        const before = i === 0 ? "" : v[i - 1];
        if (before === "" || /\s/.test(before)) {
          return { at: i, query: v.slice(i + 1, pos) };
        }
        return null;
      }
      if (/\s/.test(ch)) return null;
      i -= 1;
    }
    return null;
  }

  function place() {
    if (!activeInput) return;
    const r = activeInput.getBoundingClientRect();
    // 锚到输入框左边缘；下拉宽度由内容决定（不撑满输入框，不算光标坐标）
    dropdown.hidden = false; // 需先可见才能量尺寸
    const w = dropdown.offsetWidth;
    let left = r.left;
    if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - w);
    dropdown.style.left = left + "px";
    // 默认浮在输入框上方；上方空间不够则放下方
    const h = dropdown.offsetHeight;
    if (r.top - h - 4 >= 0) {
      dropdown.style.top = (r.top - h - 4) + "px";
    } else {
      dropdown.style.top = (r.bottom + 4) + "px";
    }
  }

  function render() {
    dropdown.replaceChildren();
    items.forEach((c, idx) => {
      const row = document.createElement("div");
      row.className = "mention-item" + (idx === sel ? " active" : "");
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", idx === sel ? "true" : "false");
      row.dataset.idx = String(idx);
      const name = document.createElement("span");
      name.className = "mention-name";
      name.textContent = c.label;
      const hint = document.createElement("span");
      hint.className = "mention-hint";
      hint.textContent = t(c.hintKey);
      row.append(name, hint);
      dropdown.appendChild(row);
    });
    place();
  }

  function open(el) {
    activeInput = el;
    render();
  }

  function close() {
    dropdown.hidden = true;
    activeInput = null;
    items = [];
    atPos = -1;
  }

  function isOpen() { return !dropdown.hidden; }

  // 输入时重新扫描：有合法 @token 且有匹配候选 → 开/更新；否则关
  function refresh(el) {
    const m = scanAt(el);
    if (!m) { if (isOpen()) close(); return; }
    const q = m.query.toLowerCase();
    const matched = CANDIDATES.filter((c) => c.insert.toLowerCase().startsWith(q));
    if (matched.length === 0) { if (isOpen()) close(); return; }
    atPos = m.at;
    items = matched;
    sel = Math.min(sel, items.length - 1);
    if (sel < 0) sel = 0;
    open(el);
  }

  // 选中：把 value 里 `@query` 段替换成 `@AI `（含尾随空格）
  function choose(idx) {
    if (!activeInput || atPos < 0) { close(); return; }
    const el = activeInput;
    const cand = items[idx];
    if (!cand) { close(); return; }
    const v = el.value;
    const end = el.selectionStart;
    const insert = "@" + cand.insert + " ";
    el.value = v.slice(0, atPos) + insert + v.slice(end);
    const caret = atPos + insert.length;
    el.setSelectionRange(caret, caret);
    close();
    autoGrow(el);
    el.focus();
  }

  // keydown：方向键 / Enter / Tab / Esc。返回 true = 已消费（调用方应 preventDefault）
  function handleKeydown(e) {
    if (!isOpen() || e.target !== activeInput) return false;
    if (e.key === "ArrowDown") {
      sel = (sel + 1) % items.length; render(); return true;
    }
    if (e.key === "ArrowUp") {
      sel = (sel - 1 + items.length) % items.length; render(); return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      choose(sel); return true;
    }
    if (e.key === "Escape") {
      close(); return true;
    }
    return false;
  }

  // 下拉用 mousedown 选中（mousedown 早于 blur，避免输入框失焦先关掉下拉）
  dropdown.addEventListener("mousedown", (e) => {
    const row = e.target.closest(".mention-item");
    if (!row) return;
    e.preventDefault();      // 不让输入框失焦
    choose(Number(row.dataset.idx));
  });

  return { isManaged, refresh, handleKeydown, close, isOpen };
})();
// 点别处收起
document.addEventListener("mousedown", (e) => {
  if (!mention.isOpen()) return;
  if (e.target.closest(".mention-dropdown")) return;
  if (e.target === document.activeElement && mention.isManaged(e.target)) return;
  mention.close();
}, true);
// 委托：受管输入框的 input → 刷新联想
document.addEventListener("input", (e) => {
  if (mention.isManaged(e.target)) mention.refresh(e.target);
}, true);
// 委托：受管输入框的 keydown → 联想开着时方向键 / Enter / Tab / Esc 优先给联想
// 用 capture 抢在 #commentList / #cmtComposeInput 的 keydown handler 之前
document.addEventListener("keydown", (e) => {
  if (!mention.isManaged(e.target)) return;
  if (mention.handleKeydown(e)) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);
// 焦点离开受管输入框（切到非下拉元素）→ 收起
document.addEventListener("focusout", (e) => {
  if (mention.isManaged(e.target)) {
    // 延后一拍：若焦点落到下拉项的 mousedown 上则不关（mousedown 已 preventDefault）
    setTimeout(() => { if (mention.isOpen() && document.activeElement !== e.target) mention.close(); }, 0);
  }
});

// 启动即把静态 HTML 文案按持久化语言渲染一遍（DOM 已就绪——app.js 在 body 末尾加载）
applyStaticI18n();

// 启动后渲染主题列表：等 bootstrap 完成（加载完所有 topics）
// bootstrap 失败时 state.topics 至少有内存兜底的 default
_bootstrapPromise.then(() => {
  // 首次使用：弹 3 步「新建主题」modal，让用户确认色卡含义、建第一个（=默认）主题
  if (_isFirstRun) {
    switchToHome();
    openNewTopicModal();
    return;
  }
  // 二次兜底：bootstrap 跑完，state.topics 仍空时塞个默认（极端 IDB 故障）
  if (Object.keys(state.topics).length === 0) {
    state.topics[DEFAULT_TOPIC_ID] = {
      id: DEFAULT_TOPIC_ID,
      name: "示例主题",
      palette: DEFAULT_PALETTE.map((p) => ({ ...p })),
      pdfKeys: [],
      createdAt: new Date().toISOString(),
    };
  }
  switchToHome();
});
