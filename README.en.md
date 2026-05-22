[中文](README.md)

# Co-Read · Paper Reading Companion

Read papers while discussing them with AI, turning scattered thoughts into structured notes.

**Try it** → https://co-read-web.onrender.com/ · [User Guide](https://co-read-web.onrender.com/guide.html)

## What it is

Co-Read is a PDF paper reading companion:

- **Highlight = tag** — select text in the paper, pick a colored tag (Don't get it / Key point / Worth borrowing / Questionable / To cite / To look up)
- **`@AI` discussion in place** — after tagging, write your own note, or type `@AI` to summon the AI to answer questions about that passage
- **Comment list** — the right panel aggregates every annotation and discussion in an accordion; click an entry to jump back to the source text
- **Export** — export everything marked "save to notes" as Markdown, grouped by tag

It is the first step toward Theoria, a research tool.

## How it was built

This project was not hand-written line by line — I designed an agent harness and directed an AI agent team to build it, test it, and ship it.

- **[`CLAUDE.md`](CLAUDE.md)** — the project constitution: 6 constraints plus a priority rule for resolving conflicts, governing all AI collaboration.
- **[`.claude/agents/`](.claude/agents)** — three **scoped subagent roles** I defined: architect (evaluation / refactoring), dev (writes code, no Bash access — physically forced to focus on implementation), and test (testing, no Edit access — physically forced not to touch code). Role isolation is enforced through tool permissions, which is stronger than relying on a prompt that merely asks the agent to "please only do X".
- I make the product decisions, set the constraints, and sign off; the orchestrator schedules the subagents to carry out the work according to my requirements.

This harness is itself part of the project.

## Tech stack

- Frontend: vanilla JS (no framework, no build step), pdf.js, IndexedDB (notes are stored only in the browser, never uploaded to the server)
- Backend: FastAPI — proxies PDF fetching and streams LLM responses
- Model: DeepSeek / other OpenAI-compatible providers

## Running locally

```bash
pip install -r requirements.txt
cp .env.example .env        # fill in your LLM API key
python server.py            # → http://127.0.0.1:5050
```

## Version

Currently **v0.1.0**; see [CHANGELOG.md](CHANGELOG.md) for the update history.

## License

© 2026 duck-ai-yy · All rights reserved. See [LICENSE](LICENSE) for details.
