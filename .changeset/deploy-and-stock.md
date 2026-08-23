---
"@minatoaqukin/autodl-cli": minor
---

新增 `autodl deploy`：开卡部署代码托管平台的项目

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

**目录数据修正**：`beijingDC3` 是 V100专区（非北京C区）、`beijingDC4` 是 L20专区、
`neimengDC3` 是内蒙B区（非内蒙C区）、`yangzhouDC1` 是 3090专区。

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
