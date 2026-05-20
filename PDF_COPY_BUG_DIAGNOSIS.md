# PDF 复制 bug 诊断报告

## TL;DR

**真正的根因：`app.js` 把 `textLayerMode` 设成了 `2` (`TextLayerMode.ENABLE_PERMISSIONS`)，pdf.js 在该模式下会无条件 `event.preventDefault() + stopPropagation()`，把整个 copy event 截掉、clipboardData 永远是空字符串。**

跟字体 / cMap / CSS / textLayer 渲染**都没关系**。dev 上一轮加的 `cMapUrl + standardFontDataUrl` 修复方向完全错了，对这条 bug 零作用。

---

## CDN 验证

| URL | HTTP | 备注 |
|---|---|---|
| `cdnjs/.../4.6.82/pdf_viewer.min.css` | **200** | 在根目录（不在 `/web/` 子目录），index.html line 8 引用路径**正确** |
| `cdnjs/.../4.6.82/pdf.min.mjs` | 200 | OK |
| `cdnjs/.../4.6.82/pdf.worker.min.mjs` | 200 | OK |
| `cdnjs/.../4.6.82/cmaps/Adobe-CNS1-UCS2.bcmap` | **403** | cdnjs 4.6.82 dist 没带 cmaps/ 目录 |
| `cdnjs/.../4.6.82/standard_fonts/FoxitSans.pfb` | **403** | 同上，cdnjs 没有这个目录 |
| `unpkg.com/pdfjs-dist@4.6.82/cmaps/Adobe-CNS1-UCS2.bcmap` | **200**（40.2KB） | unpkg 上有 |
| `jsdelivr.com/.../4.6.82/cmaps/Adobe-CNS1-UCS2.bcmap` | **200**（40.2KB） | jsdelivr 上有 |
| `unpkg/jsdelivr ...standard_fonts/FoxitSans.pfb` | 404 | 这个具体文件名本来就不存在（实际是 FoxitSerif/FoxitFixed/LiberationSans 等），不算坏路径 |

结论：dev 上一轮把 `cMapUrl/standardFontDataUrl` 都指到 cdnjs，cdnjs 是 403，路径就是坏的。但**这跟当前的复制 bug 无关**——这次测试样本（arxiv Clio 论文）是纯 Latin 字体，pdf.js **根本没发起任何 cmap/standard_fonts 请求**（实测 network log：0 个相关请求，0 个 console 警告）。dev 修了一个不存在的问题，且修错了。

---

## Selection API 实测（关键证据）

把第一页 textLayer 的前 3 个 span 通过 Range API 选中：

```
sel.toString()                = "Clio: Privacy-Preserving Insights\ninto Real-World AI Use\nAlex Tamkin"
sel.toString().length         = 68
sel.rangeCount                = 1
sel.getRangeAt(0).toString()  = "Clio: Privacy-Preserving Insightsinto Real-World AI UseAlex Tamkin"
```

**Selection 完全正常**，ASCII 干净，无乱码。

---

## textLayer DOM 实察（关键证据）

```html
<span role="presentation" dir="ltr"
      style="left: 29.98%; top: 12.53%; font-size: calc(var(--scale-factor)*17.22px);
             font-family: sans-serif; transform: scaleX(0.988979);">Clio: Privacy-Preserving Insights</span>
<span ...>into Real-World AI Use</span>
<span ...>Alex Tamkin</span>
```

textLayer **80 个 span 全部正常渲染**，每个 span 的 textContent 是干净 ASCII。

Computed style:
- `.textLayer`: `position:absolute; pointerEvents:auto; userSelect:auto; opacity:1`
- `.textLayer span`: `userSelect:auto; pointerEvents:auto; color:rgba(0,0,0,0)` ← 透明叠在 canvas 上是 pdf.js 标准行为，不是 bug

**textLayer 一切正常。pdf_viewer.min.css 加载成功（200）。CSS 没问题。**

---

## Copy event 监听（决定性证据）

在 `document` 上 capture 阶段注入 listener，然后重建 selection + `document.execCommand('copy')`：

```
selection_before              = "Clio: Privacy-Preserving Insights\ninto Real-World AI Use\nAlex Tamkin"
execCommand_returned          = true       (copy event 触发成功)
captured.fired                = true       (我们的 listener 收到事件)
captured.plain                = ""         (clipboardData 是空!)
captured.html                 = ""
captured.defaultPrevented     = false      (capture 阶段我们最先看，pdf.js 还没拦)
captured.target_tag           = "SPAN"
```

→ Copy event 触发了，selection 是好的，但 clipboardData 一片空。

---

## 控制实验（验证修复方向）

在 capture 阶段注入一个**自己填 clipboardData** 的 listener：

```js
document.addEventListener('copy', (e) => {
  e.clipboardData.setData('text/plain', document.getSelection().toString());
  e.preventDefault();
}, { capture: true });
```

再触发 copy：

```
execCommand_returned = true
captured             = "Clio: Privacy-Preserving Insights\ninto Real-World AI Use\nAlex Tamkin"
```

**clipboardData 立刻被填充正确**。证明只要绕过 / 替换掉 pdf.js 的 ENABLE_PERMISSIONS 拦截逻辑，复制立刻能工作。

---

## 根因结论

`app.js:84` 设置了 `textLayerMode: 2`：

```js
const pdfViewer = new pdfjsViewer.PDFViewer({
  ...
  textLayerMode: 2,        // 启用 text layer（可选文字 + 搜索高亮基础）
  ...
});
```

pdf.js 的 `TextLayerMode` 枚举：
- `0 = DISABLE`
- `1 = ENABLE`
- `2 = ENABLE_PERMISSIONS`

`ENABLE_PERMISSIONS` 的含义是"启用 textLayer **并**严格遵守 PDF 内嵌的 COPY permission flag"。该值**不**是给用户主动选的，是 pdf.js 内部在以下条件下自动升级：

```js
// pdf.js 4.6.82 web/pdf_viewer.js#initializePermissions
if (!permissions.includes(PermissionFlag.COPY) &&
    this.#textLayerMode === TextLayerMode.ENABLE) {
  params.textLayerMode = TextLayerMode.ENABLE_PERMISSIONS;
}
```

但开发者**直接传 `2`**，相当于强行告诉 pdf.js"无论 PDF 是否允许 COPY，你都按禁止处理"。然后在 copy 事件回调里：

```js
// pdf.js 4.6.82 web/pdf_viewer.js#copyCallback
if (this.#getAllTextInProgress ||
    textLayerMode === TextLayerMode.ENABLE_PERMISSIONS) {
  event.preventDefault();
  event.stopPropagation();
  return;          // ← 不再调用 navigator.clipboard.writeText，剪贴板永远是空
}
```

→ 用户 Cmd+C，pdf.js 把事件吞了，没人往 clipboard 写东西，外部 app 拿到空。

补充证据：调用 `state.pdf.getPermissions()` 返回 `null` —— 这篇 arxiv PDF 根本没有 permissions dictionary，**任何复制都应允许**。是开发者主动选的 `textLayerMode: 2` 把自己锁死了。

---

## 推荐修复方案

### 选项 A（推荐，一行修复）：把 `textLayerMode` 改成 `1`

`app.js:84`：

```diff
-  textLayerMode: 2,        // 启用 text layer（可选文字 + 搜索高亮基础）
+  textLayerMode: 1,        // ENABLE（不强制 permission 模式）。让 pdf.js 根据 PDF 自身权限自动决定是否升级到 ENABLE_PERMISSIONS。
```

理由：
- `1 = ENABLE` 是允许复制 + 让 pdf.js 自己根据 PDF 元数据决定是否要升 `2`
- 受限 PDF（出版社加 DRM 的）pdf.js 仍会自动升 `2`，行为合规
- 不受限的（arxiv / 自由分发的）就走正常 copy 路径，剪贴板正常工作
- 这是 pdf.js **默认行为**（PDFViewer 构造选项 textLayerMode 默认就是 `ENABLE`）

副作用：无。这是 pdf.js 官方推荐做法。

### 选项 B（备用，不推荐）：在 capture 阶段自己接管 copy

在 app.js 里加：

```js
document.addEventListener('copy', (e) => {
  const sel = document.getSelection().toString();
  if (!sel) return;
  e.clipboardData.setData('text/plain', sel);
  e.preventDefault();
  e.stopPropagation();
}, { capture: true });
```

理由：用 capture 阶段在 pdf.js 之前抢答。

不推荐原因：和 pdf.js 内部状态机打架（pdf.js 还有 `getAllText()` 走 `navigator.clipboard.writeText` 的另一条路），且失去 pdf.js 对受限 PDF 的合规处理。

### 顺带清理（独立 PR，跟复制 bug 无关）

`app.js:18-23` 配的 cdnjs 路径是 403，且当前样本根本没触发。建议：

- 要么删掉 `PDFJS_DOC_OPTS`（YAGNI：当前样本不需要 cmap，添加无意义实体违反项目宪法 #2）
- 要么把 base 换成 `https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/`（cdnjs 没这俩目录，jsdelivr/unpkg 有）。仅在确实要支持 CJK / 复杂字体 PDF 时再保留。

但**这两件事不影响复制 bug**，单独选项 A 即可解决鸭鸭这次的问题。

---

## 修复后的测试方法（给 dev / 主 Claude）

1. 改 `app.js:84` 把 `textLayerMode: 2` → `textLayerMode: 1`
2. 刷新页面 → 重新加载 arxiv 2412.13678
3. 选中第一页任意一段文字 → Cmd+C → 切到任意外部 app（备忘录 / Slack / 终端）→ Cmd+V
4. 期望：粘出原始文字 (e.g. `"Clio: Privacy-Preserving Insights\ninto Real-World AI Use"`)
5. 验证回归：搜索 (⌘F) 高亮 仍然能正常工作（textLayer 自身不受影响）
