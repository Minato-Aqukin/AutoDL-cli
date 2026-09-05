# @minato-aqukin/autodl-cli

## 0.1.1

### Patch Changes

- [#2](https://github.com/Minato-Aqukin/AutoDL-cli/pull/2) [`593f43e`](https://github.com/Minato-Aqukin/AutoDL-cli/commit/593f43ed89fe1eb306bfe4869b9a11035e6799e7) Thanks [@Minato-Aqukin](https://github.com/Minato-Aqukin)! - TUI 看板改成 btm 风格的分区布局，不再是一张平铺的表。

  **实例面板**：列表还是列表，但套进带标题的边框里，标题上直接写「第几台/共几台」。
  列表变长时不再被 Ink 从画面底部挤出去——现在会跟着选中行滚动，选中的那台始终可见。

  **资源面板**：选中实例的 CPU、内存、系统盘、数据盘，条形图 + 百分比 + 实际用量，
  CPU 还带一条最近 32 个采样点的火花图（10 秒一个点，约五分钟）。这是判断「任务到底还在
  不在跑」最直接的一眼——之前看板只能告诉你实例是开着的，不能告诉你它在干活。

  快照现在每次轮询都会重新拉一次（只拉选中的那一台），所以这些数字是活的。之前是拉一次就
  永久缓存，CPU 条会一直停在你刚打开时的那个读数上。

  **计费面板**：本机费率与本次已产生、TTL 还剩多久、账户余额，以及**续航**——按当前所有
  运行中实例的合计费率算，余额还能撑多久。AutoDL 按开机时长计费，这个数字决定要不要让它
  过夜。

  **诚实规则照旧**：没测到的值画成横杠，不画空条也不写 0%——空条会被读成「测过了，是零」。
  未运行的实例直接说明「AutoDL 只对运行中的实例暴露用量」，而不是画四条空条。
  另外任何非零读数至少保留一格实心，3% 在十格条上会被四舍五入抹掉。

  **窄屏和矮屏会主动让位**，而不是让 Ink 去挤：

  - 终端不够高时整个放弃两个面板，把行数还给列表。
  - 不够宽时两个面板从并排改成上下堆叠。
  - 再窄就按「地区 → GPU → 已开机」的顺序丢列。之前列宽写死，一超出宽度 Ink 不是截断而是
    把每一行折成两行，整个列表变成隔行空一行的碎片。

- [#2](https://github.com/Minato-Aqukin/AutoDL-cli/pull/2) [`593f43e`](https://github.com/Minato-Aqukin/AutoDL-cli/commit/593f43ed89fe1eb306bfe4869b9a11035e6799e7) Thanks [@Minato-Aqukin](https://github.com/Minato-Aqukin)! - 修复 TUI 的一批问题，核心是「屏幕上写的键」和「真正生效的键」对不上。

  **快捷键提示与实际按键不一致**：底部提示栏只看 `view`，而确认弹窗、新建向导、帮助页都会
  把键盘从看板手里接管过去。结果是释放/退出登录的二次确认盖在屏幕中间时，下面照旧写着
  `s 开机 · x 关机 · ctrl+d 释放 · q 退出`——这几个键此时全都不做事，`q` 也不是退出程序
  而是取消弹窗。提示栏改为跟着「当前谁在接管键盘」走；确认弹窗的键抽成一个常量，弹窗自身
  和提示栏共用，不会再各写各的。

  **选中行与实际操作的行会错开**：只有取实例时做了钳制，高亮用的下标没有。停在最后一行时
  列表变短（比如刚释放掉一台），表格会一行都不高亮，而 `s` / `x` 照样作用在末尾那台上。

  **详情页的实例消失后不会退回**：实例被释放后详情页拿不到数据，于是在「实例详情」的标题和
  详情页的键提示下面渲染出一整个看板。现在会退回看板。

  **开机/关机进行中会把详情页锁死**：之前只要有操作在跑，看板以外的所有按键（包括 Esc）
  全被丢弃，人就困在详情页直到操作结束。改成只挡会再发起一次操作的键。

  **新建向导忽略所选镜像的 CUDA 版本**：向导让你选镜像、也把镜像的 CUDA 版本显示出来，
  但创建时固定发 `cuda_v_from: 118`。选了 CUDA 11.3 的镜像也一样。CLI、MCP、`run` 和
  `deploy` 都是按所选镜像取的，现在 TUI 与它们一致。

  **SSH 信息在关机重开后仍是旧的**：实例快照被永久缓存，而 AutoDL 每次开机都会重新分配
  SSH 端口和 root 密码。停机再开之后，`c` 复制到剪贴板的是连不上的旧命令，详情页显示的也是
  旧密码。快照现在跟着开机时间失效，过期就重新拉取。

  **消息提示的定时器没有清理**：前一条消息的定时器会把后一条提前抹掉；退出 TUI 时它还会
  吊住事件循环，终端已经恢复了却要再等最多 6 秒才回到 shell 提示符。

  **库存页游标会走到 -1**：列表为空时按下方向键，下标变成 -1。

- [#2](https://github.com/Minato-Aqukin/AutoDL-cli/pull/2) [`593f43e`](https://github.com/Minato-Aqukin/AutoDL-cli/commit/593f43ed89fe1eb306bfe4869b9a11035e6799e7) Thanks [@Minato-Aqukin](https://github.com/Minato-Aqukin)! - 修复实例表的列错位，并加上分隔线。

  **列错位**：表头行没有数据行都有的那个光标格，于是整张表的每一个值都比命名它的表头右移
  了恰好一列。因为偏移量是均匀的，看起来像「列没对齐」，而不像少了一个字符。表头现在也预留
  这一格。

  **分隔线**分两种，职责不同所以粗细不同：

  - 表头与第一台实例之间是一条实线，无论几台实例都画。它说明「标签到此为止，下面是数据」。
  - 实例与实例之间是虚线，只把一台和下一台分开。它按行计费——每条占一行——所以只在所有实例
    仍能全部显示的前提下才画；一旦某条线会把某台实例挤出面板，就整体放弃。一条分隔线不值一
    台看不见的实例。

  如果你的终端把「East Asian Ambiguous」类字符（`×` `—` `≈` `¥` `›`）按双宽渲染，
  表格仍会有残余偏移，且越靠右越明显。上面这个修复解决的是与终端配置无关的那一列。

## 0.1.0

### Minor Changes

- [`e44382d`](https://github.com/Minato-Aqukin/AutoDL-cli/commit/e44382dde21ab1b5ec047da60647b4cd02de15e6) Thanks [@Minato-Aqukin](https://github.com/Minato-Aqukin)! - 新增 `autodl deploy`：开卡部署代码托管平台的项目

  - 建实例 → 拉代码 → 自动探测并安装依赖 → 启动 → **默认关机而非释放**，数据保留可复用
  - `--instance <id>` 复用已关机的实例：开机 → `git pull` → 重新部署，环境不用重建
  - 代码放数据盘 `/root/autodl-tmp/<仓库名>`（系统盘固定 30G 且会被打包进镜像）
  - 依赖探测顺序：`environment.yml` → `requirements.txt` → `pyproject.toml` → `package.json`
  - GitHub / HuggingFace 自动开启学术资源加速；Gitee 不需要也不会开
  - 私有仓库支持 `--git-token`，凭证不进日志、不进 `--json`、不留在实例内的 git remote
  - 默认前台流式输出并透传退出码，`--detach` 转后台并给出访问方式

  新增 `autodl stock`：查询各地区 GPU 实时库存。

  同时新增 MCP 工具 `autodl_deploy` 与 `autodl_gpu_stock`。

  **行为变更**：`run --workdir`、`push` 默认目标、MCP 的 `autodl_upload` / `autodl_run`
  从 `/root/autodl-cli`（系统盘）改为 `/root/autodl-tmp/autodl-cli`（数据盘），
  以符合 AutoDL 官方的目录规范。

  **修复**：`rm --force`、以及 `run` / `deploy` 的 `--on-finish release` 之前会在实例
  仍处于 `shutting_down` 时就调用释放接口，被 AutoDL 拒绝。现在会先等待关机完成。

  **目录数据修正**：`beijingDC3` 是 V100 专区（非北京 C 区）、`beijingDC4` 是 L20 专区、
  `neimengDC3` 是内蒙 B 区（非内蒙 C 区）、`yangzhouDC1` 是 3090 专区。

  **地区白名单**：实测确认 Pro 实例只能在 `westDC3` 与 `beijingDC2` 创建，其余 9 个地区
  仅用于弹性部署，传进 `--region` 会被 AutoDL 以「请求参数错误」拒绝。现在提前拦截并给出
  可操作的提示。不指定 `--region` 时不再自作主张缩小范围——实测不带地区限制的创建成功率更高
  （指定 westDC3 报「暂无库存」的同时，不限地区的同一请求成功落在了 beijingDC2）。

  **重要修复**：远程命令改为通过登录 shell（`bash -lc`）执行。AutoDL 镜像把
  python/pip/conda 放在 `/root/miniconda3/bin`，非交互 SSH 会话拿不到这个路径，
  实测 `pip install` 会以退出码 127 失败。这同时影响 `autodl exec`。

  **重要修复**：`--detach` 拼出的命令存在 shell 语法错误（`& &&`），且从不校验后台进程
  是否真的活着，因此会在失败时报告成功。现在命令语法正确、stdin 重定向自 /dev/null
  （否则后台进程会占住 SSH 通道），并在启动后确认进程存活，死了就带日志报错。

  **行为修正**：`--detach` 时 `finalAction` 返回 `keep` 而非 `poweroff`——实例确实被保留运行。

- [`ce3c187`](https://github.com/Minato-Aqukin/AutoDL-cli/commit/ce3c187444931eca6e044086274b5356120c2263) Thanks [@Minato-Aqukin](https://github.com/Minato-Aqukin)! - 首个版本：面向人与 agent 的 AutoDL 实例管理工具。

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

- [`9abcb39`](https://github.com/Minato-Aqukin/AutoDL-cli/commit/9abcb3965dcbcdf1bdfaa817421ddfcaa8acae15) Thanks [@Minato-Aqukin](https://github.com/Minato-Aqukin)! - TUI 三项改进。

  **`c` 键真的复制了。** 之前只是把命令显示在状态栏。现在写入系统剪贴板：
  Linux 依次尝试 `wl-copy` / `xclip` / `xsel`，macOS 用 `pbcopy`，Windows 用 `clip`；
  都不可用时退回 **OSC 52**——让终端自己去写剪贴板，这条路在 SSH 会话和容器里也能 work。
  走 OSC 52 时会明说"已请求复制"而不是"已复制"，因为终端不会回应是否成功。

  **只复制 SSH 命令，不复制 root 密码**，密码仍然只显示在状态栏。剪贴板任何进程都能读，
  把 root 密码放进去风险不对称。

  **界面占满终端。** 根容器按终端行列数铺满，状态栏钉在底部，并监听 resize 事件实时跟随。

  **头部显示账号与余额。** 账号 ID、余额、代金券、累计消费，余额每 60 秒单独刷新一次
  （比实例列表慢，因为它变化少得多）。

  一个受限于平台的说明：**AutoDL 开放 API 没有用户信息接口**（`/dev/user/info` 等五个路径实测全部 404），
  所以显示的是从 token 里本地解出的账号 ID，没有用户名可用。余额拉取失败时显示
  「余额获取失败」而不是 ¥0.00——后者会被读成"没钱了"。

- [`c6776e4`](https://github.com/Minato-Aqukin/AutoDL-cli/commit/c6776e4c405aa2cb906be11d4e086ffcb00d3876) Thanks [@Minato-Aqukin](https://github.com/Minato-Aqukin)! - 新增交互式看板 `autodl tui`（交互式终端下裸 `autodl` 也进入）。

  - **实例看板**：状态、GPU、地区、已开机时长、**估算费用**、TTL 剩余，每 10 秒自刷新
  - **快捷键**：`s` 开机 / `x` 关机 / `Enter` 详情 / `c` 复制 SSH / `D` 释放（二次确认，默认停在"取消"）/ `g` 库存 / `n` 新建 / `r` 刷新
  - **库存浏览器**：各地区 GPU 实时空闲量，标出哪些地区能建 Pro 实例
  - **创建向导**：GPU → 镜像 → TTL，确认页同时给出等价的 `autodl create` 命令

  用 Ink（React + Yoga），与 Claude Code 同一技术栈。Ink 和 React 被打进产物而不是
  声明为可安装依赖，因此用户装到的仍然是一个包；TUI 独立成 chunk 懒加载，
  `mcp` / `ls` / `exec` 等热路径运行时完全不解析它。tarball 从 184KB 增至 380KB。

  **费用显示的两处诚实约束**：单价只能从运行中实例的 snapshot 获取，因此已关机实例
  只显示时长、不显示金额；单价尚未拉取时汇总栏会明确标注"总额偏低"，而不是安静少报。

  **契约不变**：`--json` 或非 TTY（管道 / CI / agent 调用）下 TUI 一律以退出码 2 拒绝启动，
  非交互环境下裸 `autodl` 仍然打印帮助。

  **破坏性变更**：`engines` 从 `>=20` 升至 `>=22`。Node 20 已于 2026-04-30 EOL，
  且 Ink 7 硬性要求 Node ≥22。CI 矩阵相应改为 22 / 24。

  同时不再发布 sourcemap（本地构建仍生成），tarball 因此减少约 600KB。

### Patch Changes

- [`5447577`](https://github.com/Minato-Aqukin/AutoDL-cli/commit/5447577e667efe4197fc6c6f7e75976d141cb8f0) Thanks [@Minato-Aqukin](https://github.com/Minato-Aqukin)! - SSH 连接重试改为带退避的三次尝试。

  真实环境验证发现：实例状态变成 `running` 时 sshd 往往还没开始接受连接，
  而原来的两次尝试是连着打的、中间没有任何间隔，靠的只是两次 API 调用的偶然延迟。
  现在每次尝试之间会等待 2s / 5s / 8s，并且仍然每次都重新拉取凭证
  （同时覆盖「端口变了」和「sshd 还没起来」两种失败）。

  同时修正文档：AutoDL 开关机后 SSH 端口和密码**可能**变化，但并非必然
  （实测一次 stop/start 后两者完全没变）。不缓存的理由因此更强而不是更弱——
  旧值能用的次数足够多，多到足以把 bug 藏起来。

- [`5f1ced3`](https://github.com/Minato-Aqukin/AutoDL-cli/commit/5f1ced3c98a156af8e2b5ceba3f985e4174cb245) Thanks [@Minato-Aqukin](https://github.com/Minato-Aqukin)! - TUI logo 改版，释放快捷键改为 Ctrl+D。

  **Logo**：参照官方标识重做——白色漩涡图标 + AUTODL 像素字，白字蓝底，外面加圆角边框。
  字体从 2 行放大到 5 行像素网格。全部使用 Block Elements 区的字符，
  这类字符在配置了 CJK 的终端里仍是单宽；换成方框绘制或其他歧义宽度字符会被判成双宽而歪掉。
  终端窄于 56 列时自动退化为纯文本。

  图标只画漩涡本身、不画外框——**蓝底就是徽章**，再画一圈白框会得到官方标识里没有的白色方块。

  **释放快捷键 `D` → `Ctrl+D`**。释放会永久清空实例数据，而原来的绑定和一个什么都不做的
  按键只差一次手滑。新增测试确认普通 `D`、`d` 都不再触发确认框。

  顺带把按键提示里的 `c 复制SSH` 改成 `c 显示SSH`——它本来就只是把命令显示在状态栏，
  并没有写入剪贴板，标成"复制"会让人以为已经复制了。

- [`f16e7e4`](https://github.com/Minato-Aqukin/AutoDL-cli/commit/f16e7e4dd67e39b79485fb7b779111414ca38b34) Thanks [@Minato-Aqukin](https://github.com/Minato-Aqukin)! - TUI 现在能在未配置 Token 的机器上启动。

  之前 `autodl` 进 TUI 前会先解析 Token，没有就直接报错退出——而看板既然成了默认入口，
  第一次用的人敲下 `autodl` 就该落到一个有用的地方，而不是一条让他去翻文档的报错。

  现在没有 Token 时会进登录页，给两个选项：**配置 Token 登入**、**退出**。
  粘贴的 Token 会先调用 wallet/balance 验证，通过后才以 0600 权限落盘，然后直接进看板。
  已配置 Token 的情况保持不变，直接进看板。

  输入框会遮蔽内容但显示字符数（JWT 太长，没有这个反馈没法确认粘贴是否成功），
  自动剥离粘贴带进来的控制字符，Esc 返回菜单、Ctrl-C 直接退出——`q` 不作为退出键，
  因为它必须能作为 Token 的合法字符输入。

- [`a0a8a48`](https://github.com/Minato-Aqukin/AutoDL-cli/commit/a0a8a480b7b5e44faeeb2d5058b9347a9ecb21a0) Thanks [@Minato-Aqukin](https://github.com/Minato-Aqukin)! - TUI 支持退出登录，Token 失效时也能退回登录页。

  看板按 `ctrl+l` 退出登录：二次确认后清除本地 Token，回到 TUI 自己的登录页。确认框会说明
  清的是哪个文件；如果本次会话的 Token 来自 `AUTODL_TOKEN` 或 `--token`，还会直说它们的
  优先级高于接下来保存的 Token——否则退出登录、粘贴新 Token 之后，跑的仍是那个旧的。
  带 ctrl 而不是单个 `l`，是因为 `l` 离 `j`/`k` 只有一个键，一次手滑不该让人重新粘一遍 JWT。

  **顺带统一**：需要修饰键的快捷键一律走 ctrl，按不按 shift 都认（终端对 ctrl+d 与
  ctrl+shift+d 发的是同一个控制字节），提示统一小写显示 `ctrl+d` / `ctrl+l`——`Ctrl+D`
  那样的写法会让人以为还得按住 shift。

  Token 在看板开着的时候失效（过期、被重置、实名状态变化），之前只会在状态栏留下一条
  像是暂时故障的报错，表格停在失效前的数字上，后台继续每 10 秒撞一次 401，唯一的出路是
  退到 shell。现在只要任何一个请求——实例列表、余额、库存、开关机——被判定为鉴权失败，
  就会停掉全部轮询，原样显示 API 给的原因，并给出 `Enter` 重新登入 / `q` 退出两个选择。
  重新登入是完整重挂载，上一个账号的实例、余额和错误状态不会带进新会话。

  **顺带修复**：快捷键帮助页改为两列。列表长到 12 条之后，一行一条会超出 24 行的终端，
  而 Ink 既不滚动也不报错，只是把末尾的快捷键和 logo 的一行一起挤出画面。

- [`0bb1853`](https://github.com/Minato-Aqukin/AutoDL-cli/commit/0bb18536bfb4dfee4476b6a9d63dba798bb159cf) Thanks [@Minato-Aqukin](https://github.com/Minato-Aqukin)! - TUI 四处修正。

  **杂散输出污染界面。** core 层的 `note` / `warn` / `debug` 直接写 stderr——「正在开机…」、
  清理告警、调试行——在全屏界面里会落在渲染帧中间，把排版冲乱。新增 quiet 模式，
  TUI 挂载期间静音这些写入，相同信息改由状态栏呈现。

  **界面会接在残留输出后面滚动。** 改用终端备用屏（`ESC[?1049h`），TUI 拥有独立的固定画布；
  退出时还原，提示符和滚动历史完好。正常退出、Ctrl-C、SIGTERM、进程退出四条路径都会还原，
  否则用户会被留在一块空白屏上。

  **表格因实例名过长而错位。** 列渲染器输出的是未裁剪全文，padding 却按裁剪后的宽度计算，
  于是一个长名字会把它之后的每一列都推歪。现在裁剪由表格统一完成并把结果交给渲染器，
  中英混排与纯中文名的列位置完全一致。

  **加了 logo。** 半块字符绘制的 AUTODL 字样，终端窄于 46 列时自动退化为纯文本。
  顺带修掉一处：宽度检测原本用 `?? 80`，而部分终端和 pty 会把列数报成 0，
  `??` 兜不住 0，会导致 logo 在正常宽度下也静默退化——改用 `||`。

- [`f7e2c09`](https://github.com/Minato-Aqukin/AutoDL-cli/commit/f7e2c090403e1beea746b9b8b89f9e8e9ecd7863) Thanks [@Minato-Aqukin](https://github.com/Minato-Aqukin)! - TUI 字样换成实心块体，配色改为逐行白 → 蓝渐变。

  字样六行分别取 `#FFFFFF → #D5E1FD → #AAC4FB → #80A6F9 → #5589F7 → #2B6BF5`，
  末行是 AutoDL 的品牌蓝。颜色以 hex 给出，由 chalk 按终端能力选择真彩 / 256 色 / 16 色，
  不由我们猜测。

  **同时纠正一处此前写错的技术判断**：之前的注释和提交信息里称「块元素字符是单宽，
  不像方框绘制字符会被判双宽」——这是错的。`█`(U+2588)、`▀`(U+2580)、`▄`(U+2584)
  的东亚宽度属性同样是 **Ambiguous**，和 `╗║═` 属于同一类。旧版 logo 因此在
  「Ambiguous 视为双宽」的终端里会逐字符撕开（同一行里混了 Narrow 的 `▟▘` 和
  Ambiguous 的 `▀`）。新字样至少宽度是一致的，注释也改成如实说明这是为视觉效果
  做的取舍，而不是一个不存在的安全保证。

  字样 57 列，加账号面板后需要 78 列；不足时退化为单行紧凑头部（实测 100 / 80 列显示完整，
  76 列以下退化）。因为宽度已经吃满 80 列终端，这一版不带漩涡图标。

- [`ef6ee96`](https://github.com/Minato-Aqukin/AutoDL-cli/commit/ef6ee9651a9a8bd69fa535d1875fe499548f4bf7) Thanks [@Minato-Aqukin](https://github.com/Minato-Aqukin)! - 关机后校验是否真的生效，而不是假定成功。

  实测中观察到：对一台**仍在启动中**的实例调用 `power_off`，实例并没有停下来。
  原来的代码在这种情况下会照常报告「已关机，计费已停止」，并把它从 TTL 台账里移除——
  于是那台机器会一直计费下去，而这正是成本护栏本该防住的事。

  现在 `autodl stop` 会复查状态：没停下来就如实告警并返回非零退出码；
  `sweepExpired` 也一样，未确认停止的实例会保留在台账里，下次命令继续重试。

  同时把「不支持无卡模式」从「文档这么说」升级为实测结论：`cpu` / `no_gpu` / `nogpu` /
  `cpu_only` / `cpu-only` / `none` 全部返回 `不支持的启动模式`，传空 `payload` 虽被接受
  但开出来仍带卡（`start_mode: "gpu"`）。
