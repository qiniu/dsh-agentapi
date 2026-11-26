<h1 align="center">DSH × AgentAPI</h1>

<p align="center"><strong>The Qiniu AgentAPI plugin for DeepSeek Harness</strong></p>

<p align="center">English · <a href="README.zh.md">简体中文</a></p>

Bring your Qiniu AgentAPI agents and their execution environments into DeepSeek Harness. Delegate work from a DSH conversation, collaborate with the cloud agent in a native subagent session, and open that same session in the AgentAPI Portal to inspect its trace and download its files.

[Explore Qiniu AgentAPI](https://www.qiniu.com/products/agentapi) · [Open the AgentAPI Portal](https://portal.qiniu.com/agentapi)

[![Qiniu AgentAPI product overview](assets/agentapi-product.jpg)](https://www.qiniu.com/products/agentapi)

## Install

In DeepSeek Harness Desktop, open **Plugins → Add plugin**, paste the package URL below, and select **Install**. Restart DSH when the installation finishes.

```text
https://github.com/qiniu/dsh-agentapi/releases/download/v0.1.0/dsh-agentapi-0.1.0.tgz
```

The same field accepts the GitHub source `github:qiniu/dsh-agentapi#v0.1.0` or the absolute path to a downloaded `.tgz` file or local plugin directory. [Download the release](https://github.com/qiniu/dsh-agentapi/releases/tag/v0.1.0)

<details>
<summary>Install with the DSH CLI (Web or Desktop)</summary>

For DSH Web, install into the <code>web</code> profile, then restart the corresponding DSH service.

```sh
dsh plugin --profile web add https://github.com/qiniu/dsh-agentapi/releases/download/v0.1.0/dsh-agentapi-0.1.0.tgz
```

For Desktop, open the app once to initialize its profile, then quit it completely. Run the following command and reopen the app.

```sh
dsh plugin --profile desktop add https://github.com/qiniu/dsh-agentapi/releases/download/v0.1.0/dsh-agentapi-0.1.0.tgz
```

</details>

## Quick Start

Open **Settings → 云端智能体 (Cloud Agents)**, enter your Qiniu AgentAPI key, and select **保存并连接 (Save and connect)**. For your first task, you can keep the default **Native** runtime. The plugin prepares an agent and a cloud environment on first use. To use an existing agent or environment, select it under **高级设置 (Advanced settings)**. [Get an API key](https://portal.qiniu.com/agentapi/settings)

![Connect an AgentAPI account and select a runtime, model, or existing environment in DSH settings](assets/connect.png)

## Using AgentAPI in DSH

### Delegate from the main conversation

Type `/` and choose **云端智能体 (Cloud Agent)**, or start a message with `/cloud`. The main agent uses the conversation and your selected attachments to prepare the assignment. AgentAPI runs it in a dedicated session and reports the result back to the main conversation.

Open **Subagents** at the top of the conversation. A cloud icon identifies each AgentAPI session. The list shows its state, token usage, and elapsed time. Select a session to open it.

![The DSH main conversation with cloud and local subagents in the same list](assets/delegate.png)

### Work with the cloud agent

The subagent conversation shows the assignment, live messages, tool calls, and results. You can interrupt the current turn or send a follow-up. The cloud session retains its conversation and files across turns.

![A cloud subagent conversation showing the assignment, results, and follow-up input](assets/session.png)

### Inspect a session in the AgentAPI Portal

Select **查看云端记录 (View cloud record)** in the subagent conversation to open the corresponding AgentAPI session. You can also find tasks started from DSH under **会话 (Sessions)** in the Portal. [Open the AgentAPI Portal](https://portal.qiniu.com/agentapi)

Read the conversation under **对话**, inspect model requests and tool calls on the **轨迹** timeline, or explore individual events under **原始事件（JSONL）**. Open **文件** to download reports, tables, and patches produced by the agent.

[![The AgentAPI Portal showing a session timeline with model requests, tool calls, and the Files tab](assets/agentapi-portal.jpg)](https://portal.qiniu.com/agentapi)
