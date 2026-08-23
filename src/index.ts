/**
 * Public SDK surface.
 *
 * These exports are a supported API: agents and Node programs import them directly,
 * so anything re-exported here follows semver. The CLI and MCP server are built on
 * exactly this surface — nothing is reachable from the command line that isn't here.
 */

export type { StoredConfig } from "./config/store.js";
export { readConfig, resolveToken, updateConfig, writeConfig } from "./config/store.js";
export type { Context, GlobalOptions } from "./context.js";
export { createContext } from "./context.js";
export type { BaseImage, GpuSpec, Region } from "./core/catalog.js";
export {
  assertStockRegion,
  BASE_IMAGES,
  DEFAULT_BASE_IMAGE,
  findBaseImage,
  formatCudaVersion,
  GPU_SPECS,
  parseCudaVersion,
  REGIONS,
  resolveGpuSpec,
  resolveRegion,
} from "./core/catalog.js";
export type { ClientOptions } from "./core/client.js";
export { AutoDLClient, DEFAULT_BASE_URL, redactToken } from "./core/client.js";
export { formatDuration, parseDuration } from "./core/duration.js";
export { getBalance, setNfsMount } from "./core/endpoints/account.js";
export { listPrivateImages, saveImage } from "./core/endpoints/image.js";
export type { CreateInstanceInput } from "./core/endpoints/instance.js";
export {
  createInstance,
  findInstance,
  getInstanceSnapshot,
  getInstanceStatus,
  listAllInstances,
  listInstancesPage,
  powerOffInstance,
  powerOnInstance,
  releaseInstance,
} from "./core/endpoints/instance.js";
export type { GpuStockEntry, StockQuery } from "./core/endpoints/machine.js";
export { getRegionGpuStock } from "./core/endpoints/machine.js";
export type { ErrorCode } from "./core/errors.js";
export {
  AuthError,
  AutoDLError,
  BudgetError,
  ExitCode,
  NoStockError,
  NotFoundError,
  SSHError,
  TimeoutError,
  toAutoDLError,
  UsageError,
} from "./core/errors.js";
export { estimateCost, formatRate, formatYuan, milliToYuan, yuanToMilli } from "./core/money.js";
export type { ParsedRepo } from "./core/repo.js";
export { parseRepo, redactCredentials, resolveGitToken, withCredentials } from "./core/repo.js";
export type {
  Balance,
  Instance,
  InstanceSnapshot,
  InstanceStatus,
  Pagination,
  PrivateImage,
  ServiceEndpoint,
} from "./core/schemas.js";
export {
  normalizeBalance,
  normalizeInstance,
  normalizeSnapshot,
  redactSnapshot,
} from "./core/schemas.js";
export type { RegionChoice, RegionStock, StockSnapshot } from "./core/stock.js";
export {
  chooseRegions,
  findRegionsWithStock,
  getStockByRegion,
  specForStockName,
} from "./core/stock.js";
export type { WaitOptions } from "./core/waiters.js";
export { waitForRunning, waitForShutdown, waitForStatus } from "./core/waiters.js";
export { assertBudget, resolveMinBalance } from "./guard/budget.js";
export type { IdleOptions, IdleResult } from "./guard/idle.js";
export { parseUtilisation, watchIdle } from "./guard/idle.js";
export {
  armTTLOverSSH,
  buildTTLSnippet,
  composeStartCommand,
  disarmTTLOverSSH,
  recordTTL,
  sweepExpired,
} from "./guard/ttl.js";
export { buildServer, startMcpServer } from "./mcp/server.js";
export { connectInteractive, formatSSHCommand } from "./ssh/connect.js";
export type { SSHCredentials } from "./ssh/credentials.js";
export { getCredentials, withSSH } from "./ssh/credentials.js";
export type { ExecOptions, ExecResult } from "./ssh/exec.js";
export { execCommand, execOnConnection } from "./ssh/exec.js";
export type { TransferOptions, TransferSummary } from "./ssh/transfer.js";
export { pull, push } from "./ssh/transfer.js";
export { VERSION } from "./version.js";
export type { DeployOptions, DeployResult } from "./workflow/deploy.js";
export { deployWorkflow } from "./workflow/deploy.js";
export type { RunOptions, RunResult } from "./workflow/run.js";
export { runWorkflow } from "./workflow/run.js";
