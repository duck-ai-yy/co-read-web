"""Co-Read Web · 后端
三个端点：serve 前端 / 流式代理 LLM / PDF CORS 代理
"""
import os
from pathlib import Path
import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse, Response
from fastapi.staticfiles import StaticFiles

load_dotenv()
ROOT = Path(__file__).parent

# Provider 知识表 —— 切 provider 改 LLM_PROVIDER 一行即可
# (base_url, default_model, env_var_for_key)
#
# TODO[架构债]: openrouter 的 :free 模型周转极快（旧版动不动下线），硬编码 default 不稳定。
# v2 应在 startup 时调 `GET {BASE_URL}/models` 校验 default 活着，否则报错并列出可用 free 模型让用户选。
# 当前 :free default 是 2026-05 实时验证可用的，可能在几周内失效。
PROVIDERS = {
    "deepseek":   ("https://api.deepseek.com/v1",                              "deepseek-chat",                    "DEEPSEEK_API_KEY"),
    "gemini":     ("https://generativelanguage.googleapis.com/v1beta/openai",  "gemini-2.0-flash",                 "GEMINI_API_KEY"),
    "glm":        ("https://open.bigmodel.cn/api/paas/v4",                     "glm-4-plus",                       "GLM_API_KEY"),
    "qwen":       ("https://dashscope.aliyuncs.com/compatible-mode/v1",        "qwen-plus",                        "QWEN_API_KEY"),
    "kimi":       ("https://api.moonshot.cn/v1",                               "moonshot-v1-128k",                 "KIMI_API_KEY"),
    "openrouter": ("https://openrouter.ai/api/v1",                             "deepseek/deepseek-v4-flash:free",  "OPENROUTER_API_KEY"),
}

provider = os.environ.get("LLM_PROVIDER", "gemini").lower()
if provider not in PROVIDERS:
    raise SystemExit(f"Unknown LLM_PROVIDER: {provider}. Pick one of {list(PROVIDERS)}")
_url, _model, _key_var = PROVIDERS[provider]
API_KEY = os.environ.get(_key_var)
if not API_KEY:
    raise SystemExit(f"Missing {_key_var} in .env for provider '{provider}'")
BASE_URL = os.environ.get("LLM_BASE_URL") or _url
MODEL = os.environ.get("LLM_MODEL") or _model
# 三层 prompt 文件（启动时加载，热路径不再读盘）：
# - core_rules.md: 我们的核心规则，最高优先级，注入到 [0] + PDF 全文
# - topic_context.md: wrapper template，运行时把主题级 prompt 填进 {{content}}
# - user_persona.md: wrapper template，运行时把个人偏好填进 {{content}}
CORE_RULES = (ROOT / "prompts" / "core_rules.md").read_text(encoding="utf-8")
TOPIC_TEMPLATE = (ROOT / "prompts" / "topic_context.md").read_text(encoding="utf-8")
USER_TEMPLATE = (ROOT / "prompts" / "user_persona.md").read_text(encoding="utf-8")
print(f"→ provider={provider}  model={MODEL}  endpoint={BASE_URL}")

app = FastAPI()

# PDF.js 资源自托管：消除 cdnjs / jsdelivr 的外部依赖
# Why: 用户报告"半个月前能用、现在不行"+ loading 转一下消失。CDN 任何一环
# 出问题（worker 加载、CORS、地区性访问）都会让 getDocument 静默失败。
# 自托管后所有 PDF.js 资源同源，可以从 Network 面板一眼看出哪个挂了。
app.mount("/vendor/pdfjs", StaticFiles(directory=ROOT / "vendor" / "pdfjs"), name="pdfjs")


@app.post("/api/chat")
async def chat(req: Request):
    """流式代理到上游 OpenAI 兼容 LLM。前端发：
    - messages: 对话历史 + 主题级 palette/annotation system messages
    - pdf_text: 论文全文（注入到 core_rules 同条 system，cache prefix 锚点）
    - topic_prompt: 主题创建时填的 AI 指令（冻结，保 cache 稳定）
    - user_prompt: 个人偏好（snapshot 后整篇论文 session 不变）

    注入顺序（基于 DeepSeek 早 token 权重更高 + cache 前缀必须一致）：
      [0] core_rules + PDF（最大、最稳定 → cache 锚点）
      [1] topic_context wrapper（可空 → 跳过）
      [2] user_persona wrapper（可空 → 跳过）
      [3..n] frontend messages（palette / annotation note / 对话历史）"""
    body = await req.json()
    messages = body.get("messages", [])
    pdf_text = body.get("pdf_text", "")
    topic_prompt = (body.get("topic_prompt") or "").strip()
    user_prompt = (body.get("user_prompt") or "").strip()

    system_messages = []
    core_content = CORE_RULES
    if pdf_text:
        core_content += f"\n\n## 当前论文全文\n\n{pdf_text}"
    system_messages.append({"role": "system", "content": core_content})
    if topic_prompt:
        system_messages.append({
            "role": "system",
            "content": TOPIC_TEMPLATE.replace("{{content}}", topic_prompt),
        })
    if user_prompt:
        system_messages.append({
            "role": "system",
            "content": USER_TEMPLATE.replace("{{content}}", user_prompt),
        })

    payload = {
        "model": MODEL,
        "messages": [*system_messages, *messages],
        "stream": True,
    }

    client = httpx.AsyncClient(timeout=120)
    try:
        r = await client.send(
            client.build_request(
                "POST",
                f"{BASE_URL}/chat/completions",
                json=payload,
                headers={"Authorization": f"Bearer {API_KEY}"},
            ),
            stream=True,
        )
    except httpx.HTTPError as e:
        await client.aclose()
        raise HTTPException(status_code=502, detail=f"上游连接失败：{e}")

    # 上游非 2xx —— 读完错误体后以同样的状态码透传给前端
    if r.status_code >= 400:
        err_body = await r.aread()
        await r.aclose()
        await client.aclose()
        raise HTTPException(status_code=r.status_code, detail=err_body.decode("utf-8", errors="replace"))

    async def gen():
        try:
            async for line in r.aiter_lines():
                if line:
                    yield line + "\n"
        finally:
            await r.aclose()
            await client.aclose()

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.post("/api/event")
async def event(req: Request):
    """轻量行为埋点：读 JSON body，打到 stdout（前缀 [EVENT]，Render 日志可见）。
    只记行为信号，绝不记内容。极简、绝不 500、不写文件、立即返回 204。"""
    try:
        body = await req.json()
        print(f"[EVENT] {body}", flush=True)
    except Exception:
        # body 解析失败也安静返回，绝不报错
        pass
    return Response(status_code=204)


@app.get("/api/fetch-pdf")
async def fetch_pdf(url: str):
    """前端跨域无法直接拉 arxiv PDF —— 由后端代理。
    arxiv 三种 URL 形态（/abs/、/html/、/pdf/）统一规整成 /pdf/{id}。"""
    import re
    m = re.search(r"arxiv\.org/(?:abs|html|pdf)/([0-9]{4}\.[0-9]{4,6})(v\d+)?", url)
    if m:
        url = f"https://arxiv.org/pdf/{m.group(1)}{m.group(2) or ''}.pdf"
    try:
        async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
            r = await client.get(url)
            r.raise_for_status()
            # 内容校验：前 4 字节必须是 %PDF。否则前端拿到的会是 HTML，PDF.js 静默
            # 失败、loading 一闪消失（半个月前能用现在不行的真凶就是这种"链接对了但
            # 拿回 HTML"的情况）
            if not r.content.startswith(b"%PDF"):
                raise HTTPException(
                    status_code=415,
                    detail="这个链接拿回来的不是 PDF（可能是 arXiv HTML 渲染页或论文 landing 页）。请贴论文的直接 PDF 链接，或 arXiv 的 /abs/ 链接。",
                )
            return StreamingResponse(
                iter([r.content]),
                media_type="application/pdf",
                headers={"Content-Disposition": "inline"},
            )
    except HTTPException:
        raise  # 415 校验失败要原样透传，不能被下面的 502 包裹
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"PDF fetch failed: {e}")


@app.get("/api/arxiv-meta")
async def arxiv_meta(id: str):
    """arxiv 官方 API 不允许跨域，后端代理 + 把 Atom XML 解析成 JSON 返回。
    用作 cite 的权威源：Semantic Scholar 抓不到的论文，arxiv 自己有 100% 覆盖。"""
    import re, xml.etree.ElementTree as ET
    if not re.fullmatch(r"\d{4}\.\d{4,6}(v\d+)?", id):
        raise HTTPException(status_code=400, detail="Invalid arxiv id")
    try:
        async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
            r = await client.get(f"https://export.arxiv.org/api/query?id_list={id}")
            r.raise_for_status()
        root = ET.fromstring(r.text)
        ns = {"a": "http://www.w3.org/2005/Atom", "arx": "http://arxiv.org/schemas/atom"}
        entry = root.find("a:entry", ns)
        if entry is None:
            raise HTTPException(status_code=404, detail="arxiv entry not found")
        def txt(path, default=""):
            el = entry.find(path, ns)
            return (el.text or "").strip() if el is not None and el.text else default
        title = " ".join(txt("a:title").split())
        summary = " ".join(txt("a:summary").split())
        published = txt("a:published")
        year = published[:4] if published else ""
        authors = [a.text.strip() for a in entry.findall("a:author/a:name", ns) if a.text]
        doi = txt("arx:doi")
        journal_ref = txt("arx:journal_ref")
        primary = entry.find("arx:primary_category", ns)
        primary_cat = primary.get("term") if primary is not None else ""
        return {
            "title": title,
            "authors": authors,
            "year": year,
            "venue": journal_ref or "arXiv",
            "doi": doi,
            "arxivId": id,
            "abstract": summary,
            "primaryCategory": primary_cat,
            "published": published,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"arxiv meta fetch failed: {e}")


# 静态文件：通用 dispatcher，no-store 防止本地开发期浏览器缓存旧版
# 同时给 index.html 里的 app.js / style.css 注入文件 mtime 做 cache-bust，
# 这样换浏览器不会拿到老 module cache
_STATIC_ALLOWED = {"index.html", "app.js", "style.css", "guide.html"}
_MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
}


def _bust(path: str) -> str:
    p = ROOT / path
    return f"{path}?v={int(p.stat().st_mtime)}" if p.exists() else path


# 引导页配图：只放 guide-assets/ 下的 .jpeg —— 白名单后缀 + 拒绝路径穿越
@app.get("/guide-assets/{fname}")
async def guide_asset(fname: str):
    if "/" in fname or ".." in fname or not fname.endswith(".jpeg"):
        raise HTTPException(404)
    p = ROOT / "guide-assets" / fname
    if not p.exists():
        raise HTTPException(404)
    return Response(content=p.read_bytes(), media_type=_MIME[".jpeg"])


@app.get("/")
@app.get("/{name}")
async def static_file(name: str = "index.html"):
    if name not in _STATIC_ALLOWED:
        raise HTTPException(404)
    p = ROOT / name
    if not p.exists():
        raise HTTPException(404)
    if name == "index.html":
        html = p.read_text(encoding="utf-8")
        html = html.replace('src="/app.js"', f'src="/{_bust("app.js")}"')
        html = html.replace('href="/style.css"', f'href="/{_bust("style.css")}"')
        return Response(content=html, media_type=_MIME[".html"], headers={"Cache-Control": "no-store"})
    return Response(
        content=p.read_bytes(),
        media_type=_MIME.get(p.suffix, "application/octet-stream"),
        headers={"Cache-Control": "no-store"},
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=5050)
