# Jimeng API 异步任务接口扩展

本文档说明了为 jimeng-api 项目新增的异步任务接口功能。

## 概述

为了支持更灵活的任务管理，我们新增了异步任务接口，允许您：
1. 创建图片/视频生成任务后立即返回 `history_id`
2. 不自动轮询任务状态
3. 由您自己控制何时查询任务状态

## 设计原则

- **无冲突**: 新接口独立于原有代码，不会影响原有功能
- **独立文件**: 所有新代码在独立文件中，便于后续合并主分支
- **兼容性**: 接口参数与原有接口保持一致

## 新增文件

```
src/api/
├── controllers/
│   └── async-tasks.ts       # 异步任务控制器（新增）
└── routes/
    └── async-tasks.ts       # 异步任务路由（新增）
```

## API 接口说明

所有异步接口路径前缀为 `/v1/async`，与原有同步接口 `/v1` 区分。

### 1. 异步文生图接口

**POST** `/v1/async/images/generations`

创建文生图任务，立即返回 `history_id`，不等待生成完成。

**请求参数**: 与 `/v1/images/generations` 完全相同

**响应示例**:
```json
{
  "created": 1759058768,
  "history_id": "abc123def456",
  "status": "submitted",
  "message": "任务已提交，请使用 history_id 查询任务状态"
}
```

### 2. 异步图生图接口

**POST** `/v1/async/images/compositions`

创建图生图任务，立即返回 `history_id`，不等待生成完成。

**请求参数**: 与 `/v1/images/compositions` 完全相同

**响应示例**:
```json
{
  "created": 1759058768,
  "history_id": "abc123def456",
  "input_images": 2,
  "status": "submitted",
  "message": "任务已提交，请使用 history_id 查询任务状态"
}
```

### 3. 异步视频生成接口

**POST** `/v1/async/videos/generations`

创建视频生成任务，立即返回 `history_id`，不等待生成完成。

**请求参数**: 与 `/v1/videos/generations` 完全相同

**响应示例**:
```json
{
  "created": 1759058768,
  "history_id": "abc123def456",
  "status": "submitted",
  "message": "任务已提交，请使用 history_id 查询任务状态"
}
```

### 4. 任务状态查询接口

#### 方法一: POST请求

**POST** `/v1/async/tasks/query`

**请求参数**:
```json
{
  "history_id": "abc123def456"
}
```

#### 方法二: GET请求

**GET** `/v1/async/tasks/{history_id}`

**请求头**:
```
Authorization: Bearer YOUR_SESSION_ID
```

**响应示例**:

正在处理中:
```json
{
  "history_id": "abc123def456",
  "task_type": "image",
  "status": 20,
  "fail_code": 0,
  "item_count": 0,
  "results": null,
  "raw_data": { ... }
}
```

已完成:
```json
{
  "history_id": "abc123def456",
  "task_type": "image",
  "status": 10,
  "fail_code": 0,
  "item_count": 4,
  "results": [
    { "url": "https://example.com/image1.webp" },
    { "url": "https://example.com/image2.webp" },
    { "url": "https://example.com/image3.webp" },
    { "url": "https://example.com/image4.webp" }
  ],
  "raw_data": { ... }
}
```

**状态码说明**:
- `10`: 任务已完成
- `20`: 任务处理中
- `30`: 任务失败

**任务类型说明**:
- `image`: 图片生成任务
- `video`: 视频生成任务
- `unknown`: 未知类型

## 使用示例

### 示例 1: 异步文生图

```bash
# 步骤1: 创建任务
curl -X POST http://localhost:5100/v1/async/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_SESSION_ID" \
  -d '{
    "model": "jimeng-4.5",
    "prompt": "一只可爱的小猫咪",
    "ratio": "1:1",
    "resolution": "2k"
  }'

# 响应: { "history_id": "abc123", "status": "submitted", ... }

# 步骤2: 查询任务状态（POST方法）
curl -X POST http://localhost:5100/v1/async/tasks/query \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_SESSION_ID" \
  -d '{
    "history_id": "abc123"
  }'

# 或使用GET方法
curl -X GET http://localhost:5100/v1/async/tasks/abc123 \
  -H "Authorization: Bearer YOUR_SESSION_ID"
```

### 示例 2: 异步图生图

```bash
# 步骤1: 创建任务（multipart/form-data）
curl -X POST http://localhost:5100/v1/async/images/compositions \
  -H "Authorization: Bearer YOUR_SESSION_ID" \
  -F "prompt=一只可爱的猫，动漫风格" \
  -F "model=jimeng-4.5" \
  -F "images=@/path/to/your/cat.jpg"

# 步骤2: 查询任务状态
curl -X GET http://localhost:5100/v1/async/tasks/{history_id} \
  -H "Authorization: Bearer YOUR_SESSION_ID"
```

### 示例 3: 异步视频生成

```bash
# 步骤1: 创建任务
curl -X POST http://localhost:5100/v1/async/videos/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_SESSION_ID" \
  -d '{
    "model": "jimeng-video-3.0",
    "prompt": "一只奔跑在草原上的狮子",
    "ratio": "16:9",
    "duration": 10
  }'

# 步骤2: 轮询查询（建议间隔3-5秒）
curl -X GET http://localhost:5100/v1/async/tasks/{history_id} \
  -H "Authorization: Bearer YOUR_SESSION_ID"
```

## 查询策略建议

### 图片任务
- 首次查询: 提交后 5-10 秒
- 轮询间隔: 3-5 秒
- 超时时间: 15 分钟

### 视频任务
- 首次查询: 提交后 10-15 秒
- 轮询间隔: 5-10 秒
- 超时时间: 20 分钟

## 错误处理

所有异步接口会返回标准的错误响应格式：

```json
{
  "error": {
    "message": "错误描述",
    "type": "api_error",
    "code": "ERROR_CODE"
  }
}
```

常见错误：
- 任务不存在: 查询不存在的 `history_id`
- 积分不足: 账户积分余额不足
- 参数错误: 请求参数不符合要求

## 与原有接口的区别

| 特性 | 原有同步接口 | 新增异步接口 |
|-----|------------|-------------|
| 路径前缀 | `/v1` | `/v1/async` |
| 返回结果 | 等待完成后返回图片/视频URL | 立即返回 `history_id` |
| 轮询行为 | 内部自动轮询 | 由调用方自行轮询 |
| 超时控制 | 固定超时时间 | 由调用方控制 |
| 适用场景 | 简单同步调用 | 需要更灵活控制的场景 |

## 注意事项

1. **原有功能不受影响**: 所有代码在独立文件中，不修改原有控制器和路由
2. **合并主分支**: 后续同步 jimeng-api 主分支时，只需关注新增的两个文件即可
3. **认证方式**: 与原有接口保持一致，使用 `Authorization: Bearer SESSION_ID` 头部
4. **积分消耗**: 创建任务时即消耗积分，与同步接口一致

## 测试建议

```bash
# 1. 测试异步文生图
HISTORY_ID=$(curl -s -X POST http://localhost:5100/v1/async/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_SESSION_ID" \
  -d '{"prompt": "测试图片", "model": "jimeng-4.5"}' | jq -r '.history_id')

# 2. 查询状态
curl -X GET http://localhost:5100/v1/async/tasks/$HISTORY_ID \
  -H "Authorization: Bearer YOUR_SESSION_ID" | jq

# 3. 验证原有接口不受影响
curl -X POST http://localhost:5100/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_SESSION_ID" \
  -d '{"prompt": "测试图片", "model": "jimeng-4.5"}' | jq
```

## 维护说明

当 jimeng-api 主分支更新时，处理冲突的建议：

1. 如果 `src/api/routes/index.ts` 有冲突：
   - 保留我们添加的 `import asyncTasks from './async-tasks.ts';`
   - 在 `export default` 数组中保留 `asyncTasks`
   - 在根路由的 `endpoints` 中保留新增的异步接口端点

2. 新增文件不会产生冲突：
   - `src/api/controllers/async-tasks.ts`
   - `src/api/routes/async-tasks.ts`

3. 如果控制器函数签名变化：
   - 检查 `images.ts` 和 `videos.ts` 中的导出函数
   - 相应更新 `async-tasks.ts` 中的调用

## 支持

如有问题，请查看：
- [原始项目文档](https://github.com/iptag/jimeng-api)
- 本项目的主 README.CN.md
