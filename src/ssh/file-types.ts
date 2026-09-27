export type FileSide = "local" | "remote";
export type ConflictChoice = "overwrite" | "skip" | "keep-both";

export interface FileEntry {
  name: string;
  path: string;
  kind: "directory" | "file" | "symlink" | "other";
  size: number;
  mtime: number;
}

export interface FileTransferRequest {
  id: string;
  uuid: string;
  direction: "upload" | "download";
  sources: string[];
  destination: string;
  sync: boolean;
  checksum: boolean;
}

export interface FileTransferProgress {
  file: string;
  transferred: number;
  total: number;
  filesDone: number;
  filesTotal: number;
  bytesPerSecond: number;
}

export interface FileConflict {
  source: string;
  destination: string;
  sourceSize: number;
  destinationSize: number;
}

export interface FileConflictResolution {
  choice: ConflictChoice;
  applyToAll: boolean;
}

export interface FileTransferResult {
  files: number;
  bytes: number;
  skipped: string[];
}

export interface FileTransferCallbacks {
  onProgress: (progress: FileTransferProgress) => void;
  onConflict: (conflict: FileConflict) => Promise<FileConflictResolution>;
}
