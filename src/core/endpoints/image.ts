import type { AutoDLClient } from "../client.js";
import {
  normalizeImage,
  normalizePagination,
  type Pagination,
  type PrivateImage,
} from "../schemas.js";

/** Snapshot a running instance into a reusable private image. */
export async function saveImage(
  client: AutoDLClient,
  instanceUuid: string,
  imageName: string,
): Promise<string> {
  const data = await client.post<{ image_uuid: string }>(
    "/api/v1/dev/instance/pro/image/save",
    { instance_uuid: instanceUuid, image_name: imageName },
    { maxRetries: 0 },
  );
  return data.image_uuid;
}

export async function listPrivateImages(
  client: AutoDLClient,
  options: { pageIndex?: number; pageSize?: number } = {},
): Promise<{ images: PrivateImage[]; pagination: Pagination }> {
  const data = await client.post<{ list?: unknown[] } & Record<string, unknown>>(
    "/api/v1/dev/instance/pro/image/private/list",
    { page_index: options.pageIndex ?? 1, page_size: options.pageSize ?? 50 },
  );
  const list = Array.isArray(data?.list) ? data.list : [];
  return { images: list.map(normalizeImage), pagination: normalizePagination(data) };
}
