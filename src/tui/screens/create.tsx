import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";
import { BASE_IMAGES, DEFAULT_BASE_IMAGE, GPU_SPECS, type GpuSpec } from "../../core/catalog.js";
import { formatDuration, parseDuration } from "../../core/duration.js";

/**
 * Guided instance creation.
 *
 * Deliberately offers no region picker: creating without a `data_center_list` was
 * measured to succeed where naming a region failed, because Pro capacity does not track
 * the elastic-deployment stock we can see. The wizard says so rather than exposing a
 * choice that only lowers the hit rate.
 */

const TTL_CHOICES = ["30m", "1h", "2h", "4h", "8h"];

export interface CreateDraft {
  spec: GpuSpec;
  imageUuid: string;
  ttlSeconds: number;
}

/** The equivalent CLI invocation, so the wizard teaches the command it replaces. */
export function equivalentCommand(draft: CreateDraft): string {
  const parts = [
    "autodl create",
    `--gpu ${draft.spec.id}`,
    `--ttl ${formatDuration(draft.ttlSeconds)}`,
  ];
  if (draft.imageUuid !== DEFAULT_BASE_IMAGE) parts.push(`--image ${draft.imageUuid}`);
  parts.push("--wait");
  return parts.join(" ");
}

type Step = "gpu" | "image" | "ttl" | "confirm";

interface CreateWizardProps {
  busy: boolean;
  onSubmit: (draft: CreateDraft) => void;
  onCancel: () => void;
}

function Choice<T>({
  items,
  index,
  label,
}: {
  items: T[];
  index: number;
  label: (item: T) => string;
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      {items.map((item, i) => (
        <Text key={label(item)} inverse={i === index}>
          {i === index ? "› " : "  "}
          {label(item)}
        </Text>
      ))}
    </Box>
  );
}

export function CreateWizard({ busy, onSubmit, onCancel }: CreateWizardProps): React.ReactElement {
  const [step, setStep] = useState<Step>("gpu");
  const [gpuIndex, setGpuIndex] = useState(0);
  const [imageIndex, setImageIndex] = useState(
    Math.max(
      0,
      BASE_IMAGES.findIndex((image) => image.uuid === DEFAULT_BASE_IMAGE),
    ),
  );
  const [ttlIndex, setTtlIndex] = useState(2);

  const spec = GPU_SPECS[gpuIndex] as GpuSpec;
  const image = BASE_IMAGES[imageIndex] as (typeof BASE_IMAGES)[number];
  const ttl = TTL_CHOICES[ttlIndex] as string;
  const draft: CreateDraft = {
    spec,
    imageUuid: image.uuid,
    ttlSeconds: parseDuration(ttl),
  };

  const lengths: Record<Step, number> = {
    gpu: GPU_SPECS.length,
    image: BASE_IMAGES.length,
    ttl: TTL_CHOICES.length,
    confirm: 0,
  };
  const setters: Record<Step, (fn: (v: number) => number) => void> = {
    gpu: setGpuIndex,
    image: setImageIndex,
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
          />
        </Box>
      ) : null}

      {step === "image" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>选择基础镜像：</Text>
          <Choice
            items={[...BASE_IMAGES]}
            index={imageIndex}
            label={(i) => `${i.framework.padEnd(11)} CUDA ${i.cuda.padEnd(5)} py${i.python}`}
          />
        </Box>
      ) : null}

      {step === "ttl" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>到期自动关机（AutoDL 按开机时长计费，务必设置）：</Text>
          <Choice items={TTL_CHOICES} index={ttlIndex} label={(t) => t} />
        </Box>
      ) : null}

      {step === "confirm" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            {spec.displayName} ×1 · {image.framework} CUDA {image.cuda} · TTL {ttl}
          </Text>
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
