/**
 * Minimal message catalogue. AutoDL's user base is overwhelmingly Chinese-speaking,
 * so zh is the default; `--lang en` / `AUTODL_LANG=en` switches.
 */

export type Lang = "zh" | "en";

const MESSAGES = {
  zh: {
    "account.balance": "余额",
    "account.accumulated": "累计消费",
    "account.voucher": "代金券",
    "login.prompt": "请粘贴 AutoDL 开发者 Token",
    "login.hint": "控制台 → 设置 → 开发者 Token（需已完成实名认证）",
    "login.verifying": "正在验证 Token…",
    "login.success": "Token 已验证并保存到",
    "login.cancelled": "已取消",
    "logout.done": "已清除本地 Token",
    "instance.none": "当前账号下没有实例",
    "instance.creating": "正在创建实例…",
    "instance.created": "实例已创建",
    "instance.waiting": "等待实例就绪…",
    "instance.ready": "实例已就绪",
    "instance.poweringOn": "正在开机…",
    "instance.poweringOff": "正在关机…",
    "instance.released": "实例已释放",
    "instance.confirmRelease": "释放后实例数据将被永久清空，确认释放",
    "guard.armed": "已设置到期自动关机",
    "guard.armFailed": "实例内定时关机未能设置，已改为仅依赖本地台账",
    "guard.sweptOne": "已自动关闭超时实例",
    "guard.blocked": "余额低于阈值，已阻止创建实例",
    "ssh.connecting": "正在连接…",
    "ssh.refreshing": "SSH 凭证可能已变化，正在重新获取…",
    "run.syncing": "正在同步文件…",
    "run.executing": "正在远程执行…",
    "run.pulling": "正在回传产物…",
    "run.finished": "执行完成",
    "run.cleanup": "正在收尾…",
    "common.cancelled": "已取消",
    "common.yes": "是",
    "common.no": "否",
  },
  en: {
    "account.balance": "Balance",
    "account.accumulated": "Total spend",
    "account.voucher": "Vouchers",
    "login.prompt": "Paste your AutoDL developer token",
    "login.hint": "Console → Settings → Developer Token (requires identity verification)",
    "login.verifying": "Verifying token…",
    "login.success": "Token verified and saved to",
    "login.cancelled": "Cancelled",
    "logout.done": "Local token cleared",
    "instance.none": "No instances on this account",
    "instance.creating": "Creating instance…",
    "instance.created": "Instance created",
    "instance.waiting": "Waiting for the instance to be ready…",
    "instance.ready": "Instance ready",
    "instance.poweringOn": "Powering on…",
    "instance.poweringOff": "Powering off…",
    "instance.released": "Instance released",
    "instance.confirmRelease": "Releasing wipes all data permanently. Release",
    "guard.armed": "Auto-shutdown timer armed",
    "guard.armFailed": "Could not arm the in-instance timer; falling back to the local ledger",
    "guard.sweptOne": "Auto-stopped an instance past its TTL",
    "guard.blocked": "Balance below threshold; instance creation blocked",
    "ssh.connecting": "Connecting…",
    "ssh.refreshing": "SSH credentials may have rotated, refreshing…",
    "run.syncing": "Syncing files…",
    "run.executing": "Running remotely…",
    "run.pulling": "Downloading artefacts…",
    "run.finished": "Done",
    "run.cleanup": "Cleaning up…",
    "common.cancelled": "Cancelled",
    "common.yes": "yes",
    "common.no": "no",
  },
} as const;

export type MessageKey = keyof (typeof MESSAGES)["zh"];

let current: Lang = "zh";

export function resolveLang(explicit?: string): Lang {
  const candidate = (explicit ?? process.env.AUTODL_LANG ?? "").toLowerCase();
  if (candidate.startsWith("en")) return "en";
  if (candidate.startsWith("zh")) return "zh";
  return "zh";
}

export function setLang(lang: Lang): void {
  current = lang;
}

export function getLang(): Lang {
  return current;
}

export function t(key: MessageKey): string {
  return MESSAGES[current][key] ?? MESSAGES.zh[key] ?? key;
}
