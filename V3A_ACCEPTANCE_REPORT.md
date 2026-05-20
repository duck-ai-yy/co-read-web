# V3-α 数据层验收报告 (2026-05-19 11:52)

**测试 subagent**: a25f7e75178eedd25
**样本**: arxiv 2412.13678 (46 页, Clio)
**Server**: PID 64393 alive
**Token**: 2/2 chat 预算内
**Console**: 0 errors / 0 warnings 全 session

---

## 总分 **13 / 13 PASS** 🎉

| 组 | 通过 | 关键证据 |
|---|---|---|
| P0 数据层（7 项） | 7/7 | IDB v2 + 4 store / 默认主题 / migration 幂等 / 历史数据自动迁移 / palette 字节稳定 |
| P1 UI 透明（4 项） | 4/4 | 选段→色板→高亮全流程 / mouseleave hide / thread 切换 / 复制+IME+搜索 |
| P2 cleanness（2 项） | 2/2 | console 0 errors / bootstrap 时序 |

---

## 关键证据

**IDB schema**: `{version: 2, stores: ["annotations", "metadata", "threads", "topics"]}`

**topics.default 完整对象**：
```js
{
  id: "default",
  name: "默认主题",
  palette: [
    {id:"red",    emoji:"🔴", label:"看不懂",   color:"#ff5e5e"},
    {id:"green",  emoji:"🟢", label:"已掌握",   color:"#54d062"},
    {id:"blue",   emoji:"🔵", label:"课题相关", color:"#4a9eff"},
    {id:"purple", emoji:"🟣", label:"质疑",     color:"#b06dff"},
    {id:"yellow", emoji:"🟡", label:"重点",     color:"#f5d042"},
    {id:"gray",   emoji:"⚪", label:"待查",     color:"#b8b8b8"}
  ],
  pdfKeys: [],
  createdAt: "2026-05-19T11:47:58.251Z"
}
```

**第 1 / 第 2 次 /api/chat 的 `messages[0].content` 完全一致**（63 bytes，identical）：
```
## 主题 tag 规则
- 🔴 看不懂
- 🟢 已掌握
- 🔵 课题相关
- 🟣 质疑
- 🟡 重点
- ⚪ 待查
```

**v2-b 历史数据迁移**：1 key (`url:.../2412.13678`)、2 ann，全部已补 `topicId="default"`，`allHaveTopicId=true`

---

## Test 提的 3 个未来风险（v3-β 设计要带上）

1. **caching 失效预警**：v3-β palette 编辑器让用户改 palette → paletteRules 字节变 → cache 全失效（设计上不可避免）。建议加"危险操作"提示。
2. **autoMigrate 失败兜底**：现 fire-and-forget + `console.warn`，用户感知不到。v3-β 加 topic 切换 UI 时建议留状态位。
3. **palette 行删除后历史 ann 渲染**：DEFAULT_PALETTE 的 id 字段（`'red'`/`'green'`）兼容 v2-b 旧 annotation。v3-β 若让用户删 palette 行，要决定历史 ann.color='red' 怎么渲染。

---

## 总评

数据层底层 + system message 注入已是磐石。可以放心派 dev v3-β。
