# autodl-cli

> **非官方项目。** 本项目与 AutoDL 官方无任何关联，未获其背书或赞助。
> 名称中的 "AutoDL" 仅用于指代本工具所对接的平台。

用命令行管理 [AutoDL](https://www.autodl.com/) GPU 实例 —— 并且让你的 AI agent 也能管。

基于 AutoDL **官方开放 API** 构建：开发者 Token 长期有效，网页控制台改版也不会导致工具失效。

[English](./README.md)

---

## 为什么做这个

当 AI agent 在执行任务途中需要一台 GPU 机器时，它没有任何办法拿到 —— AutoDL 的实例只能在网页
控制台点出来。本项目提供三个入口，共用同一套核心逻辑：

| 入口 | 面向 | 用法 |
|---|---|---|
| **CLI** | 人 | `autodl create --gpu 4090 --ttl 2h` |
| **MCP server** | Claude Code、Cursor、Cline… | `autodl mcp`（stdio） |
| **SDK** | Node 程序 | `import { createInstance } from "@minatoaqukin/autodl-cli"` |

每个命令都支持 `--json`，输出结构稳定、退出码有明确语义，agent 无需解析自然语言就能判断结果。

## 安装

```bash
npm install -g @minatoaqukin/autodl-cli   # 之后直接用 autodl 命令
npx @minatoaqukin/autodl-cli <command>    # 或者不安装直接用
```

需要 Node.js 22 及以上。

## 交互式看板

```bash
autodl tui     # 交互式终端里直接敲 autodl 也进
```

还没配置 Token 的机器上，它会先进登录页，给两个选项——配置 Token 登入，或退出。
粘贴 Token 后会先向 API 验证再保存，然后直接进看板。已经配置过的，敲 `autodl` 直接进。

一张会自己刷新的实例表：状态、GPU、地区、**已开机多久、大概花了多少钱**、TTL 还剩多少。
快捷键：`↑↓` 移动、`Enter` 详情、`s` 开机、`x` 关机、`c` 复制 SSH 命令、`D` 释放、
`g` 看 GPU 库存、`n` 新建、`r` 刷新、`q` 退出。

它跑在终端的备用屏上，因此拥有一块固定画布，不会接在之前的残留输出后面滚动；
退出时会完整还原你的提示符和滚动历史。

做它的理由很简单：AutoDL 按开机时长计费，最贵的错误不是敲错命令，而是"忘了还开着"。
把这张表开着，这件事就一直是可见的。

有两处刻意的诚实约束。单价只能从**运行中**实例的 snapshot 拿到，所以已关机的实例
只显示时长、不显示金额——编一个看起来合理的数字比留空更糟。单价还没拉到时，
汇总栏会明说"总额偏低"，而不是安静地少报。

TUI 不会在管道、CI 或 `--json` 下启动：它会以退出码 2 退出并说明原因，
而不是去接管一个并不存在的终端。非交互环境下裸 `autodl` 仍然和以前一样打印帮助。

## 配置

官方 API 需要**已完成实名认证**（个人或企业）账号的开发者 Token。
获取路径：AutoDL 控制台 → 设置 → 开发者 Token。

```bash
autodl login              # 先验证 Token 有效，再以 0600 权限落盘
autodl account            # 查看余额、代金券、累计消费
```

Token 优先级：`--token` › `AUTODL_TOKEN` 环境变量 › `~/.config/autodl-cli/config.json`。

## 快速上手

```bash
# 租一台两小时后自动关机的卡，并等它就绪
autodl create --gpu 4090 --ttl 2h --wait

# 开始干活
autodl ls
autodl ssh pro-76419909953e                    # 交互式登录
autodl exec pro-76419909953e "nvidia-smi"      # 单次执行，透传远程退出码
autodl push pro-76419909953e ./src /root/work  # SFTP 上传
autodl pull pro-76419909953e /root/work/out .  # SFTP 下载

# 停止计费
autodl stop pro-76419909953e
autodl rm pro-76419909953e --yes               # 不可逆：数据将被永久清空
```

也可以用一条命令跑完全流程：

```bash
autodl run "python train.py" \
  --gpu 4090 --sync ./ --pull /root/autodl-cli/checkpoints --ttl 4h
```

它会自动建实例 → 等就绪 → 上传代码 → 流式输出执行过程 → 回传产物 → 关机。
按 Ctrl-C 中断时同样会走完关机流程。

## 接入 agent

### Claude Code

```bash
claude mcp add autodl -- npx -y @minatoaqukin/autodl-cli mcp
```

### Cursor / Cline / 任意 MCP 客户端

```json
{
  "mcpServers": {
    "autodl": {
      "command": "npx",
      "args": ["-y", "@minatoaqukin/autodl-cli", "mcp"],
      "env": { "AUTODL_TOKEN": "你的Token" }
    }
  }
}
```

提供的工具：`autodl_account_info`、`autodl_list_instances`、`autodl_get_instance`、
`autodl_create_instance`、`autodl_power_on`、`autodl_power_off`、
`autodl_release_instance`、`autodl_exec`、`autodl_upload`、`autodl_download`、
`autodl_run`、`autodl_list_gpu_specs`、`autodl_list_images`、`autodl_save_image`、
`autodl_sweep_expired`，另有 `autodl://instances` 资源。

MCP 模式的默认值比 CLI 更严格，因为没有人在旁边盯着：不指定时强制套用 2 小时 TTL，
释放实例必须显式传 `confirm: true`，密码默认脱敏返回。

### Shell / CI

```bash
autodl ls --json | jq -r '.data[] | select(.status=="running") | .uuid'
```

## 部署 git 项目

```bash
# 开一台卡，拉代码、自动装依赖、跑起来，然后关机
autodl deploy owner/repo --gpu 4090 --start "python train.py" --ttl 4h

# 长驻服务：后台启动并保持实例运行
autodl deploy owner/repo --gpu 4090 --start "python app.py" --detach

# 过几天回来：同一台机器开机 + git pull，环境不用重建
autodl deploy owner/repo --instance pro-76419909953e --start "python train.py"
```

`deploy` 和 `run` 只有一个刻意的区别：结束时**关机而不释放**。关机的实例磁盘完整保留，
下次部署直接复用已经装好的环境。想释放用 `--on-finish release`。

代码放在 `/root/autodl-tmp/<仓库名>`，也就是**数据盘**。AutoDL 的系统盘固定 30G 且会被打包进
保存的镜像；数据盘独立、更快、可扩容。有个值得知道的取舍：**数据盘的内容保存镜像时不包含**，
所以环境装系统盘、代码放数据盘才是对的组合。

依赖按这个顺序自动探测，先命中先用：`environment.yml` → `requirements.txt` →
`pyproject.toml` → `package-lock.json`/`package.json`。`--setup "<命令>"` 可完全覆盖，
`--no-setup` 跳过。

远程命令一律走**登录 shell**。AutoDL 镜像把 `python`、`pip`、`conda` 放在
`/root/miniconda3/bin`，这个路径只有登录时的 profile 才会加进 `PATH`——直接
`ssh host "pip install ..."` 会以退出码 127 失败。`autodl exec` 同样如此，
因此它的行为和你手动 `autodl ssh` 进去敲命令一致。

从 GitHub / HuggingFace 拉代码时会自动开启学术资源加速（`source /etc/network_turbo`）。
Gitee 是境内的，不需要也不会开。`--no-accel` 可关闭。官方注明该加速「仅供学术用途、不保证稳定」。

私有仓库用 `--git-token`，或设置 `GIT_TOKEN` / `GITHUB_TOKEN` 环境变量。凭证不会出现在
日志、错误信息、`--json` 输出里，也不会留在实例内 git remote 的配置中。

## 查 GPU 库存

```bash
autodl stock --gpu 4090        # 哪里有空闲卡
autodl stock                   # 全部地区全部型号
```

**这张表要谨慎看——数字没有它看上去那么权威。** 它来自 AutoDL 的「弹性部署 GPU 库存」接口，
这是唯一存在的容量接口，但它**不反映 Pro 实例的可用量**。2026-08-23 实测：接口显示
`westDC3` 有 140 张空闲 RTX 4090D，而在该地区创建 Pro 实例返回*「暂无库存」*；同样的请求
不带地区限制反而成功了，最终落在 `beijingDC2`。

由此得出两个结论，都已经写进工具的行为里：

- **创建实例时不会自作主张缩小地区范围。** 不传 `data_center_list` 让 AutoDL 自行调度，
  实测成功率最高。
- **只有两个地区能创建 Pro 实例**：`westDC3`（西北B区）和 `beijingDC2`（北京B区）。
  库存表里另外 9 个地区只用于弹性部署，写进 `--region` 会被提前拒绝，而不是等到 AutoDL
  回一句含糊的「请求参数错误」。表里的 `可建Pro` 列标明了这个区别。

## 成本护栏

**AutoDL 只按开机时长计费，与是否使用 GPU 无关。** 一台一小时前就跑完训练的实例，
和一台满载运行的实例，花的钱一模一样。这是无人值守的 agent 最容易烧钱的地方，
所以护栏是内建的，而不是可选项。

三道防线：

1. **实例内定时器。** `--ttl 2h` 会通过 `start_command` 在机器内部埋一个后台
   `sleep && shutdown`。即使 CLI 被杀、笔记本合盖、网络断掉，它照样会触发。
   真正保住钱包的是这一层。
2. **本地台账。** 每次执行任何命令时顺手扫一遍，发现超过 TTL 仍在运行的实例就关掉。
   用于兜住第一道防线覆盖不到的情况 —— 比如 `start_command` 静默失败，
   或者实例被手动开机但没有重新设置定时器。
3. **闲置检测。** `autodl guard idle <id>` 通过 SSH 采样 GPU 利用率，持续闲置后自动关机。

```bash
autodl guard ttl pro-xxx 2h     # 给运行中的实例设置/重设定时关机
autodl guard cancel pro-xxx     # 取消
autodl guard list               # 查看本机台账
autodl guard sweep              # 立即清理所有超时实例
autodl guard idle pro-xxx --threshold 5 --samples 6 --interval 1m
```

另外还有**余额闸门**：账号可用余额低于 `--min-balance`（默认 ¥5）时直接拒绝创建实例。
因为 AutoDL 在余额归零时并不会立刻回收实例（平台优先保数据），
余额不足的结果往往不是干净地失败，而是留下一台卡住、用不了的实例。

## Agent 契约

在次版本之间保持稳定，破坏性变更走主版本。

**`--json` 模式下 stdout 是纯 JSON。** 进度、提示、警告一律走 stderr，
所以 `autodl ... --json | jq` 永远安全。

```jsonc
// 成功
{ "ok": true, "data": { /* ... */ } }

// 失败
{ "ok": false, "error": { "code": "NO_STOCK", "message": "…", "hint": "…", "requestId": "…" } }
```

| 退出码 | 含义 | 对应 error code |
|---:|---|---|
| 0 | 成功 | — |
| 1 | 通用错误 | `GENERIC`、`API_ERROR`、`NETWORK` |
| 2 | 参数错误 | `USAGE` |
| 3 | Token 缺失或无效 | `AUTH_MISSING`、`AUTH_INVALID` |
| 4 | 资源不存在 | `NOT_FOUND` |
| 5 | 余额不足 / 被护栏拦截 | `INSUFFICIENT_BALANCE`、`GUARD_BLOCKED` |
| 6 | GPU 无库存 | `NO_STOCK` |
| 7 | 超时 | `TIMEOUT` |
| 8 | SSH 失败 | `SSH_FAILED` |

`autodl exec` 和 `autodl run` 例外：它们透传**远程命令**的退出码，
这样 `autodl exec box "make test" && deploy` 才符合直觉。

## 命令一览

| 命令 | 说明 |
|---|---|
| `login` / `logout` / `whoami` | Token 管理 |
| `account` | 余额、代金券、累计消费 |
| `ls [--status]` | 列出实例 |
| `info <id> [--show-password]` | 详情、实时 SSH 信息、资源占用 |
| `create --gpu <spec>` | 创建按量计费 Pro 实例 |
| `start` / `stop` / `rm <id>` | 开机 / 关机 / 释放 |
| `ssh <id>` | 交互式登录（多余参数原样透传给 `ssh`） |
| `exec <id> <cmd…>` | 远程执行，流式输出，透传退出码 |
| `push` / `pull <id>` | SFTP 传输，支持递归目录与忽略规则 |
| `run <cmd…>` | 建实例 → 同步 → 执行 → 回传 → 关机 |
| `deploy <仓库>` | 建实例 → 拉代码 → 装依赖 → 启动 → **关机保留数据** |
| `stock [--gpu] [--region]` | 各地区 GPU 实时库存 |
| `guard ttl\|cancel\|idle\|list\|sweep` | 成本护栏 |
| `image save <id> <name>` / `images` | 私有镜像管理 |
| `gpus` / `regions` | 查询内置目录 |
| `tui` | 交互式看板（裸 `autodl` 也进入） |
| `mcp` | 以 MCP server 运行 |

全局参数：`--json`、`--yes`、`--token`、`--base-url`、`--lang zh|en`、`--verbose`、
`--no-color`、`--no-sweep`。

`push` / `pull` 默认跳过 `.git`、`node_modules`、`__pycache__`、`.venv` 等目录，
然后应用 `.autodlignore`；没有该文件时回退到 `.gitignore`。

## SDK 用法

```ts
import {
  AutoDLClient,
  createInstance,
  execCommand,
  powerOffInstance,
  waitForRunning,
} from "@minatoaqukin/autodl-cli";

const client = new AutoDLClient({ token: process.env.AUTODL_TOKEN! });

const uuid = await createInstance(client, {
  gpuSpec: "v-48g",
  gpuNum: 1,
  imageUuid: "base-image-l2t43iu6uk",
  cudaFrom: 118,
});

await waitForRunning(client, uuid);
const { stdout } = await execCommand(client, uuid, "nvidia-smi");
console.log(stdout);
await powerOffInstance(client, uuid);
```

从包根导出的一切都属于公共 API。金额统一转换成元（`number`），时间统一为 ISO 字符串，
Go 的 `sql.NullTime` 结构会被拍平成 `string | null`。

## 官方 API 做不到的事

以下是 AutoDL 的限制，不是本工具的限制。提前知道能少走很多弯路：

- **只支持按量计费。** 没有包日/包周/包月，也没有续费接口。
- **只能创建 Pro 实例。** 即 `autodl gpus` 里那七个规格 —— 更便宜的标准实例
  官方开放 API 租不到。
- **没有可用于 Pro 的库存查询接口。** 唯一的容量接口返回的是弹性部署库存，实测与 Pro 可用量
  对不上（见上文）。创建实际上仍是盲试，无货时返回退出码 6，只能换规格重试。
- **只有两个地区能创建 Pro 实例**：`westDC3` 和 `beijingDC2`。
- **暂不支持无卡模式开机。** 官方对 `payload` 的原文是
  「`gpu：有卡开机, 暂不支持API以无卡模式开机`」——是**暂不**，不是永不。
  2026-08-24 实测确认：`cpu`、`no_gpu`、`nogpu`、`cpu_only`、`cpu-only`、`none`
  一律返回 `ServerError | 不支持的启动模式`；传空 `payload` 会被接受，
  但开出来仍然带卡（`start_mode: "gpu"`）。在官方开放之前，¥0.1/时 的无卡模式
  只能用网页控制台；等 API 支持了，这个工具会跟进。
- **必须先完成实名认证**，否则 API 根本不响应。
- **缺失的操作：** 改名、定时关机、升降配置、迁移实例、重置系统。
- **开关机后 SSH 端口和 root 密码可能变化。** 因为实例可能被调度到另一台机器。
  但并不是每次都变（实测一次 stop/start 后端口和密码完全没变），这恰恰是缓存最危险的地方：
  旧值能用的次数足够多，多到足以把 bug 藏起来。本工具每次连接都重新拉取，所以你不用操心。
- **状态变成 `running` 不代表 sshd 已经就绪。** 新建实例会在还不能接受连接时就报 `running`，
  所以本工具的连接重试之间是有退避间隔的，而不是连着打。
- **非交互 SSH 会话几乎没有 PATH。** 没有 python、没有 pip、没有 conda——它们在
  `/root/miniconda3/bin`，只有登录 profile 会加进来。所以这里所有远程命令都走 `bash -lc`。
- **释放必须等关机真正完成**，而且对已经在关机中的实例再调一次关机会报错。两者都已在内部处理。

另外值得注意：**实例连续关机 15 天会被平台释放，数据全部清空。**

已于 2026-08-23 对真实 API 做过完整验证：4090D 上跑通
创建 → SSH 执行 → SFTP 双向传输 → 关机 → 开机 → 再次执行 → 释放，总花费 ¥0.10。

GPU 规格、地区、公共基础镜像三张表是内置的静态数据，因为官方 API 没有目录接口。
如果 AutoDL 更新了，欢迎来
[提 issue](https://github.com/Minato-Aqukin/AutoDL-cli/issues)。

## 开发

```bash
npm install
npm run build
npm test            # 305 个测试，不访问网络，不产生任何费用
npm run lint
npm run typecheck
```

真实端到端测试会租用真实 GPU、产生真实费用，因此需要显式开启：

```bash
AUTODL_E2E=1 AUTODL_TOKEN=<token> npm run test:e2e
```

无论测试成功与否，`afterAll` 都会把实例关机。加上 `AUTODL_E2E_RELEASE=1` 可以顺便释放。

## 贡献

欢迎提 issue 和 PR，详见 [CONTRIBUTING.md](./CONTRIBUTING.md)。
特别欢迎两类贡献：修正内置的静态目录数据，以及补充我们尚未映射的真实 API 错误码
（AutoDL 官方并未公开这些错误码）。

## 许可证

[MIT](./LICENSE)
