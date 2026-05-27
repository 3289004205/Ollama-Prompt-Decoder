# Ollama 图片提示词反推 Chrome 插件

这个目录是一套可直接在 Chrome 加载的 MV3 扩展。它会在网页图片右上角显示“提取提示词”角标，点击后调用本地 Ollama，把图片反推成三种内容：

- 分层 JSON 提示词
- 约 300 字中文提示词
- 约 500 字英文提示词

弹窗内提供“保存到提示词库”按钮，会调用 Quick Prompt 插件的新建提示词页面，并把当前选中的 JSON、中文或英文提示词填入内容框。需要先安装并启用 Quick Prompt：`https://github.com/wenyuanw/quick-prompt`。

提取过程中会显示任务进度条，可以实时查看当前阶段：读取设置、读取图片、图片转码、请求模型、模型推理、整理结果和完成。

如果进度停在“等待 Ollama 响应”，同时 `ollama ps` 为空，说明请求还没有进入模型推理阶段。插件会继续等待并显示已等待秒数，超过 180 秒会自动报错并给出排查提示。

为了提高成功率，插件会先把图片压缩到最长边 1024px，再发送给 Ollama。模型如果返回空内容，会自动用更短提示重试；最后仍为空时，会使用图片 alt、title 和页面上下文生成保守兜底提示词。

页面滚动时，离开视口、被隐藏或被移除的图片，其“提取提示词”角标会自动消失；如果对应弹窗还在运行，也会自动关闭并中断任务。

## 使用方法

1. 启动 Ollama：

   ```powershell
   ollama serve
   ```

2. 拉取模型。默认模型为用户指定的 `qwen3.5:27b`：

   ```powershell
   ollama pull qwen3.5:27b
   ```

3. 打开 Chrome：`chrome://extensions/`
4. 开启“开发者模式”。
5. 点击“加载已解压的扩展程序”，选择本目录：

   ```text
   C:\Users\M1971\Documents\Codex\2026-05-15\300-ollama-qwen3-5-27b-ollama
   ```

6. 打开任意网页，图片右上角会出现“提取提示词”角标。点击后弹窗可切换 JSON、中文、English 三种提示词。

## 模型设置

点击浏览器工具栏里的扩展图标，再点“设置模型”，可以修改：

- Ollama 服务地址，默认 `http://localhost:11434`
- 模型名称，默认 `qwen3.5:27b`
- 中英文提示词字符上限，默认 2000

## 注意

图片反推需要 Ollama 模型支持图片输入。如果 `qwen3.5:27b` 在你的 Ollama 环境中不是视觉模型，点击提取时可能会返回模型能力错误。此时可以在设置页切换为本地已安装的视觉模型，例如 `qwen2.5vl:7b`、`llava:latest` 或 `minicpm-v:latest`。

## 403 处理

插件已内置 Chrome MV3 请求头规则，会自动移除发往 `localhost:11434` 和 `127.0.0.1:11434` 的 `Origin` 请求头，通常不需要额外配置。

如果点击“提取提示词”后仍显示 `Ollama 请求失败：403`，一般是 Ollama 拒绝了 Chrome 扩展的来源。Windows 可以这样设置：

```powershell
[Environment]::SetEnvironmentVariable('OLLAMA_ORIGINS', 'chrome-extension://*', 'User')
```

然后完全退出 Ollama 并重新打开。可以在任务栏托盘退出 Ollama，或者结束 `ollama.exe` 后重新运行：

```powershell
ollama serve
```

如果仍然 403，可以临时放宽为：

```powershell
[Environment]::SetEnvironmentVariable('OLLAMA_ORIGINS', '*', 'User')
```

改完环境变量后必须重启 Ollama 才会生效。
