import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash, createHmac, randomUUID } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const HOST = process.env.HOST || (IS_PRODUCTION ? '0.0.0.0' : '127.0.0.1');
const PORT = Number(process.env.PORT || 8765);
const OLD_MODEL = process.env.OLD_MODEL || 'gpt-4o';
const NEW_MODEL = process.env.NEW_MODEL || 'gpt-4o';
const ALLOWED_MODELS = IS_PRODUCTION ? ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini'] : null;
// ponytail: quota is per process/hour; use shared persistent counters before adding replicas.
let quota = { expiresAt: Date.now() + 3_600_000, uploads: 0, analyses: 0 };
let activeRequests = 0;
const OPENAI_API_URL = 'https://api.openai.com/v1/responses';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const S3_ENDPOINT = process.env.AWS_S3_ENDPOINT || process.env.S3_ENDPOINT || '';
const S3_PUBLIC_URL = process.env.AWS_S3_PUBLICURL || process.env.S3_PUBLIC_URL || '';
const S3_REGION = process.env.AWS_S3_REGION || 'auto';
const S3_ACCESS_KEY = process.env.AWS_S3_ACCESS_KEY || process.env.S3_ACCESS_KEY || '';
const S3_SECRET_KEY = process.env.AWS_S3_SECRET_KEY || process.env.S3_SECRET_KEY || '';
const S3_BUCKET = process.env.S3_BUCKET || 'biddi-public';
const STORAGE_READY = Boolean(S3_ENDPOINT && S3_PUBLIC_URL && S3_ACCESS_KEY && S3_SECRET_KEY);

const MIME_BY_EXT = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function json(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error('Yêu cầu vượt quá 64 KB.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    const body = raw ? JSON.parse(raw) : {};
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error();
    return body;
  } catch {
    const error = new Error('Nội dung JSON không hợp lệ.');
    error.statusCode = 400;
    throw error;
  }
}

async function readBinaryBody(req, maxBytes = MAX_IMAGE_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error('Ảnh quá lớn cho demo (tối đa 25 MB).');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function validateImageUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function imageExtension(fileName, contentType) {
  const normalizedName = String(fileName || '').toLowerCase();
  const nameMatch = normalizedName.match(/\.(jpg|jpeg|png|webp|gif)$/);
  if (nameMatch) return nameMatch[1] === 'jpeg' ? 'jpg' : nameMatch[1];

  const byMime = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
  };
  return byMime[contentType] || null;
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hmacSha256(key, value, encoding = null) {
  const digest = createHmac('sha256', key).update(value).digest();
  return encoding === 'hex' ? digest.toString('hex') : digest;
}

function toAmzDate(date = new Date()) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function encodePathSegment(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function putObjectToStorage({ key, body, contentType }) {
  if (!STORAGE_READY) {
    const error = new Error('Thiếu cấu hình storage cho demo.');
    error.statusCode = 503;
    throw error;
  }

  const endpoint = new URL(S3_ENDPOINT);
  const endpointBasePath = endpoint.pathname.replace(/\/+$/, '');
  const canonicalUri = `${endpointBasePath}/${encodePathSegment(S3_BUCKET)}/${encodePathSegment(key)}`.replace(/^\/\//, '/');
  const payloadHash = sha256Hex(body);
  const amzDate = toAmzDate();
  const dateStamp = amzDate.slice(0, 8);
  const canonicalHeaders = [
    `content-type:${contentType}`,
    `host:${endpoint.host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
    '',
  ].join('\n');
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    'PUT',
    canonicalUri,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const credentialScope = `${dateStamp}/${S3_REGION}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmacSha256(Buffer.from(`AWS4${S3_SECRET_KEY}`, 'utf8'), dateStamp);
  const kRegion = hmacSha256(kDate, S3_REGION);
  const kService = hmacSha256(kRegion, 's3');
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = hmacSha256(kSigning, stringToSign, 'hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${S3_ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const uploadUrl = new URL(canonicalUri, endpoint.origin);

  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      Authorization: authorization,
      'Content-Type': contentType,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    },
    body,
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const responseText = await response.text().catch(() => '');
    const error = new Error(`Storage upload lỗi HTTP ${response.status}${responseText ? `: ${responseText.slice(0, 200)}` : ''}`);
    error.statusCode = 502;
    throw error;
  }
}

function extractOutputText(response) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }

  for (const item of response?.output || []) {
    for (const part of item?.content || []) {
      if (part?.type === 'output_text' && typeof part.text === 'string') {
        return part.text.trim();
      }
    }
  }
  return '';
}

const BASIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    productName: { type: 'string' },
    category: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    moderation: {
      type: 'object',
      additionalProperties: false,
      properties: {
        allowed: { type: 'boolean' },
        reason: { type: 'string' },
      },
      required: ['allowed', 'reason'],
    },
    visibleEvidence: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['productName', 'category', 'confidence', 'moderation', 'visibleEvidence'],
};

const OLD_BASIC_SCHEMA = {
  ...BASIC_SCHEMA,
  properties: {
    ...BASIC_SCHEMA.properties,
    description: { type: 'string' },
    guessedPriceBand: { type: 'string' },
  },
  required: [...BASIC_SCHEMA.required, 'description', 'guessedPriceBand'],
};

const ATTRIBUTES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attributes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['key', 'value', 'confidence'],
      },
    },
    moderation: {
      type: 'object',
      additionalProperties: false,
      properties: {
        allowed: { type: 'boolean' },
        reason: { type: 'string' },
      },
      required: ['allowed', 'reason'],
    },
  },
  required: ['attributes', 'moderation'],
};

function promptFor({ flow, stage, category }) {
  if (stage === 'basic' && flow === 'old') {
    return [
      'Phân tích ảnh sản phẩm thương mại điện tử.',
      'Hãy nhận diện sản phẩm, chọn category gần nhất, đánh giá moderation, nêu bằng chứng nhìn thấy.',
      'Đồng thời viết mô tả tương đối đầy đủ và đoán price band để mô phỏng prompt cũ nặng hơn.',
      'Chỉ dựa trên ảnh; nếu không chắc hãy giảm confidence.',
    ].join(' ');
  }

  if (stage === 'basic') {
    return [
      'Phân tích nhanh ảnh sản phẩm thương mại điện tử.',
      'Chỉ trả productName, category, confidence, moderation và visibleEvidence.',
      'Không suy đoán giá, năm sản xuất, cân nặng hoặc thông tin không nhìn thấy.',
      'Ưu tiên kết quả ngắn, chắc chắn và dùng được để mở form sớm.',
    ].join(' ');
  }

  return [
    `Category đã chọn: ${category || 'unknown'}.`,
    'Đọc ảnh và chỉ trích xuất các thuộc tính quan sát được trực tiếp như brand, model, color, material, text/OCR nếu có.',
    'Không bịa thuộc tính không nhìn thấy. Trả confidence cho từng thuộc tính.',
    flow === 'old'
      ? 'Lặp lại moderation để mô phỏng logic cũ.'
      : 'Giữ moderation như publish gate; output ngắn gọn.',
  ].join(' ');
}

async function callOpenAI({ model, flow, stage, imageUrl, category }) {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error('Server chưa có OPENAI_API_KEY. Hãy export biến môi trường rồi chạy lại demo.');
    error.statusCode = 503;
    throw error;
  }

  const schema = stage === 'basic'
    ? (flow === 'old' ? OLD_BASIC_SCHEMA : BASIC_SCHEMA)
    : ATTRIBUTES_SCHEMA;

  const textConfig = {
    format: {
      type: 'json_schema',
      name: `${flow}_${stage}_result`,
      strict: true,
      schema,
    },
  };

  if (/^gpt-[56](?:[.-]|$)/.test(model)) {
    textConfig.verbosity = 'low';
  }

  const startedAt = performance.now();
  const apiResponse = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: promptFor({ flow, stage, category }) },
            { type: 'input_image', image_url: imageUrl, detail: 'auto' },
          ],
        },
      ],
      text: textConfig,
      max_output_tokens: stage === 'basic' ? (flow === 'old' ? 700 : 320) : 500,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const providerMs = performance.now() - startedAt;
  const payload = await apiResponse.json();

  if (!apiResponse.ok) {
    const message = payload?.error?.message || `OpenAI API lỗi HTTP ${apiResponse.status}`;
    const error = new Error(message);
    error.statusCode = apiResponse.status;
    error.providerMs = providerMs;
    throw error;
  }

  const outputText = extractOutputText(payload);
  if (!outputText) {
    const error = new Error('OpenAI không trả output_text cho request này.');
    error.statusCode = 502;
    error.providerMs = providerMs;
    throw error;
  }

  let result;
  try {
    result = JSON.parse(outputText);
  } catch {
    const error = new Error('Structured output trả về không parse được JSON.');
    error.statusCode = 502;
    error.providerMs = providerMs;
    throw error;
  }

  return {
    result,
    providerMs,
    responseId: payload.id || null,
    model: payload.model || model,
    usage: payload.usage || null,
  };
}

async function handleUpload(req, res) {
  if (!STORAGE_READY) {
    return json(res, 503, {
      error: 'Demo chưa có đủ cấu hình storage (endpoint/public URL/access key/secret key).',
    });
  }

  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const rawName = String(req.headers['x-file-name'] || 'product-image');
  let originalName = rawName;
  try {
    originalName = decodeURIComponent(rawName);
  } catch {
    originalName = rawName;
  }
  const extension = imageExtension(originalName, contentType);

  if (!extension || !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(contentType)) {
    return json(res, 400, { error: 'Chỉ hỗ trợ JPG, PNG, WEBP hoặc GIF trong demo.' });
  }

  const body = await readBinaryBody(req);
  if (!body.length) {
    return json(res, 400, { error: 'File ảnh rỗng.' });
  }

  const key = `${randomUUID()}.${extension}`;
  const startedAt = performance.now();
  await putObjectToStorage({ key, body, contentType });
  const storageMs = performance.now() - startedAt;
  const imageUrl = `${S3_PUBLIC_URL.replace(/\/$/, '')}/${S3_BUCKET}/${key}`;

  return json(res, 200, {
    imageUrl,
    key,
    bucket: S3_BUCKET,
    size: body.length,
    contentType,
    storageMs,
  });
}

async function handleAnalyze(req, res) {
  const requestStartedAt = performance.now();
  const body = await readJsonBody(req);
  const { flow, stage, imageUrl, category, model: requestedModel } = body;

  if (!['old', 'phase1'].includes(flow)) {
    return json(res, 400, { error: 'flow phải là old hoặc phase1.' });
  }
  if (!['basic', 'attributes'].includes(stage)) {
    return json(res, 400, { error: 'stage phải là basic hoặc attributes.' });
  }
  if (!validateImageUrl(imageUrl)) {
    return json(res, 400, { error: 'imageUrl phải là URL HTTP(S) hợp lệ.' });
  }
  if (imageUrl.length > 4096 || (category != null && (typeof category !== 'string' || category.length > 200))) {
    return json(res, 400, { error: 'URL ảnh hoặc danh mục quá dài / không hợp lệ.' });
  }

  if (requestedModel != null && (
    typeof requestedModel !== 'string' ||
    requestedModel.length > 100 ||
    !/^[A-Za-z0-9._:-]+$/.test(requestedModel)
  )) {
    return json(res, 400, { error: 'model không hợp lệ.' });
  }

  const model = flow === 'old' ? OLD_MODEL : (requestedModel || NEW_MODEL);
  if (ALLOWED_MODELS && !ALLOWED_MODELS.includes(model)) {
    return json(res, 400, { error: 'Bản chia sẻ chỉ hỗ trợ GPT-4o, GPT-4o mini, GPT-4.1 và GPT-4.1 mini.' });
  }
  const output = await callOpenAI({ model, flow, stage, imageUrl, category });
  return json(res, 200, {
    ...output,
    requestMs: performance.now() - requestStartedAt,
  });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  if (!['/index.html', '/app.js', '/styles.css'].includes(pathname)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const fullPath = path.join(__dirname, pathname);

  try {
    const data = await readFile(fullPath);
    const type = MIME_BY_EXT[path.extname(fullPath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  let countedRequest = false;
  try {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (IS_PRODUCTION) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, { status: 'ok' });
    if (req.method === 'POST' && req.headers.origin && req.headers.origin !== `https://${req.headers.host}` && (IS_PRODUCTION || req.headers.origin !== `http://${req.headers.host}`)) {
      return json(res, 403, { error: 'Không cho phép yêu cầu từ website khác.' });
    }
    if (req.method === 'POST') {
      if (IS_PRODUCTION && ['/api/upload', '/api/analyze'].includes(req.url)) {
        if (Date.now() >= quota.expiresAt) quota = { expiresAt: Date.now() + 3_600_000, uploads: 0, analyses: 0 };
        const counter = req.url === '/api/upload' ? 'uploads' : 'analyses';
        const limit = counter === 'uploads' ? 20 : 80;
        if (quota[counter] >= limit) {
          res.setHeader('Retry-After', String(Math.ceil((quota.expiresAt - Date.now()) / 1000)));
          return json(res, 429, { error: 'Demo đã hết lượt trong giờ này. Vui lòng thử lại sau.' });
        }
        if (activeRequests >= 4) return json(res, 429, { error: 'Demo đang bận. Vui lòng thử lại sau ít phút.' });
        quota[counter] += 1;
        activeRequests += 1;
        countedRequest = true;
      }
    }
    if (req.method === 'GET' && req.url === '/api/config') {
      return json(res, 200, {
        hasApiKey: Boolean(process.env.OPENAI_API_KEY),
        hasStorage: STORAGE_READY,
        oldModel: OLD_MODEL,
        newModel: NEW_MODEL,
        allowedModels: ALLOWED_MODELS,
        uploadMode: 'biddi-public-storage-url',
        storagePublicUrl: S3_PUBLIC_URL || null,
        storageBucket: S3_BUCKET,
      });
    }

    if (req.method === 'POST' && req.url === '/api/upload') {
      return await handleUpload(req, res);
    }

    if (req.method === 'POST' && req.url === '/api/analyze') {
      return await handleAnalyze(req, res);
    }

    if (req.method === 'GET') {
      return await serveStatic(req, res);
    }

    res.writeHead(405);
    res.end('Method not allowed');
  } catch (error) {
    json(res, error?.statusCode || 500, {
      error: error?.message || 'Server error',
      providerMs: error?.providerMs || null,
    });
  } finally {
    if (countedRequest) activeRequests -= 1;
  }
});

server.listen(PORT, HOST, () => {
  const keyState = process.env.OPENAI_API_KEY ? 'có OPENAI_API_KEY' : 'CHƯA có OPENAI_API_KEY';
  const storageState = STORAGE_READY ? 'storage ready' : 'storage missing';
  console.log(`BIDDI Phase 1 demo: http://${HOST}:${server.address().port}`);
  console.log(`Models: old=${OLD_MODEL} | phase1=${NEW_MODEL} | ${keyState} | ${storageState}`);
});
