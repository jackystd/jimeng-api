import _ from "lodash";
import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import util from "@/lib/util.ts";
import { getCredit, receiveCredit, request, parseRegionFromToken, getAssistantId, RegionInfo } from "./core.ts";
import logger from "@/lib/logger.ts";
import { extractImageUrls, extractVideoUrl } from "@/lib/image-utils.ts";
import { getModel as getImageModel } from "./images.ts";
import { getModel as getVideoModel } from "./videos.ts";
import { DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL, DRAFT_VERSION } from "@/api/consts/common.ts";
import { uploadImageFromUrl, uploadImageBuffer } from "@/lib/image-uploader.ts";
import axios from "axios";
import fs from "fs-extra";
import {
  resolveResolution,
  buildCoreParam,
  buildMetricsExtra,
  buildDraftContent,
  buildGenerateRequest,
  buildBlendAbilityList,
  buildPromptPlaceholderList,
} from "@/api/builders/payload-builder.ts";

/**
 * 异步创建图片生成任务（文生图）
 * 
 * @param _model 模型名称
 * @param prompt 提示词
 * @param options 选项
 * @param refreshToken 刷新令牌
 * @returns history_id
 */
export async function createImageGenerationTask(
  _model: string,
  prompt: string,
  {
    ratio = '1:1',
    resolution = '2k',
    sampleStrength = 0.5,
    negativePrompt = "",
    intelligentRatio = false,
  }: {
    ratio?: string;
    resolution?: string;
    sampleStrength?: number;
    negativePrompt?: string;
    intelligentRatio?: boolean;
  },
  refreshToken: string
): Promise<string> {
  const regionInfo = parseRegionFromToken(refreshToken);
  const { model, userModel } = getImageModel(_model, regionInfo.isInternational);
  
  logger.info(`[异步任务] 创建文生图任务 - 模型: ${userModel} 映射模型: ${model} 分辨率: ${resolution} 比例: ${ratio}`);

  // 使用 payload-builder 处理分辨率
  const resolutionResult = resolveResolution(userModel, regionInfo, resolution, ratio);

  const componentId = util.uuid();
  const submitId = util.uuid();

  // 使用 payload-builder 构建 core_param
  const coreParam = buildCoreParam({
    userModel,
    model,
    prompt,
    negativePrompt,
    seed: Math.floor(Math.random() * 100000000) + 2500000000,
    sampleStrength,
    resolution: resolutionResult,
    intelligentRatio,
    mode: "text2img",
  });

  // 使用 payload-builder 构建 metrics_extra
  const metricsExtra = buildMetricsExtra({
    userModel,
    regionInfo,
    submitId,
    scene: "ImageBasicGenerate",
    resolutionType: resolutionResult.resolutionType,
    abilityList: [],
  });

  // 使用 payload-builder 构建 draft_content
  const draftContent = buildDraftContent({
    componentId,
    generateType: "generate",
    coreParam,
  });

  // 使用 payload-builder 构建完整请求
  const requestData = buildGenerateRequest({
    model,
    regionInfo,
    submitId,
    draftContent,
    metricsExtra,
  });

  const { aigc_data } = await request(
    "post",
    "/mweb/v1/aigc_draft/generate",
    refreshToken,
    { data: requestData }
  );

  const historyId = aigc_data?.history_record_id;
  if (!historyId)
    throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录ID不存在");

  logger.info(`[异步任务] 文生图任务已提交，history_id: ${historyId}`);

  return historyId;
}

/**
 * 异步创建图片生成任务（图生图）
 * 
 * @param _model 模型名称
 * @param prompt 提示词
 * @param images 输入图片数组（URL字符串或Buffer）
 * @param options 选项
 * @param refreshToken 刷新令牌
 * @returns history_id
 */
export async function createImageCompositionTask(
  _model: string,
  prompt: string,
  images: (string | Buffer)[],
  {
    ratio = '1:1',
    resolution = '2k',
    sampleStrength = 0.5,
    negativePrompt = "",
    intelligentRatio = false,
  }: {
    ratio?: string;
    resolution?: string;
    sampleStrength?: number;
    negativePrompt?: string;
    intelligentRatio?: boolean;
  },
  refreshToken: string
): Promise<string> {
  const regionInfo = parseRegionFromToken(refreshToken);
  const { model, userModel } = getImageModel(_model, regionInfo.isInternational);

  // 使用 payload-builder 处理分辨率
  const resolutionResult = resolveResolution(userModel, regionInfo, resolution, ratio);

  const imageCount = images.length;
  logger.info(`[异步任务] 创建图生图任务 - 模型: ${userModel} 图片数量: ${imageCount} 分辨率: ${resolutionResult.width}x${resolutionResult.height}`);

  // 上传图片
  const uploadedImageIds: string[] = [];
  for (let i = 0; i < images.length; i++) {
    try {
      const image = images[i];
      let imageId: string;
      if (typeof image === 'string') {
        logger.info(`正在处理第 ${i + 1}/${imageCount} 张图片 (URL)...`);
        imageId = await uploadImageFromUrl(image, refreshToken, regionInfo);
      } else {
        logger.info(`正在处理第 ${i + 1}/${imageCount} 张图片 (Buffer)...`);
        imageId = await uploadImageBuffer(image, refreshToken, regionInfo);
      }
      uploadedImageIds.push(imageId);
      logger.info(`图片 ${i + 1}/${imageCount} 上传成功: ${imageId}`);
    } catch (error) {
      logger.error(`图片 ${i + 1}/${imageCount} 上传失败: ${error.message}`);
      throw new APIException(EX.API_IMAGE_GENERATION_FAILED, `图片上传失败: ${error.message}`);
    }
  }

  logger.info(`所有图片上传完成，开始创建图生图任务: ${uploadedImageIds.join(', ')}`);

  const componentId = util.uuid();
  const submitId = util.uuid();

  // 使用 payload-builder 构建 core_param
  const coreParam = buildCoreParam({
    userModel,
    model,
    prompt,
    negativePrompt,
    imageCount,
    sampleStrength,
    resolution: resolutionResult,
    intelligentRatio,
    mode: "img2img",
  });

  // 构建 metrics_extra 中的 abilityList
  const metricsAbilityList = uploadedImageIds.map(() => ({
    abilityName: "byte_edit",
    strength: sampleStrength,
    source: {
      imageUrl: `blob:https://dreamina.capcut.com/${util.uuid()}`
    }
  }));

  // 使用 payload-builder 构建 metrics_extra
  const metricsExtra = buildMetricsExtra({
    userModel,
    regionInfo,
    submitId,
    scene: "ImageBasicGenerate",
    resolutionType: resolutionResult.resolutionType,
    abilityList: metricsAbilityList,
  });

  // 使用 payload-builder 构建 draft_content
  const abilityList = buildBlendAbilityList(uploadedImageIds, sampleStrength);
  const promptPlaceholderInfoList = buildPromptPlaceholderList(uploadedImageIds.length);
  const posteditParam = {
    type: "",
    id: util.uuid(),
    generate_type: 0
  };

  const draftContent = buildDraftContent({
    componentId,
    generateType: "blend",
    coreParam,
    abilityList,
    promptPlaceholderInfoList,
    posteditParam,
    imageCount,
  });

  // 使用 payload-builder 构建完整请求
  const requestData = buildGenerateRequest({
    model,
    regionInfo,
    submitId,
    draftContent,
    metricsExtra,
  });

  const { aigc_data } = await request(
    "post",
    "/mweb/v1/aigc_draft/generate",
    refreshToken,
    { data: requestData }
  );

  const historyId = aigc_data?.history_record_id;
  if (!historyId)
    throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录ID不存在");

  logger.info(`[异步任务] 图生图任务已提交，history_id: ${historyId}`);

  return historyId;
}

// 处理本地上传的文件
async function uploadImageFromFile(file: any, refreshToken: string, regionInfo: RegionInfo): Promise<string> {
  try {
    logger.info(`开始从本地文件上传视频图片: ${file.originalFilename} (路径: ${file.filepath})`);
    const imageBuffer = await fs.readFile(file.filepath);
    return await uploadImageBuffer(imageBuffer, refreshToken, regionInfo);
  } catch (error: any) {
    logger.error(`从本地文件上传视频图片失败: ${error.message}`);
    throw error;
  }
}

// 处理来自URL的图片
async function uploadVideoImageFromUrl(imageUrl: string, refreshToken: string, regionInfo: RegionInfo): Promise<string> {
  try {
    logger.info(`开始从URL下载并上传视频图片: ${imageUrl}`);
    const imageResponse = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
    });
    if (imageResponse.status < 200 || imageResponse.status >= 300) {
      throw new Error(`下载图片失败: ${imageResponse.status}`);
    }
    const imageBuffer = imageResponse.data;
    return await uploadImageBuffer(imageBuffer, refreshToken, regionInfo);
  } catch (error: any) {
    logger.error(`从URL上传视频图片失败: ${error.message}`);
    throw error;
  }
}

// 处理来自本地缓存文件路径的图片（由xcserver图片缓存服务提供）
async function uploadVideoImageFromLocalPath(localPath: string, refreshToken: string, regionInfo: RegionInfo): Promise<string> {
  try {
    logger.info(`开始从本地缓存文件上传视频图片: ${localPath}`);
    const imageBuffer = await fs.readFile(localPath);
    return await uploadImageBuffer(imageBuffer, refreshToken, regionInfo);
  } catch (error: any) {
    logger.error(`从本地缓存文件上传视频图片失败: ${error.message}`);
    throw error;
  }
}

/**
 * 判断路径是本地文件路径还是远端 URL
 * 本地路径以 / 开头且文件存在
 */
async function isLocalFilePath(filePath: string): Promise<boolean> {
  if (!filePath.startsWith('/')) return false;
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 异步创建视频生成任务
 *
 * @param _model 模型名称
 * @param prompt 提示词
 * @param options 选项
 * @param refreshToken 刷新令牌
 * @returns history_id
 */
export async function createVideoGenerationTask(
  _model: string,
  prompt: string,
  {
    ratio = "1:1",
    resolution = "720p",
    duration = 5,
    filePaths = [],
    files = {},
  }: {
    ratio?: string;
    resolution?: string;
    duration?: number;
    filePaths?: string[];
    files?: any;
  },
  refreshToken: string
): Promise<string> {
  // 检测区域
  const regionInfo = parseRegionFromToken(refreshToken);
  const { isInternational } = regionInfo;

  logger.info(`[异步任务] 创建视频生成任务 - 区域: isInternational=${isInternational}`);

  const model = getVideoModel(_model, regionInfo);
  const isVeo3 = model.includes("veo3");
  const isSora2 = model.includes("sora2");
  const is35Pro = model.includes("3.5_pro");
  const supportsResolution = (model.includes("vgfm_3.0") || model.includes("vgfm_3.0_fast")) && !model.includes("_pro");

  // 将秒转换为毫秒
  let durationMs: number;
  let actualDuration: number;
  if (isVeo3) {
    durationMs = 8000;
    actualDuration = 8;
  } else if (isSora2) {
    if (duration === 12) {
      durationMs = 12000;
      actualDuration = 12;
    } else if (duration === 8) {
      durationMs = 8000;
      actualDuration = 8;
    } else {
      durationMs = 4000;
      actualDuration = 4;
    }
  } else if (is35Pro) {
    if (duration === 12) {
      durationMs = 12000;
      actualDuration = 12;
    } else if (duration === 10) {
      durationMs = 10000;
      actualDuration = 10;
    } else {
      durationMs = 5000;
      actualDuration = 5;
    }
  } else {
    durationMs = duration === 10 ? 10000 : 5000;
    actualDuration = duration === 10 ? 10 : 5;
  }

  logger.info(`使用模型: ${_model} 映射模型: ${model} 比例: ${ratio} 分辨率: ${supportsResolution ? resolution : '不支持'} 时长: ${actualDuration}s`);

  // 处理首帧和尾帧图片
  let first_frame_image = undefined;
  let end_frame_image = undefined;
  let uploadIDs: string[] = [];

  // 优先处理本地上传的文件
  const uploadedFiles = _.values(files);
  if (uploadedFiles && uploadedFiles.length > 0) {
    logger.info(`检测到 ${uploadedFiles.length} 个本地上传文件，优先处理`);
    for (let i = 0; i < uploadedFiles.length; i++) {
      const file = uploadedFiles[i];
      if (!file) continue;
      try {
        logger.info(`开始上传第 ${i + 1} 张本地图片: ${file.originalFilename}`);
        const imageUri = await uploadImageFromFile(file, refreshToken, regionInfo);
        if (imageUri) {
          uploadIDs.push(imageUri);
          logger.info(`第 ${i + 1} 张本地图片上传成功: ${imageUri}`);
        } else {
          logger.error(`第 ${i + 1} 张本地图片上传失败: 未获取到 image_uri`);
        }
      } catch (error: any) {
        logger.error(`第 ${i + 1} 张本地图片上传失败: ${error.message}`);
        if (i === 0) {
          throw new APIException(EX.API_REQUEST_FAILED, `首帧图片上传失败: ${error.message}`);
        }
      }
    }
  }
  // 如果没有本地文件，再处理filePaths（可能是URL或本地缓存路径）
  else if (filePaths && filePaths.length > 0) {
    logger.info(`未检测到本地上传文件，处理 ${filePaths.length} 个图片路径`);
    for (let i = 0; i < filePaths.length; i++) {
      const filePath = filePaths[i];
      if (!filePath) {
        logger.warn(`第 ${i + 1} 个图片路径为空，跳过`);
        continue;
      }
      try {
        let imageUri: string;
        // 检测是否为本地缓存文件路径（由xcserver图片缓存服务提供）
        if (await isLocalFilePath(filePath)) {
          logger.info(`开始上传第 ${i + 1} 个本地缓存图片: ${filePath}`);
          imageUri = await uploadVideoImageFromLocalPath(filePath, refreshToken, regionInfo);
        } else {
          logger.info(`开始上传第 ${i + 1} 个URL图片: ${filePath}`);
          imageUri = await uploadVideoImageFromUrl(filePath, refreshToken, regionInfo);
        }
        if (imageUri) {
          uploadIDs.push(imageUri);
          logger.info(`第 ${i + 1} 个图片上传成功: ${imageUri}`);
        } else {
          logger.error(`第 ${i + 1} 个图片上传失败: 未获取到 image_uri`);
        }
      } catch (error: any) {
        logger.error(`第 ${i + 1} 个图片上传失败: ${error.message}`);
        if (i === 0) {
          throw new APIException(EX.API_REQUEST_FAILED, `首帧图片上传失败: ${error.message}`);
        }
      }
    }
  } else {
    logger.info(`未提供图片文件或URL，将进行纯文本视频生成`);
  }

  // 如果有图片上传，构建对象
  if (uploadIDs.length > 0) {
    logger.info(`图片上传完成，共成功 ${uploadIDs.length} 张`);
    // 构建首帧图片对象
    if (uploadIDs[0]) {
      first_frame_image = {
        format: "",
        height: 0,
        id: util.uuid(),
        image_uri: uploadIDs[0],
        name: "",
        platform_type: 1,
        source_from: "upload",
        type: "image",
        uri: uploadIDs[0],
        width: 0,
      };
      logger.info(`设置首帧图片: ${uploadIDs[0]}`);
    }

    // 构建尾帧图片对象
    if (uploadIDs[1]) {
      end_frame_image = {
        format: "",
        height: 0,
        id: util.uuid(),
        image_uri: uploadIDs[1],
        name: "",
        platform_type: 1,
        source_from: "upload",
        type: "image",
        uri: uploadIDs[1],
        width: 0,
      };
      logger.info(`设置尾帧图片: ${uploadIDs[1]}`);
    }
  }

  const componentId = util.uuid();
  const originSubmitId = util.uuid();

  const functionMode = "first_last_frames";

  const sceneOption = {
    type: "video",
    scene: "BasicVideoGenerateButton",
    ...(supportsResolution ? { resolution: resolution } : {}),
    modelReqKey: model,
    videoDuration: actualDuration,
    reportParams: {
      enterSource: "generate",
      vipSource: "generate",
      extraVipFunctionKey: supportsResolution ? `${model}-${resolution}` : model,
      useVipFunctionDetailsReporterHoc: true,
    },
  };

  const metricsExtra = JSON.stringify({
    promptSource: "custom",
    isDefaultSeed: 1,
    originSubmitId: originSubmitId,
    isRegenerate: false,
    enterFrom: "click",
    functionMode: functionMode,
    sceneOptions: JSON.stringify([sceneOption]),
  });

  const getVideoBenefitType = (model: string): string => {
    if (model.includes("veo3.1")) {
      return "generate_video_veo3.1";
    }
    if (model.includes("veo3")) {
      return "generate_video_veo3";
    }
    if (model.includes("sora2")) {
      return "generate_video_sora2";
    }
    if (model.includes("3.5_pro")) {
      return "dreamina_video_seedance_15_pro";
    }
    if (model.includes("3.5")) {
      return "dreamina_video_seedance_15";
    }
    return "basic_video_operation_vgfm_v_three";
  };

  // 构建请求参数
  const { aigc_data } = await request(
    "post",
    "/mweb/v1/aigc_draft/generate",
    refreshToken,
    {
      params: {
        aigc_features: "app_lip_sync",
        web_version: "7.5.0",
        da_version: DRAFT_VERSION,
      },
      data: {
        "extend": {
          "root_model": model,
          "m_video_commerce_info": {
            benefit_type: getVideoBenefitType(model),
            resource_id: "generate_video",
            resource_id_type: "str",
            resource_sub_type: "aigc"
          },
          "m_video_commerce_info_list": [{
            benefit_type: getVideoBenefitType(model),
            resource_id: "generate_video",
            resource_id_type: "str",
            resource_sub_type: "aigc"
          }]
        },
        "submit_id": util.uuid(),
        "metrics_extra": metricsExtra,
        "draft_content": JSON.stringify({
          "type": "draft",
          "id": util.uuid(),
          "min_version": "3.0.5",
          "min_features": [],
          "is_from_tsn": true,
          "version": DRAFT_VERSION,
          "main_component_id": componentId,
          "component_list": [{
            "type": "video_base_component",
            "id": componentId,
            "min_version": "1.0.0",
            "aigc_mode": "workbench",
            "metadata": {
              "type": "",
              "id": util.uuid(),
              "created_platform": 3,
              "created_platform_version": "",
              "created_time_in_ms": Date.now().toString(),
              "created_did": ""
            },
            "generate_type": "gen_video",
            "abilities": {
              "type": "",
              "id": util.uuid(),
              "gen_video": {
                "id": util.uuid(),
                "type": "",
                "text_to_video_params": {
                  "type": "",
                  "id": util.uuid(),
                  "video_gen_inputs": [{
                    "type": "",
                    "id": util.uuid(),
                    "min_version": "3.0.5",
                    "prompt": prompt,
                    "video_mode": 2,
                    "fps": 24,
                    "duration_ms": durationMs,
                    ...(supportsResolution ? { "resolution": resolution } : {}),
                    "first_frame_image": first_frame_image,
                    "end_frame_image": end_frame_image,
                    "idip_meta_list": []
                  }],
                  "video_aspect_ratio": ratio,
                  "seed": Math.floor(Math.random() * 100000000) + 2500000000,
                  "model_req_key": model,
                  "priority": 0
                },
                "video_task_extra": metricsExtra,
              }
            },
            "process_type": 1
          }],
        }),
        http_common_info: {
          aid: getAssistantId(regionInfo)
        },
      },
    }
  );

  const historyId = aigc_data.history_record_id;
  if (!historyId)
    throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录ID不存在");

  logger.info(`[异步任务] 视频生成任务已提交，history_id: ${historyId}`);

  return historyId;
}

/**
 * 查询图片任务状态
 * @param historyId 任务ID
 * @param refreshToken 刷新令牌
 * @returns 任务信息
 */
export async function queryImageTaskStatus(historyId: string, refreshToken: string) {
  logger.info(`[查询图片任务] 查询任务状态: ${historyId}`);

  const response = await request("post", "/mweb/v1/get_history_by_ids", refreshToken, {
    data: {
      history_ids: [historyId],
      image_info: {
        width: 2048,
        height: 2048,
        format: "webp",
        image_scene_list: [
          { scene: "smart_crop", width: 360, height: 360, uniq_key: "smart_crop-w:360-h:360", format: "webp" },
          { scene: "smart_crop", width: 480, height: 480, uniq_key: "smart_crop-w:480-h:480", format: "webp" },
          { scene: "smart_crop", width: 720, height: 720, uniq_key: "smart_crop-w:720-h:720", format: "webp" },
          { scene: "smart_crop", width: 720, height: 480, uniq_key: "smart_crop-w:720-h:480", format: "webp" },
          { scene: "normal", width: 2400, height: 2400, uniq_key: "2400", format: "webp" },
          { scene: "normal", width: 1080, height: 1080, uniq_key: "1080", format: "webp" },
          { scene: "normal", width: 720, height: 720, uniq_key: "720", format: "webp" },
          { scene: "normal", width: 480, height: 480, uniq_key: "480", format: "webp" },
          { scene: "normal", width: 360, height: 360, uniq_key: "360", format: "webp" }
        ]
      }
    }
  });

  if (!response[historyId]) {
    throw new APIException(EX.API_IMAGE_GENERATION_FAILED, `任务不存在: ${historyId}`);
  }

  const taskInfo = response[historyId];
  const status = taskInfo.status;
  const failCode = taskInfo.fail_code;
  const itemList = taskInfo.item_list || [];

  let results = null;

  // 提取图片URLs（status 10=完成, 50 有时也包含已生成的图片）
  if (itemList.length > 0 && itemList[0].image) {
    const imageUrls = extractImageUrls(itemList);
    if (imageUrls.length > 0) {
      results = imageUrls.map(url => ({ url }));
    }
  }

  logger.info(`[查询图片任务] 任务 ${historyId} - 状态: ${status}, 图片数: ${itemList.length}`);

  return {
    history_id: historyId,
    task_type: "image",
    status: status,
    fail_code: failCode,
    item_count: itemList.length,
    results: results,
    raw_data: taskInfo
  };
}

/**
 * 查询视频任务状态
 * @param historyId 任务ID
 * @param refreshToken 刷新令牌
 * @returns 任务信息
 */
export async function queryVideoTaskStatus(
  historyId: string,
  refreshToken: string
): Promise<{
  status: string;
  statusCode: number;
  failCode: number;
  videoUrl: string | null;
  finishTime: number;
  rawData: any;
}> {
  logger.info(`[查询视频任务] 查询任务状态: ${historyId}`);

  const result = await request("post", "/mweb/v1/get_history_by_ids", refreshToken, {
    data: {
      history_ids: [historyId],
    },
  });

  // 尝试从响应中提取视频URL
  const responseStr = JSON.stringify(result);
  const videoUrlMatch = responseStr.match(/https:\/\/v[0-9]+-artist\.vlabvod\.com\/[^"\s]+/);

  if (!result[historyId]) {
    // API未返回记录，可能还在处理中
    return {
      status: 'processing',
      statusCode: 20,
      failCode: 0,
      videoUrl: null,
      finishTime: 0,
      rawData: null,
    };
  }

  const historyData = result[historyId];
  const currentStatus = historyData.status;
  const currentFailCode = historyData.fail_code || 0;
  const finishTime = historyData.task?.finish_time || 0;
  const item_list = historyData.item_list || [];

  // 提取视频URL
  let videoUrl: string | null = null;
  if (videoUrlMatch && videoUrlMatch[0]) {
    videoUrl = videoUrlMatch[0];
  } else if (item_list.length > 0) {
    videoUrl = extractVideoUrl(item_list[0]);
  }

  // 状态映射
  let statusText = 'unknown';
  if (currentStatus === 20) statusText = 'processing';
  else if (currentStatus === 10 || currentStatus === 30) statusText = videoUrl ? 'completed' : 'processing';
  else if (currentStatus === 50) statusText = videoUrl ? 'completed' : 'failed';

  // 如果有视频URL，视为完成
  if (videoUrl) {
    statusText = 'completed';
  }

  logger.info(`[查询视频任务] historyId=${historyId}, status=${statusText}, videoUrl=${videoUrl ? '已获取' : '无'}`);

  return {
    status: statusText,
    statusCode: currentStatus,
    failCode: currentFailCode,
    videoUrl,
    finishTime,
    rawData: historyData,
  };
}

/**
 * 查询账户积分信息
 * 
 * @param refreshToken 刷新令牌
 * @returns 积分信息
 */
export async function queryCredits(refreshToken: string) {
  logger.info(`[异步任务] 查询积分信息`);

  try {
    const credits = await getCredit(refreshToken);
    logger.info(`[异步任务] 积分查询成功 - 总计: ${credits.totalCredit}`);
    return credits;
  } catch (error) {
    logger.error(`[异步任务] 积分查询失败: ${error.message}`);
    throw new APIException(EX.API_REQUEST_FAILED, `积分查询失败: ${error.message}`);
  }
}

export default {
  createImageGenerationTask,
  createImageCompositionTask,
  createVideoGenerationTask,
  queryImageTaskStatus,
  queryVideoTaskStatus,
  queryCredits,
};
