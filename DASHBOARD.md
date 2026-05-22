# Dashboard（每日选题雷达）

## 这是什么

把 `outputs/daily/*.md` 的每日选题雷达汇总成一个可浏览的静态页面：

- 页面：`outputs/dashboard/index.html`
- 数据：`outputs/dashboard/data.js`（由脚本自动生成）

## 如何更新（给自动化用）

当每天生成完新的 `outputs/daily/YYYY-MM-DD-topic-radar.md` 后，执行：

### 推荐（无需安装 brew/node）

```bash
python3 scripts/build-dashboard.py
```

### 可选（如果你本机已安装 node）

```bash
node scripts/build-dashboard.mjs
```

然后直接打开：

- `outputs/dashboard/index.html`

## 解析约定（不要改结构）

构建脚本依赖每日 Markdown 的固定结构：

- `## 1) 今日最值得写的 3 个选题` 下每个选题用 `### ...` 开头
- 评分行包含 `**总分 XX**`
- `## 2) 备选选题池` 下的条目形如：`1. **标题**：摘要（总分：21）`

如果未来要改输出模板，建议同步更新 `scripts/build-dashboard.mjs` 的解析逻辑。
