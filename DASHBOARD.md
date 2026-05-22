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

---

## 如何做到“0 手动”（自动部署到公网、全团队实时看到）

前提：你已经把仓库连接到 Netlify（continuous deployment），并且 Netlify 的 Publish 目录是 `outputs/`。

### 一次性设置

1. 确保仓库已推到 GitHub（`main` 分支）。
2. 在 Netlify 选择 “Import from existing repository with continuous deployment”，并使用仓库内的 `netlify.toml`。

### 日常（完全 0 手动）

把你的“每日选题雷达自动化”最后一步改成执行：

```bash
python3 scripts/publish-dashboard.py
```

它会自动：
- 生成/更新 `outputs/dashboard/data.js`
- `git add outputs` → `git commit` → `git push`

Netlify 会在收到 push 后自动重建并发布，团队打开同一个站点地址即可看到最新。

## 解析约定（不要改结构）

构建脚本依赖每日 Markdown 的固定结构：

- `## 1) 今日最值得写的 3 个选题` 下每个选题用 `### ...` 开头
- 评分行包含 `**总分 XX**`
- `## 2) 备选选题池` 下的条目形如：`1. **标题**：摘要（总分：21）`

如果未来要改输出模板，建议同步更新 `scripts/build-dashboard.mjs` 的解析逻辑。
