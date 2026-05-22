[English](README.en.md)

# Co-Read · 论文伴读

边读论文，边和 AI 讨论，把零散想法沉淀成结构化笔记。

**试用** → https://co-read-web.onrender.com/ ·  [使用引导](https://co-read-web.onrender.com/guide.html)

## 是什么

Co-Read 是一个 PDF 论文伴读工具：

- **划线 = 打标签** —— 选中原文，选一个颜色标签（没懂 / 重点 / 可借鉴 / 存疑 / 要引用 / 待查）
- **`@AI` 就地讨论** —— 标记后直接写批注，或输入 `@AI` 召唤 AI 围绕这段原文回答
- **comment 列表** —— 右栏汇总所有标注与讨论，手风琴折叠，点一条跳回原文
- **导出** —— 把"收入笔记"的内容按标签导出为 Markdown

它是科研工具 Theoria 的第一步。

## 怎么造的

这个项目不是一行行手写的 —— 我设计了一套 agent harness，指挥 AI 编排团队把它做出来、测好、上线。

- **[`CLAUDE.md`](CLAUDE.md)** —— 项目宪法：6 条约束 + 冲突时的优先级规则，约束所有 AI 协作。
- **[`.claude/agents/`](.claude/agents)** —— 我定义的三个**受限 subagent 角色**：architect（评估/重构）、dev（写码，无 Bash —— 物理强制聚焦实现）、test（测试，无 Edit —— 物理强制不改代码）。用工具权限做角色隔离，比靠提示词"请只做 X"更硬。
- 我做产品决策、定约束、验收；orchestrator 按我的需求调度 subagent 执行。

这套 harness 本身就是项目的一部分。

## 技术栈

- 前端：vanilla JS（无框架、无构建）、pdf.js、IndexedDB（笔记只存浏览器本地，不上传服务器）
- 后端：FastAPI —— 代理 PDF 拉取 + 流式转发 LLM
- 模型：DeepSeek / 其它 OpenAI 兼容 provider

## 本地运行

```bash
pip install -r requirements.txt
cp .env.example .env        # 填入你的 LLM API key
python server.py            # → http://127.0.0.1:5050
```

## 版本

当前 **v0.1.0**，更新历史见 [CHANGELOG.md](CHANGELOG.md)。

## 许可

© 2026 duck-ai-yy · 保留所有权利。详见 [LICENSE](LICENSE)。
