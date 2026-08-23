---
"@minatoaqukin/autodl-cli": minor
---

首个版本：面向人与 agent 的 AutoDL 实例管理工具。

- **CLI**：账号余额、实例创建/列表/开关机/释放、交互式 SSH、远程执行、SFTP 上传下载
- **MCP server**（`autodl mcp`）：15 个工具 + `autodl://instances` 资源，可直接接入
  Claude Code / Cursor / Cline
- **SDK**：核心能力以 npm library 形式导出，供 Node 程序直接调用
- **成本护栏**：实例内定时关机 + 本地台账清理 + 闲置检测 + 余额闸门，
  应对 AutoDL「只按开机时长计费」的规则
- **一键工作流** `autodl run`：建实例 → 同步代码 → 远程执行 → 回传产物 → 自动关机，
  Ctrl-C 也会走完关机流程
- **稳定的 agent 契约**：全局 `--json`（stdout 纯 JSON）与 9 个语义化退出码
- SSH 凭证每次连接都重新获取，正确处理 AutoDL 开关机后端口与密码变化的行为

基于 AutoDL 官方开放 API 构建，不依赖逆向控制台接口。
