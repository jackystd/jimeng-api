import fs from "fs";
import _ from "lodash";

import Request from "@/lib/request/Request.ts";
import {
  createImageGenerationTask,
  createImageCompositionTask,
  createVideoGenerationTask,
  queryTaskStatus,
  queryCredits,
} from "@/api/controllers/async-tasks.ts";
import { DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL } from "@/api/consts/common.ts";
import { tokenSplit } from "@/api/controllers/core.ts";
import util from "@/lib/util.ts";

export default {
  prefix: "/v1/async",

  post: {
    // 异步创建文生图任务
    "/images/generations": async (request: Request) => {
      const unsupportedParams = ['size', 'width', 'height'];
      const bodyKeys = Object.keys(request.body);
      const foundUnsupported = unsupportedParams.filter(param => bodyKeys.includes(param));

      if (foundUnsupported.length > 0) {
        throw new Error(`不支持的参数: ${foundUnsupported.join(', ')}。请使用 ratio 和 resolution 参数控制图像尺寸。`);
      }

      request
        .validate("body.model", v => _.isUndefined(v) || _.isString(v))
        .validate("body.prompt", _.isString)
        .validate("body.negative_prompt", v => _.isUndefined(v) || _.isString(v))
        .validate("body.ratio", v => _.isUndefined(v) || _.isString(v))
        .validate("body.resolution", v => _.isUndefined(v) || _.isString(v))
        .validate("body.intelligent_ratio", v => _.isUndefined(v) || _.isBoolean(v))
        .validate("body.sample_strength", v => _.isUndefined(v) || _.isFinite(v))
        .validate("headers.authorization", _.isString);

      const tokens = tokenSplit(request.headers.authorization);
      const token = _.sample(tokens);
      const {
        model,
        prompt,
        negative_prompt: negativePrompt,
        ratio,
        resolution,
        intelligent_ratio: intelligentRatio,
        sample_strength: sampleStrength,
      } = request.body;
      const finalModel = _.defaultTo(model, DEFAULT_IMAGE_MODEL);

      const historyId = await createImageGenerationTask(finalModel, prompt, {
        ratio,
        resolution,
        sampleStrength,
        negativePrompt,
        intelligentRatio,
      }, token);

      return {
        created: util.unixTimestamp(),
        history_id: historyId,
        status: "submitted",
        message: "任务已提交，请使用 history_id 查询任务状态"
      };
    },

    // 异步创建图生图任务
    "/images/compositions": async (request: Request) => {
      const unsupportedParams = ['size', 'width', 'height'];
      const bodyKeys = Object.keys(request.body);
      const foundUnsupported = unsupportedParams.filter(param => bodyKeys.includes(param));

      if (foundUnsupported.length > 0) {
        throw new Error(`不支持的参数: ${foundUnsupported.join(', ')}。请使用 ratio 和 resolution 参数控制图像尺寸。`);
      }

      const contentType = request.headers['content-type'] || '';
      const isMultiPart = contentType.startsWith('multipart/form-data');

      if (isMultiPart) {
        request
          .validate("body.model", v => _.isUndefined(v) || _.isString(v))
          .validate("body.prompt", _.isString)
          .validate("body.negative_prompt", v => _.isUndefined(v) || _.isString(v))
          .validate("body.ratio", v => _.isUndefined(v) || _.isString(v))
          .validate("body.resolution", v => _.isUndefined(v) || _.isString(v))
          .validate("body.intelligent_ratio", v => _.isUndefined(v) || (typeof v === 'string' && (v === 'true' || v === 'false')) || _.isBoolean(v))
          .validate("body.sample_strength", v => _.isUndefined(v) || (typeof v === 'string' && !isNaN(parseFloat(v))) || _.isFinite(v))
          .validate("headers.authorization", _.isString);
      } else {
        request
          .validate("body.model", v => _.isUndefined(v) || _.isString(v))
          .validate("body.prompt", _.isString)
          .validate("body.images", _.isArray)
          .validate("body.negative_prompt", v => _.isUndefined(v) || _.isString(v))
          .validate("body.ratio", v => _.isUndefined(v) || _.isString(v))
          .validate("body.resolution", v => _.isUndefined(v) || _.isString(v))
          .validate("body.intelligent_ratio", v => _.isUndefined(v) || _.isBoolean(v))
          .validate("body.sample_strength", v => _.isUndefined(v) || _.isFinite(v))
          .validate("headers.authorization", _.isString);
      }

      let images: (string | Buffer)[] = [];
      if (isMultiPart) {
        const files = request.files?.images;
        if (!files) {
          throw new Error("在form-data中缺少 'images' 字段");
        }
        const imageFiles = Array.isArray(files) ? files : [files];
        if (imageFiles.length === 0) {
          throw new Error("至少需要提供1张输入图片");
        }
        if (imageFiles.length > 10) {
          throw new Error("最多支持10张输入图片");
        }
        images = imageFiles.map(file => fs.readFileSync(file.filepath));
      } else {
        const bodyImages = request.body.images;
        if (!bodyImages || bodyImages.length === 0) {
          throw new Error("至少需要提供1张输入图片");
        }
        if (bodyImages.length > 10) {
          throw new Error("最多支持10张输入图片");
        }
        bodyImages.forEach((image: any, index: number) => {
          if (!_.isString(image) && !_.isObject(image)) {
            throw new Error(`图片 ${index + 1} 格式不正确：应为URL字符串或包含url字段的对象`);
          }
          if (_.isObject(image) && !image.url) {
            throw new Error(`图片 ${index + 1} 缺少url字段`);
          }
        });
        images = bodyImages.map((image: any) => _.isString(image) ? image : image.url);
      }

      const tokens = tokenSplit(request.headers.authorization);
      const token = _.sample(tokens);

      const {
        model,
        prompt,
        negative_prompt: negativePrompt,
        ratio,
        resolution,
        intelligent_ratio: intelligentRatio,
        sample_strength: sampleStrength,
      } = request.body;
      const finalModel = _.defaultTo(model, DEFAULT_IMAGE_MODEL);

      // 如果是 multipart/form-data，需要将字符串转换为数字和布尔值
      const finalSampleStrength = isMultiPart && typeof sampleStrength === 'string'
        ? parseFloat(sampleStrength)
        : sampleStrength;

      const finalIntelligentRatio = isMultiPart && typeof intelligentRatio === 'string'
        ? intelligentRatio === 'true'
        : intelligentRatio;

      const historyId = await createImageCompositionTask(finalModel, prompt, images, {
        ratio,
        resolution,
        sampleStrength: finalSampleStrength,
        negativePrompt,
        intelligentRatio: finalIntelligentRatio,
      }, token);

      return {
        created: util.unixTimestamp(),
        history_id: historyId,
        input_images: images.length,
        status: "submitted",
        message: "任务已提交，请使用 history_id 查询任务状态"
      };
    },

    // 异步创建视频生成任务
    "/videos/generations": async (request: Request) => {
      const contentType = request.headers['content-type'] || '';
      const isMultiPart = contentType.startsWith('multipart/form-data');

      request
        .validate('body.model', v => _.isUndefined(v) || _.isString(v))
        .validate('body.prompt', _.isString)
        .validate('body.ratio', v => _.isUndefined(v) || _.isString(v))
        .validate('body.resolution', v => _.isUndefined(v) || _.isString(v))
        .validate('body.duration', v => {
          if (_.isUndefined(v)) return true;
          const validDurations = [4, 5, 8, 10, 12];
          if (isMultiPart && typeof v === 'string') {
            const num = parseInt(v);
            return validDurations.includes(num);
          }
          return _.isFinite(v) && validDurations.includes(v);
        })
        .validate('body.file_paths', v => _.isUndefined(v) || (_.isArray(v) && v.length <= 2))
        .validate('body.filePaths', v => _.isUndefined(v) || (_.isArray(v) && v.length <= 2))
        .validate('headers.authorization', _.isString);

      const uploadedFiles = request.files ? _.values(request.files) : [];
      if (uploadedFiles.length > 2) {
        throw new Error('最多只能上传2个图片文件');
      }

      const tokens = tokenSplit(request.headers.authorization);
      const token = _.sample(tokens);

      const {
        model = DEFAULT_VIDEO_MODEL,
        prompt,
        ratio = "1:1",
        resolution = "720p",
        duration = 5,
        file_paths = [],
        filePaths = [],
      } = request.body;

      const finalDuration = isMultiPart && typeof duration === 'string'
        ? parseInt(duration)
        : duration;

      const finalFilePaths = filePaths.length > 0 ? filePaths : file_paths;

      const historyId = await createVideoGenerationTask(
        model,
        prompt,
        {
          ratio,
          resolution,
          duration: finalDuration,
          filePaths: finalFilePaths,
          files: request.files,
        },
        token
      );

      return {
        created: util.unixTimestamp(),
        history_id: historyId,
        status: "submitted",
        message: "任务已提交，请使用 history_id 查询任务状态"
      };
    },

    // 查询任务状态
    "/tasks/query": async (request: Request) => {
      request
        .validate("body.history_id", _.isString)
        .validate("headers.authorization", _.isString);

      const tokens = tokenSplit(request.headers.authorization);
      const token = _.sample(tokens);
      const { history_id } = request.body;

      const taskStatus = await queryTaskStatus(history_id, token);

      return taskStatus;
    },
  },

  get: {
    // 查询任务状态（GET方法）
    "/tasks/:history_id": async (request: Request) => {
      request
        .validate("params.history_id", _.isString)
        .validate("headers.authorization", _.isString);

      const tokens = tokenSplit(request.headers.authorization);
      const token = _.sample(tokens);
      const { history_id } = request.params;

      const taskStatus = await queryTaskStatus(history_id, token);

      return taskStatus;
    },

    // 查询积分信息
    "/credits": async (request: Request) => {
      request
        .validate("headers.authorization", _.isString);

      const tokens = tokenSplit(request.headers.authorization);
      const token = _.sample(tokens);

      const credits = await queryCredits(token);

      return {
        credits: {
          total: credits.totalCredit,
          gift: credits.giftCredit,
          purchase: credits.purchaseCredit,
          vip: credits.vipCredit,
        },
        timestamp: util.unixTimestamp()
      };
    },
  },
};
