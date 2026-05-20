"""Co-Read Web · 后端
三个端点：serve 前端 / 流式代理 LLM / PDF CORS 代理
"""
import os
from pathlib import Path
import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse, Response

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
SYSTEM_PROMPT = (ROOT / "system_prompt.md").read_text(encoding="utf-8")
print(f"→ provider={provider}  model={MODEL}  endpoint={BASE_URL}")

app = FastAPI()


@app.post("/api/chat")
async def chat(req: Request):
    """流式代理到上游 OpenAI 兼容 LLM。前端发 {messages, pdf_text?}，
    pdf_text 存在则注入到 system message。
    若上游返回非 200，把错误体作为 HTTPException 抛出，前端能识别。"""
    body = await req.json()
    messages = body.get("messages", [])
    pdf_text = body.get("pdf_text", "")

    system_content = SYSTEM_PROMPT
    if pdf_text:
        system_content += f"\n\n## 当前论文全文\n\n{pdf_text}"

    payload = {
        "model": MODEL,
        "messages": [{"role": "system", "content": system_content}, *messages],
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


@app.get("/api/fetch-pdf")
async def fetch_pdf(url: str):
    """前端跨域无法直接拉 arxiv PDF —— 由后端代理"""
    # arxiv abs 链接自动转 pdf
    if "arxiv.org/abs/" in url:
        url = url.replace("/abs/", "/pdf/")
        if not url.endswith(".pdf"):
            url += ".pdf"
    try:
        async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
            r = await client.get(url)
            r.raise_for_status()
            return StreamingResponse(
                iter([r.content]),
                media_type="application/pdf",
                headers={"Content-Disposition": "inline"},
            )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"PDF fetch failed: {e}")


# 静态文件：通用 dispatcher，no-store 防止本地开发期浏览器缓存旧版
# 同时给 index.html 里的 app.js / style.css 注入文件 mtime 做 cache-bust，
# 这样换浏览器不会拿到老 module cache
_STATIC_ALLOWED = {"index.html", "app.js", "style.css"}
_MIME = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8"}


def _bust(path: str) -> str:
    p = ROOT / path
    return f"{path}?v={int(p.stat().st_mtime)}" if p.exists() else path


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
