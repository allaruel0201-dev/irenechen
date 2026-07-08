# DBC 秋招岗位开放表

这是一个静态网页生成器：读取 Excel 或包含 Excel 的 zip，生成可直接打开的 `dist/index.html`。

## 使用方式

1. 把岗位表放入 `input/` 文件夹，支持 `.xlsx`、`.xls`、`.xlsm`，也支持包含这些文件的 `.zip`。
2. 安装依赖：

```bash
npm install
```

3. 生成页面：

```bash
npm run generate
```

也可以指定文件：

```bash
npm run generate -- ./input/jobs.xlsx
```

4. 打开：

```bash
open dist/index.html
```

## 每周如何更新 Excel

学生前端页面不显示上传入口。每周更新岗位表时，把新 Excel 或 zip 交给运营/生成端处理：

- 在 Codex 对话里上传 Excel 或 zip，我会把它更新进页面并重新生成 `dist/index.html`。
- 如果你自己本地更新，把新 Excel 或 zip 放到 `input/` 文件夹，再运行 `npm run generate`。

如果当前有本地预览服务在跑，重新生成后刷新浏览器即可看到新版数据。

## 数据规则

- 读取所有 sheet，每个 sheet 单独作为 tab 展示。
- 每个 sheet 默认忽略最后两列，不展示、不参与搜索、不生成逐列筛选。
- 如果表头里有 `Link` 列，会保留为申请链接来源，表格中显示为 `Apply` 按钮。
- 如果表头里有 `Job Title` 列，且该行有 `Link`，岗位标题会变成可点击链接。
- 不提供 CSV 导出、Excel 下载、复制整表等功能。

## 替换二维码

生成后的 `dist/index.html` 中搜索：

```html
<!-- QR_CODE_REPLACE_HERE -->
```

把占位块替换为真实二维码图片即可。
