<h1 align="center">DSH × AgentAPI</h1>

<p align="center"><strong>七牛 AgentAPI 的 DeepSeek Harness 插件</strong></p>

<p align="center"><a href="README.md">English</a> · 简体中文</p>

通过 DSH 在本地组织任务，让七牛 AgentAPI 托管的智能体在云端执行。你可以从 DSH 调用已有的 Agent 和云环境，也可以随时进入 Portal 查看同一次任务的完整记录。

[了解七牛 AgentAPI](https://www.qiniu.com/products/agentapi) · [打开 AgentAPI Portal](https://portal.qiniu.com/agentapi)

[![七牛 AgentAPI 产品介绍](assets/agentapi-product.jpg)](https://www.qiniu.com/products/agentapi)

## Install

在 DeepSeek Harness 桌面版打开 **插件 → 添加插件**，粘贴以下安装包地址，点击 **安装**，完成后重启 DSH。

```text
https://github.com/qiniu/dsh-agentapi/releases/download/v0.1.1/dsh-agentapi-0.1.1.tgz
```

同一输入框也支持 GitHub 地址 `github:qiniu/dsh-agentapi#v0.1.1`、已下载的 `.tgz` 文件或本地插件目录的绝对路径。[下载发行版](https://github.com/qiniu/dsh-agentapi/releases/tag/v0.1.1)

从 v0.1.0 升级时，请先在当前配置中移除旧插件 `@xgrowthlab/dsh-agentapi`，再添加新版。已有的 AgentAPI 设置和会话记录会保留。

<details>
<summary>使用 DSH CLI 安装（Web 或桌面版）</summary>

Web 版使用 `web` profile，安装后重启对应的 DSH 服务。

```sh
dsh plugin --profile web add https://github.com/qiniu/dsh-agentapi/releases/download/v0.1.1/dsh-agentapi-0.1.1.tgz
```

桌面版使用 `desktop` profile。先启动一次桌面应用并完全退出，执行以下命令，再重新打开应用。

```sh
dsh plugin --profile desktop add https://github.com/qiniu/dsh-agentapi/releases/download/v0.1.1/dsh-agentapi-0.1.1.tgz
```

</details>

## Quick Start

打开 **设置 → 云端智能体**，填入七牛 AgentAPI Key，点击 **保存并连接**。首次使用可保留默认的 **Native** 运行时，插件会在首次委派时准备 Agent 和云环境。已有 Agent 或云环境时，可在 **高级设置** 中选择。[获取 AgentAPI Key](https://portal.qiniu.com/agentapi/settings)

![DSH 云端智能体设置中的账号连接、运行时、模型和高级设置](assets/connect.png)

## 在 DSH 中使用 AgentAPI

### 主会话 · 委派与调度

在输入框键入 `/` 并选择 **云端智能体**，或直接用 `/cloud` 描述任务。DSH 主智能体会结合前文和你选中的附件组织委派，由 AgentAPI 创建独立的云端会话执行。任务完成后，结果回到主会话。

点击顶部的 **子智能体** 即可查看本次会话的成员。带云朵图标的条目运行在 AgentAPI 上。列表显示状态、Token 用量和耗时，点击条目即可进入对应会话。

![DSH 主会话中的委派入口，以及带云朵标识的子智能体列表](assets/delegate.png)

### 云端子会话 · 执行与协作

这里展示主智能体交给云端的任务，以及云端智能体实时发出的消息、工具调用和执行结果。运行中可以直接中断，后续可在底部输入框补充要求，继续使用这个 AgentAPI 会话里的上下文和文件。

![DSH 云端子会话中的任务说明、执行结果和消息输入框](assets/session.png)

### AgentAPI Portal · 查看云任务

在云端子会话点击 **查看云端记录**，即可打开这项任务对应的 AgentAPI 会话。也可以登录 Portal，在左侧 **会话** 中找到从 DSH 发起的任务。[进入 AgentAPI Portal](https://portal.qiniu.com/agentapi)

在 **对话** 中回看消息，切到 **轨迹** 可以沿时间线展开模型调用和工具执行详情。**原始事件（JSONL）** 保留逐条事件，生成的报告、表格与补丁可从 **文件** 下载。

[![七牛 AgentAPI Portal 的会话轨迹，展示模型调用、工具执行与文件入口](assets/agentapi-portal.jpg)](https://portal.qiniu.com/agentapi)
