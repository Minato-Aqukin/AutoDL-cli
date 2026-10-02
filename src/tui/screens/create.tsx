import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";
import { BASE_IMAGES, DEFAULT_BASE_IMAGE, GPU_SPECS, type GpuSpec } from "../../core/catalog.js";
import { formatDuration, parseDuration } from "../../core/duration.js";
import type { PrivateImage } from "../../core/schemas.js";
import { stringWidth } from "../../output/format.js";
import { headerRows } from "../components/header.js";
import { STATUS_ROWS } from "../components/statusbar.js";
import { clip } from "../components/table.js";
import { centeredStart } from "../scroll.js";

/**
 * Guided instance creation.
 *
 * Deliberately offers no region picker: creating without a `data_center_list` was
 * measured to succeed where naming a region failed, because Pro capacity does not track
 * the elastic-deployment stock we can see. The wizard says so rather than exposing a
 * choice that only lowers the hit rate.
 */

/** Listed last, so the default stays a timer and going without one takes deliberate scrolling. */
const NO_TTL = "不限时";
const TTL_CHOICES = ["30m", "1h", "2h", "4h", "8h", NO_TTL];
const NO_TTL_WARNING = "不会自动关机：实例会一直计费，直到手动关机。";

/**
 * The CUDA floor sent for a private image.
 *
 * The image list carries no CUDA version, and `autodl create --image <private>` falls
 * back to the same 11.8 — so the equivalent command printed below stays equivalent.
 */
const PRIVATE_IMAGE_CUDA = "11.8";
/** Only a finished save can boot an instance; the rest are still being written. */
const USABLE_IMAGE_STATUS = "finished";
const PRIVATE_NAME_WIDTH = 24;

/**
 * Rows the wizard spends around its list: border, title, the margin and label above the
 * list, one note row under it, and the margin and key line at the bottom.
 */
const WIZARD_CHROME = 8;

export interface CreateDraft {
  spec: GpuSpec;
  imageUuid: string;
  /** The CUDA floor the wizard showed for the image; sent as `cuda_v_from`. */
  cuda: string;
  /** `null`: no shutdown timer, exactly as `autodl create` without `--ttl`. */
  ttlSeconds: number | null;
}

/** The equivalent CLI invocation, so the wizard teaches the command it replaces. */
export function equivalentCommand(draft: CreateDraft): string {
  const parts = ["autodl create", `--gpu ${draft.spec.id}`];
  if (draft.ttlSeconds) parts.push(`--ttl ${formatDuration(draft.ttlSeconds)}`);
  if (draft.imageUuid !== DEFAULT_BASE_IMAGE) parts.push(`--image ${draft.imageUuid}`);
  parts.push("--wait");
  return parts.join(" ");
}

interface ImageOption {
  uuid: string;
  label: string;
  /** How the confirmation step names the choice. */
  summary: string;
  cuda: string;
  isPrivate: boolean;
}

type Step = "gpu" | "image" | "ttl" | "confirm";

interface CreateWizardProps {
  busy: boolean;
  /** Loaded by the caller when the wizard opens, so they can arrive after mount. */
  privateImages: PrivateImage[];
  privateImagesLoading: boolean;
  privateImagesError: string | null;
  /** Terminal size: long lists scroll rather than get squeezed out of the frame. */
  width: number;
  height: number;
  onSubmit: (draft: CreateDraft) => void;
  onCancel: () => void;
}

/**
 * A selectable list, windowed around the cursor once it outgrows `maxRows`.
 *
 * A windowed list gives one of its rows to a position line, so the user can tell that
 * there is more above or below.
 */
function Choice<T>({
  items,
  index,
  label,
  keyFor = label,
  maxRows,
}: {
  items: T[];
  index: number;
  label: (item: T) => string;
  keyFor?: (item: T) => string;
  maxRows: number;
}): React.ReactElement {
  const windowed = items.length > maxRows;
  const visible = windowed ? Math.max(1, maxRows - 1) : items.length;
  const start = centeredStart(index, items.length, visible);
  return (
    <Box flexDirection="column">
      {items.slice(start, start + visible).map((item, offset) => {
        const selected = start + offset === index;
        return (
          <Text key={keyFor(item)} inverse={selected}>
            {selected ? "› " : "  "}
            {label(item)}
          </Text>
        );
      })}
      {windowed ? (
        <Text dimColor>
          {"  "}↑↓ {index + 1}/{items.length}
        </Text>
      ) : null}
    </Box>
  );
}

export function CreateWizard({
  busy,
  privateImages,
  privateImagesLoading,
  privateImagesError,
  width,
  height,
  onSubmit,
  onCancel,
}: CreateWizardProps): React.ReactElement {
  const [step, setStep] = useState<Step>("gpu");
  const [gpuIndex, setGpuIndex] = useState(0);
  // Tracked by UUID, not position: private images load after the wizard opens and
  // land above the base images, which would otherwise slide the cursor onto another one.
  const [imageUuid, setImageUuid] = useState(DEFAULT_BASE_IMAGE);
  const [ttlIndex, setTtlIndex] = useState(2);

  const usable = privateImages.filter((image) => image.status === USABLE_IMAGE_STATUS);
  const unfinished = privateImages.length - usable.length;
  // The account's own images first: a saved environment is why anyone has one.
  const options: ImageOption[] = [
    ...usable.map((image) => {
      const name = clip(image.name || image.imageUuid, PRIVATE_NAME_WIDTH);
      return {
        uuid: image.imageUuid,
        label: `私有  ${name}${" ".repeat(Math.max(0, PRIVATE_NAME_WIDTH - stringWidth(name)))} ${image.imageUuid}`,
        summary: `私有镜像 ${image.name || image.imageUuid}`,
        cuda: PRIVATE_IMAGE_CUDA,
        isPrivate: true,
      };
    }),
    ...BASE_IMAGES.map((image) => ({
      uuid: image.uuid,
      label: `公共  ${image.framework.padEnd(11)} CUDA ${image.cuda.padEnd(5)} py${image.python}`,
      summary: `${image.framework} CUDA ${image.cuda}`,
      cuda: image.cuda,
      isPrivate: false,
    })),
  ];
  const imageIndex = Math.max(
    0,
    options.findIndex((option) => option.uuid === imageUuid),
  );

  const spec = GPU_SPECS[gpuIndex] as GpuSpec;
  const image = options[imageIndex] as ImageOption;
  const ttl = TTL_CHOICES[ttlIndex] as string;
  const draft: CreateDraft = {
    spec,
    imageUuid: image.uuid,
    cuda: image.cuda,
    ttlSeconds: ttl === NO_TTL ? null : parseDuration(ttl),
  };
  const maxRows = Math.max(3, height - headerRows(width) - STATUS_ROWS - WIZARD_CHROME);

  const lengths: Record<Step, number> = {
    gpu: GPU_SPECS.length,
    image: options.length,
    ttl: TTL_CHOICES.length,
    confirm: 0,
  };
  const setters: Record<Step, (fn: (v: number) => number) => void> = {
    gpu: setGpuIndex,
    image: (fn) =>
      setImageUuid((current) => {
        const at = Math.max(
          0,
          options.findIndex((option) => option.uuid === current),
        );
        return options[fn(at)]?.uuid ?? current;
      }),
    ttl: setTtlIndex,
    confirm: () => undefined,
  };
  const order: Step[] = ["gpu", "image", "ttl", "confirm"];

  useInput((input, key) => {
    if (busy) return;
    if (key.escape || input === "q") return onCancel();

    if (step !== "confirm") {
      const move = (delta: number) =>
        setters[step]((v) => (v + delta + lengths[step]) % lengths[step]);
      if (key.upArrow || input === "k") return move(-1);
      if (key.downArrow || input === "j") return move(1);
    }

    if (key.return) {
      const next = order[order.indexOf(step) + 1];
      if (next) return setStep(next);
      return onSubmit(draft);
    }
    if (key.leftArrow) {
      const prev = order[order.indexOf(step) - 1];
      if (prev) setStep(prev);
    }
  });

  const privateNote = privateImagesLoading
    ? "正在读取私有镜像…"
    : privateImagesError
      ? `私有镜像读取失败：${privateImagesError}`
      : image.isPrivate
        ? `私有镜像不带 CUDA 信息，按 CLI 默认要求主机 CUDA ≥ ${PRIVATE_IMAGE_CUDA}`
        : usable.length === 0
          ? "当前账号没有可用的私有镜像"
          : `私有镜像 ${usable.length} 个，排在最前`;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>新建实例　{order.map((s) => (s === step ? `[${s}]` : s)).join(" → ")}</Text>

      {step === "gpu" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>选择 GPU 规格：</Text>
          <Choice
            items={[...GPU_SPECS]}
            index={gpuIndex}
            label={(s) => `${s.displayName.padEnd(14)} ${s.id.padEnd(12)} ${s.vramGb}G`}
            maxRows={maxRows}
          />
        </Box>
      ) : null}

      {step === "image" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>选择镜像：</Text>
          <Choice
            items={options}
            index={imageIndex}
            label={(option) => option.label}
            keyFor={(option) => option.uuid}
            maxRows={maxRows}
          />
          <Text color={privateImagesError ? "yellow" : undefined} dimColor={!privateImagesError}>
            {privateNote}
            {unfinished > 0 ? ` · 另有 ${unfinished} 个尚未保存完成，暂不能用` : ""}
          </Text>
        </Box>
      ) : null}

      {step === "ttl" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>到期自动关机（AutoDL 按开机时长计费，建议设置）：</Text>
          <Choice items={TTL_CHOICES} index={ttlIndex} label={(t) => t} maxRows={maxRows} />
          {ttl === NO_TTL ? <Text color="yellow">{NO_TTL_WARNING}</Text> : null}
        </Box>
      ) : null}

      {step === "confirm" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            {spec.displayName} ×1 · {image.summary} · TTL {ttl}
          </Text>
          {image.isPrivate ? (
            <Text dimColor>
              私有镜像不带 CUDA 信息，按 CLI 默认要求主机 CUDA ≥ {PRIVATE_IMAGE_CUDA}。
            </Text>
          ) : null}
          {draft.ttlSeconds === null ? <Text color="yellow">{NO_TTL_WARNING}</Text> : null}
          <Text dimColor>不指定地区，由 AutoDL 自行调度——实测这样成功率最高。</Text>
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>等价命令：</Text>
            <Text color="cyan">{equivalentCommand(draft)}</Text>
          </Box>
          <Box marginTop={1}>
            <Text color={busy ? "yellow" : "green"}>
              {busy ? "正在创建…" : "Enter 创建 · ← 返回 · Esc 取消"}
            </Text>
          </Box>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text dimColor>↑↓ 选择 · Enter 下一步 · ← 上一步 · Esc 取消</Text>
        </Box>
      )}
    </Box>
  );
}
