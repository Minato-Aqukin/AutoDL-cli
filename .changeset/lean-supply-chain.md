---
"@minato-aqukin/autodl-cli": minor
---

依赖瘦身、启动提速，并修复代码审计发现的一批问题。

**依赖与体积**

- MCP 从 `@modelcontextprotocol/sdk` v1 迁移到 `@modelcontextprotocol/server` v2（默认仍使用 2025 版协议，旧客户端照常连接），zod 升级到 4。SDK 导出的 `buildServer` 现在返回 v2 的 `McpServer`。
- Ink / React 本就打包进产物，不再作为运行时依赖安装；表格改用内置渲染，移除 `cli-table3`。安装时的生产依赖从 162 个包降到 16 个。
- 打包时使用 React 生产构建：发布包 432 kB → 323 kB（解包 2.1 MB → 1.4 MB），TUI 渲染不再跑开发模式检查。
- 产物不再在每个文件注入 `createRequire`，版本号在构建时内联。
- 打包进产物的 Ink、React 及其依赖的许可证声明现随包附在 `dist/THIRD_PARTY_LICENSES.txt`，由构建根据实际打包内容生成；打包了没有许可证文件的依赖时构建直接失败。
- README 改为中文为主（`README.md`），英文版移到 `README.en.md`。

**性能**

- `ssh2` 与 MCP SDK 改为按需加载，`autodl --version` / `ls` 等命令启动时间约 150 ms → 100 ms。
- SFTP 上传/下载改为流水线传输；断点记录不再每个文件整体重写两次；文件视图勾选与台账读取去掉了逐行重复计算。

**修复**

- TTL：`guard ttl` / `start --ttl` 的实例内定时器命令存在 `&;` 语法错误，从未真正设置成功；开机定时器现在记录 PID，`guard cancel` 只取消确认属于本工具的定时器、同时清除本机台账，无法确认时返回退出码 1。
- `deploy`：`--no-setup`、`--no-accel`、`--env` 之前被静默忽略；`--detach` 启动失败或开机等待期间中断时不再遗留计费实例。
- `run` / `deploy`：Ctrl-C 能真正中断远程命令与传输并关机，第二次 Ctrl-C 强制退出；关机/释放失败时结果带 `cleanup.error` 并以退出码 1 结束。
- `info --json` 不再输出 Jupyter Token 明文；`rm --force` 先确认再关机；`create/start --wait` 失败时不再挂起进程；数值参数（如 `--min-balance 20元`）非法时报参数错误，不再悄悄关掉余额闸门。
- 环境变量 `GITHUB_TOKEN` 只发给 github.com，`GITEE_TOKEN` 只发给 gitee.com；仓库地址保留端口并支持 `ssh://`。
- SSH 连接建立后的网络错误不再导致进程崩溃；`pull` 单个文件到目录、远程命令输出的多字节字符截断、无退出码的通道关闭等问题已修复。
- HTTP 响应体读取纳入超时与重试；重复关机请求视为成功；API 报告余额不足时错误码为 `INSUFFICIENT_BALANCE`；TTL 台账改为加锁的原子写入，多个进程同时记录 TTL 时不再丢条目。
- MCP：释放实例前等待关机完成；`autodl_exec` 自动开机时同样设置 TTL。
- 队列：`queue resume` / `queue resolve` 跨进程生效并在前台执行到结束，`queue add --wait` 遇到冲突不再挂起。
- TUI：空账号可按 `n` 新建实例；删除/重命名对话框的目标不会被后台刷新替换；重新进入文件视图不再报「文件会话已关闭」；开机后文件视图正确刷新；队列异常不再导致 TUI 崩溃；释放进行中退出时先确认，确认后停止等待关机、不再释放，进程不再在退出后挂住最多 10 分钟。
