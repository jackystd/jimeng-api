import { request } from "@/api/controllers/core.ts";
import logger from "@/lib/logger.ts";

/**
 * 图片URL提取工具
 * 统一从不同格式的响应中提取图片URL
 */

export interface ImageUrlInfo {
  /** 原始 PNG URL（large_images，短效期约2小时） */
  png: string | null;
  /** WebP 2048 URL（cover_url，短效期约2小时） */
  webp: string | null;
  /** WebP 最大尺寸 URL（cover_url_map 中最大的，长效期约29天） */
  webp_long: string | null;
  /** cover_url_map 中所有尺寸的 webp URL（长效期约29天） */
  webp_sizes: Record<string, string>;
}

/**
 * 从API响应项中提取图片URL（仅 large_images PNG）
 */
export function extractImageUrl(item: any, index?: number): string | null {
  const logPrefix = index !== undefined ? `图片 ${index + 1}` : '图片';

  if (item?.image?.large_images?.[0]?.image_url) {
    let imageUrl = item.image.large_images[0].image_url;
    imageUrl = imageUrl.replace(/\\u0026/g, '&');
    logger.debug(`${logPrefix}: 使用 large_images URL`);
    return imageUrl;
  }

  logger.warn(`${logPrefix}: 无法提取URL，缺少 image.large_images[0].image_url 字段`);
  return null;
}

/**
 * 从API响应项中提取所有格式的图片URL
 *
 * 数据来源:
 * - item.image.large_images[0].image_url → 原始 PNG (aigc_resize:0:0.png, ~2h有效期)
 * - item.common_attr.cover_url → WebP 2048 (aigc_resize:2048:2048.webp, ~2h有效期)
 * - item.common_attr.cover_url_map → 多尺寸 WebP (360/480/720/1080/2400, ~29天有效期)
 */
export function extractImageUrlInfo(item: any, index?: number): ImageUrlInfo {
  const logPrefix = index !== undefined ? `图片 ${index + 1}` : '图片';
  const info: ImageUrlInfo = { png: null, webp: null, webp_long: null, webp_sizes: {} };

  // PNG: item.image.large_images
  if (item?.image?.large_images?.[0]?.image_url) {
    info.png = item.image.large_images[0].image_url.replace(/\\u0026/g, '&');
  }

  // WebP short: item.common_attr.cover_url (2048x2048, 短效期)
  if (item?.common_attr?.cover_url) {
    info.webp = item.common_attr.cover_url.replace(/\\u0026/g, '&');
  }

  // WebP long: item.common_attr.cover_url_map (多尺寸, 长效期~29天)
  const coverMap = item?.common_attr?.cover_url_map;
  if (coverMap && typeof coverMap === 'object') {
    const normalSizeKeys = ['2400', '1080', '720', '480', '360'];
    for (const key of Object.keys(coverMap)) {
      if (coverMap[key]) {
        info.webp_sizes[key] = coverMap[key].replace(/\\u0026/g, '&');
      }
    }
    // 选取 normal scene 中最大的作为 webp_long
    for (const sizeKey of normalSizeKeys) {
      if (info.webp_sizes[sizeKey]) {
        info.webp_long = info.webp_sizes[sizeKey];
        break;
      }
    }
  }

  logger.debug(`${logPrefix}: png=${!!info.png}, webp=${!!info.webp}, webp_long=${!!info.webp_long}, sizes=${Object.keys(info.webp_sizes).length}`);
  return info;
}

/**
 * 从项目列表中批量提取图片URLs（仅 large_images PNG，兼容旧接口）
 */
export function extractImageUrls(itemList: any[]): string[] {
  return itemList
    .map((item, index) => extractImageUrl(item, index))
    .filter((url): url is string => url !== null);
}

/**
 * 从项目列表中批量提取所有格式的图片URL信息
 */
export function extractAllImageUrls(itemList: any[]): ImageUrlInfo[] {
  return itemList.map((item, index) => extractImageUrlInfo(item, index));
}

/**
 * 从视频响应项中提取视频URL
 * @param item 视频响应项
 * @returns 视频URL或null
 */
export function extractVideoUrl(item: any): string | null {
  // 优先尝试 transcoded_video.origin.video_url
  if (item?.video?.transcoded_video?.origin?.video_url) {
    return item.video.transcoded_video.origin.video_url;
  }
  // 尝试 play_url
  if (item?.video?.play_url) {
    return item.video.play_url;
  }
  // 尝试 download_url
  if (item?.video?.download_url) {
    return item.video.download_url;
  }
  // 尝试 url
  if (item?.video?.url) {
    return item.video.url;
  }

  return null;
}

/**
 * 通过 get_local_item_list API 获取高质量视频下载URL
 * 浏览器下载视频时使用此API获取高码率版本（~6297 vs 预览版 ~1152）
 *
 * @param itemId 视频项目ID
 * @param refreshToken 刷新令牌
 * @returns 高质量视频URL，失败时返回 null
 */
export async function fetchHighQualityVideoUrl(itemId: string, refreshToken: string): Promise<string | null> {
  try {
    logger.info(`尝试获取高质量视频下载URL，item_id: ${itemId}`);

    const result = await request("post", "/mweb/v1/get_local_item_list", refreshToken, {
      data: {
        item_id_list: [itemId],
        pack_item_opt: {
          scene: 1,
          need_data_integrity: true,
        },
        is_for_video_download: true,
      },
    });

    const responseStr = JSON.stringify(result);
    logger.info(`get_local_item_list 响应大小: ${responseStr.length} 字符`);

    // 策略1: 从结构化字段中提取视频URL
    const itemList = result.item_list || result.local_item_list || [];
    if (itemList.length > 0) {
      const item = itemList[0];
      const videoUrl =
        item?.video?.transcoded_video?.origin?.video_url ||
        item?.video?.download_url ||
        item?.video?.play_url ||
        item?.video?.url;

      if (videoUrl) {
        logger.info(`从get_local_item_list结构化字段获取到高清视频URL: ${videoUrl}`);
        return videoUrl;
      }
    }

    // 策略2: 正则匹配 dreamnia.jimeng.com 高质量URL
    const hqUrlMatch = responseStr.match(/https:\/\/v[0-9]+-dreamnia\.jimeng\.com\/[^"\s\\]+/);
    if (hqUrlMatch && hqUrlMatch[0]) {
      logger.info(`正则提取到高质量视频URL (dreamnia): ${hqUrlMatch[0]}`);
      return hqUrlMatch[0];
    }

    // 策略3: 匹配任何 jimeng.com 域名的视频URL
    const jimengUrlMatch = responseStr.match(/https:\/\/v[0-9]+-[^"\\]*\.jimeng\.com\/[^"\s\\]+/);
    if (jimengUrlMatch && jimengUrlMatch[0]) {
      logger.info(`正则提取到jimeng视频URL: ${jimengUrlMatch[0]}`);
      return jimengUrlMatch[0];
    }

    // 策略4: 匹配任何视频URL（兜底）
    const anyVideoUrlMatch = responseStr.match(/https:\/\/v[0-9]+-[^"\\]*\.(vlabvod|jimeng)\.com\/[^"\s\\]+/);
    if (anyVideoUrlMatch && anyVideoUrlMatch[0]) {
      logger.info(`从get_local_item_list提取到视频URL: ${anyVideoUrlMatch[0]}`);
      return anyVideoUrlMatch[0];
    }

    logger.warn(`未能从get_local_item_list响应中提取到视频URL`);
    return null;
  } catch (error) {
    logger.warn(`获取高质量视频下载URL失败: ${error.message}`);
    return null;
  }
}
