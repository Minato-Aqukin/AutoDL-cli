import type {
  FileConflict,
  FileConflictResolution,
  FileTransferProgress,
  FileTransferRequest,
  FileTransferResult,
} from "./file-types.js";

export interface TransferJob {
  request: FileTransferRequest;
  state: "queued" | "running" | "conflict" | "paused" | "completed" | "cancelled";
  progress?: FileTransferProgress;
  conflict?: FileConflict;
  result?: FileTransferResult;
  error?: string;
}

export interface TransferQueueView {
  snapshot(): readonly TransferJob[];
  subscribe(listener: () => void): () => void;
  enqueue(request: Omit<FileTransferRequest, "id">): string;
  resume(id: string): void;
  cancel(id: string): void;
  resolveConflict(id: string, resolution: FileConflictResolution): void;
  hasPending(): boolean;
  pauseAll(): Promise<void>;
  dispose(): Promise<void>;
}
