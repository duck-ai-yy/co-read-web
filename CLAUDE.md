# Co-Read Web · 项目宪法

## 🎯 产品 Mission（所有功能服务于此）

**辅助研究者深度读论文 + 理解论文 + 多线程整理思路 + 输出可分享/存档的 markdown 笔记。**

不是"PDF 问答"，不是"ChatPDF 升级版"——是研究流的闭环容器：每个**主题（Topic）**装一组论文 + 一套冻结色板 + 一份导出笔记。

新增任何 feature 前问自己：**这一步在"读 / 理解 / 整理 / 输出"哪个环节？没在任一环节就不该做。**

---

## 6 条约束

任何在这个项目里工作的 Claude / subagent 必须贯穿以下 6 条约束。**冲突时按本文件顺序决定优先级**。

---

## 1. 尽可能利用 prompt caching
- 设计请求时让"前缀"尽量稳定可缓存（system prompt + PDF 全文 → 缓存命中后只算 ~10% 价格）
- 不要在请求里加入随机/时间戳/UUID 等破坏缓存的元素
- OpenAI 兼容 provider 大多自动 cache（DeepSeek/Qwen/Kimi 都有 90%+ 命中），不需要显式 `cache_control`
- **改 system prompt 或 PDF 内容 = 缓存失效**——慎重

## 2. 非必要勿增实体（奥卡姆剃刀）
- 每个文件、目录、抽象、依赖、配置项都要先过"自省 3 秒"：能不能不加？能不能合并/inline/CDN/stdlib？
- "为了将来可能扩展" → 立刻警觉，YAGNI 反模式
- 默认偏好：扁平 > 层级；CDN > 本地；vanilla > 框架；inline > 单独文件（除非超过 ~200 行）

## 3. 一切决策参考顶尖架构师的判断
- 解耦设计、配置驱动、单一职责
- 模块边界清晰、接口稳定、内部可换
- 错误处理优雅（不吞错、不静默、不 hallucinate fallback）
- 命名面向"角色"而非"实现"（如 `LLM_PROVIDER` 不是 `DEEPSEEK_PROVIDER`）

## 4. 一切测试参考半夜修代码修到崩溃的工程师会吐槽的边缘 case
- 必查：配额爆 / 网络断 / 超时 / 上游返回非预期格式 / 用户疯狂点击 / 极慢网络 / 极大 PDF / Unicode / 浏览器缓存 / 并发请求 / abort 之后重试
- 每个 feature 都要自问"半夜 3 点工程师在用这个会被什么坑到？"
- 不处理 hypothetical（不会真发生的）边缘 case

## 5. 控制成本
- 默认选能命中缓存的 provider（DeepSeek/Qwen/Kimi 首选）
- 不要无意义重发 PDF 全文（D 策略下虽然每次发但缓存抵消）
- 流式响应让用户能早看见、早 abort
- 不要在用户没要求时主动发起 LLM 调用（除非有明确产品价值）

## 6. 敏捷开发原则
- 小步快跑：每个迭代都跑得起来、能演示
- 鸭鸭驱动：每个决策点让她确认，不擅自补脑
- 反馈快：subagent 阶段性产出立即回报，不要憋大招
- 临时方案明确标注 `TODO` / `XXX`，便于后续 refactor

---

## 约束之间的张力（按上面顺序判优先）

- caching 第一 vs 增实体：为 caching 加少量 metadata（如 `?v=mtime` cache-bust）是必要实体
- 架构师 vs 敏捷：架构师定"最低标准"，敏捷决定"迭代速度"，每次迭代都要达到架构师最低标准
- 防御性边缘 case vs 不增实体：只处理"半夜真会发生的"边缘 case，hypothetical 跳过

---

## 项目目录

```
co-read-web/
├── server.py            # FastAPI 后端
├── index.html           # 单页应用
├── app.js               # 前端逻辑 (vanilla JS)
├── style.css            # 极简样式
├── system_prompt.md     # 鸭鸭定义的 agent 灵魂（subagent 不得修改）
├── .env / .env.example  # provider 配置 + API keys（subagent 不得读 key 值）
├── requirements.txt
├── .claude/agents/      # 项目级 subagent 团队
│   ├── architect.md     # 重构 / 评估
│   ├── dev.md           # 写代码（无 Bash，物理强制聚焦）
│   └── test.md          # 测试 / 报 bug（无 Edit，物理强制不改代码）
└── CLAUDE.md            # 本文件
```

## 角色分工

- **鸭鸭**：产品决策、system prompt 设计、约束设定
- **主 Claude**：协调、对话翻译、调度 subagent、汇总反馈
- **architect**：架构评估与重构（项目级 `.claude/agents/architect.md`）
- **dev**：写代码（无 Bash，物理强制聚焦实现）
- **test**：测试与报 bug（无 Edit，物理强制不改代码）

## subagent 调度约定

- 由主 Claude 调度，subagent 不互相调度
- 调度前主 Claude 必须给 subagent **明确任务 + 边界 + 期望产出格式**
- subagent 完成立即回报，主 Claude 翻译成人话给鸭鸭
- 大方向变更 → subagent 必须 escalate 回主 Claude，不擅自决定
