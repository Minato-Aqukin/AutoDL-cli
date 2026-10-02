import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";
import type { PrivateImage } from "../../core/schemas.js";
import { formatBytes, formatTime } from "../../output/format.js";
import { type ListNote, ListPanel } from "../components/list-panel.js";
import type { Column } from "../components/table.js";
import { sanitizeInput } from "../text.js";

/**
 * Private images: the list, and saving an instance into a new one.
 *
 * That is everything the open API offers. Deleting, renaming and sharing exist only in
 * the web console, so the screen says where to do them rather than leaving the user to
 * hunt for a key that cannot exist.
 */

const columns: Column<PrivateImage>[] = [
  { header: "名称", width: 20, text: (image) => image.name || "—" },
  { header: "镜像 UUID", width: 16, text: (image) => image.imageUuid },
  {
    header: "状态",
    width: 10,
    text: (image) => image.status ?? "—",
    render: (image, clipped) =>
      image.status === "finished" ? <Text color="green">{clipped}</Text> : <Text>{clipped}</Text>,
  },
  { header: "大小", width: 9, text: (image) => formatBytes(image.sizeBytes) },
  { header: "创建时间", width: 11, text: (image) => formatTime(image.createdAt) },
];

const NOTES: ListNote[] = [
  { text: "保存：在实例详情页按 i。只打包系统盘，数据盘 /root/autodl-tmp 的内容不在镜像里。" },
  { text: "删除、重命名、共享：开放 API 未提供，请到 AutoDL 网页控制台操作。" },
];

interface ImagesScreenProps {
  images: PrivateImage[];
  selectedIndex: number;
  loading: boolean;
  error: string | null;
  width: number;
  height: number;
}

export function ImagesScreen({
  images,
  selectedIndex,
  loading,
  error,
  width,
  height,
}: ImagesScreenProps): React.ReactElement {
  return (
    <ListPanel
      title="私有镜像"
      columns={columns}
      rows={images}
      selectedIndex={selectedIndex}
      keyFor={(image) => image.imageUuid}
      emptyMessage={
        loading
          ? "正在读取私有镜像…"
          : error
            ? `读取失败：${error}`
            : "当前账号没有私有镜像。在实例详情页按 i 保存一个。"
      }
      notes={NOTES}
      width={width}
      height={height}
    />
  );
}

/** Exported for the status bar, like `CONFIRM_KEYS`: one copy of the key list. */
export const SAVE_IMAGE_KEYS = "输入镜像名称 · Enter 保存 · Esc 取消";

interface SaveImagePromptProps {
  instance: { uuid: string; name: string | null };
  onSubmit: (name: string) => void;
  onCancel: () => void;
}

export function SaveImagePrompt({
  instance,
  onSubmit,
  onCancel,
}: SaveImagePromptProps): React.ReactElement {
  const [name, setName] = useState("");

  useInput((input, key) => {
    // Nothing ctrl-modified is text, and ctrl+c belongs to nobody while a modal is up.
    if (key.ctrl) return;
    if (key.escape) return onCancel();
    if (key.return) {
      // Enter on an empty field does nothing: there is no name to save under.
      if (name.trim()) onSubmit(name.trim());
      return;
    }
    if (key.backspace || key.delete) {
      setName((v) => v.slice(0, -1));
      return;
    }
    if (key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
    const clean = sanitizeInput(input);
    if (clean) setName((v) => v + clean);
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>保存实例 {instance.name || instance.uuid} 为私有镜像</Text>
      <Text dimColor>只打包系统盘（环境）；数据盘 /root/autodl-tmp 的内容不在镜像里。</Text>
      <Box marginTop={1}>
        <Text>镜像名称：</Text>
        <Text color="green">{name}</Text>
        <Text inverse> </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{SAVE_IMAGE_KEYS}</Text>
      </Box>
    </Box>
  );
}
