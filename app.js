const CONFIG = {
  oldModel: 'gpt-4o',
  newModel: 'gpt-4o',
  ready: false,
};

const els = {
  fileInput: document.querySelector('#fileInput'),
  chooseImageButton: document.querySelector('#chooseImageButton'),
  runButton: document.querySelector('#runButton'),
  emptyPicker: document.querySelector('#emptyPicker'),
  previewImage: document.querySelector('#previewImage'),
  fileMeta: document.querySelector('#fileMeta'),
  previewName: document.querySelector('#previewName'),
  previewSize: document.querySelector('#previewSize'),
  uploadStrip: document.querySelector('#uploadStrip'),
  uploadInfo: document.querySelector('#uploadInfo'),
  imageUrlText: document.querySelector('#imageUrlText'),
  apiStatus: document.querySelector('#apiStatus'),
  oldModelLabel: document.querySelector('#oldModelLabel'),
  oldModelDisplay: document.querySelector('#oldModelDisplay'),
  newModelDisplay: document.querySelector('#newModelDisplay'),
  phase1ModelInput: document.querySelector('#phase1ModelInput'),
  phase1ModelSelect: document.querySelector('#phase1ModelSelect'),
  customModelField: document.querySelector('#customModelField'),
  modelError: document.querySelector('#modelError'),
  fileError: document.querySelector('#fileError'),
  resultContext: document.querySelector('#resultContext'),
  decisionBanner: document.querySelector('#decisionBanner'),
  decisionText: document.querySelector('#decisionText'),
  uploadMetric: document.querySelector('#uploadMetric'),
  oldUsableMetric: document.querySelector('#oldUsableMetric'),
  newUsableMetric: document.querySelector('#newUsableMetric'),
  savedMetric: document.querySelector('#savedMetric'),
  oldStatus: document.querySelector('#oldStatus'),
  newStatus: document.querySelector('#newStatus'),
  oldFullTime: document.querySelector('#oldFullTime'),
  newBasicTime: document.querySelector('#newBasicTime'),
  newFullTime: document.querySelector('#newFullTime'),
  oldProduct: document.querySelector('#oldProduct'),
  oldCategory: document.querySelector('#oldCategory'),
  oldModeration: document.querySelector('#oldModeration'),
  oldConfidence: document.querySelector('#oldConfidence'),
  oldAttributes: document.querySelector('#oldAttributes'),
  newProduct: document.querySelector('#newProduct'),
  newCategory: document.querySelector('#newCategory'),
  newModeration: document.querySelector('#newModeration'),
  newConfidence: document.querySelector('#newConfidence'),
  newAttributes: document.querySelector('#newAttributes'),
  oldError: document.querySelector('#oldError'),
  newError: document.querySelector('#newError'),
  oldRawResult: document.querySelector('#oldRawResult'),
  newRawResult: document.querySelector('#newRawResult'),
};

const STAGES = ['Upload', 'Basic', 'Schema', 'Attributes', 'Validate'];
let selectedFile = null;
let previewUrl = null;
let runId = 0;
let metrics = { uploadMs: null, oldTotalMs: null, newBasicMs: null, newTotalMs: null };

function formatMs(ms) {
  if (ms == null || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validModelId(value) {
  return /^[A-Za-z0-9._:-]{1,100}$/.test(String(value || '').trim());
}

function refreshRunButton() {
  els.runButton.disabled = !CONFIG.ready || !selectedFile || !validModelId(selectedModel()) || els.runButton.dataset.running === 'true';
}

function selectedModel() {
  return els.phase1ModelSelect.value === 'custom'
    ? els.phase1ModelInput.value.trim()
    : els.phase1ModelSelect.value;
}

function updateModelSelection() {
  const custom = els.phase1ModelSelect.value === 'custom';
  els.customModelField.classList.toggle('hidden', !custom);
  const invalid = !validModelId(selectedModel());
  els.phase1ModelInput.setAttribute('aria-invalid', String(custom && invalid));
  setError(els.modelError, invalid ? 'Nhập tên model: chữ, số, dấu chấm, gạch ngang, gạch dưới hoặc dấu hai chấm.' : '');
  refreshRunButton();
}

function setStatus(element, kind, text) {
  element.className = `status ${kind}`;
  element.textContent = text;
}

function setError(element, message) {
  if (!message) {
    element.textContent = '';
    element.classList.add('hidden');
    return;
  }
  element.textContent = message;
  element.classList.remove('hidden');
}

function stageElement(flow, stage) {
  return document.querySelector(`#${flow}Stage${stage}`);
}

function setStage(flow, stage, value) {
  const element = stageElement(flow, stage);
  if (element) element.textContent = value;
}

function setStageMs(flow, stage, ms) {
  setStage(flow, stage, formatMs(ms));
}

function resetStageTimes() {
  for (const flow of ['old', 'new']) {
    for (const stage of STAGES) setStage(flow, stage, '—');
  }
}

function renderBasic(prefix, result) {
  document.querySelector(`#${prefix}Product`).textContent = result?.productName || '—';
  document.querySelector(`#${prefix}Category`).textContent = result?.category || '—';
  document.querySelector(`#${prefix}Confidence`).textContent = Number.isFinite(result?.confidence)
    ? `${Math.round(result.confidence * 100)}%`
    : '—';

  const moderation = result?.moderation;
  document.querySelector(`#${prefix}Moderation`).textContent = moderation
    ? (moderation.allowed ? 'Cho phép' : `Chặn${moderation.reason ? `: ${moderation.reason}` : ''}`)
    : '—';
}

function renderAttributes(prefix, result) {
  const container = document.querySelector(`#${prefix}Attributes`);
  const attributes = Array.isArray(result?.attributes) ? result.attributes : [];
  container.innerHTML = '';
  if (!attributes.length) {
    container.innerHTML = '<span class="muted">Không có thuộc tính quan sát được</span>';
    return;
  }
  for (const item of attributes.slice(0, 10)) {
    const chip = document.createElement('span');
    chip.className = 'attribute-chip';
    chip.textContent = `${item.key}: ${item.value}`;
    container.appendChild(chip);
  }
}

function resetResults() {
  metrics = { uploadMs: null, oldTotalMs: null, newBasicMs: null, newTotalMs: null };
  els.uploadInfo.textContent = 'Đang gửi ảnh…';
  els.imageUrlText.textContent = '';
  for (const id of ['uploadMetric', 'oldUsableMetric', 'newUsableMetric', 'savedMetric', 'oldFullTime', 'newBasicTime', 'newFullTime']) {
    els[id].textContent = '—';
  }
  for (const id of ['oldProduct', 'oldCategory', 'oldModeration', 'oldConfidence', 'newProduct', 'newCategory', 'newModeration', 'newConfidence']) {
    els[id].textContent = '—';
  }
  els.oldAttributes.innerHTML = '<span class="muted">—</span>';
  els.newAttributes.innerHTML = '<span class="muted">Đang chờ thông tin cơ bản</span>';
  els.oldRawResult.textContent = 'Chưa có dữ liệu.';
  els.newRawResult.textContent = 'Chưa có dữ liệu.';
  setError(els.oldError, '');
  setError(els.newError, '');
  resetStageTimes();
  setStatus(els.oldStatus, 'running', 'Đang chạy');
  setStatus(els.newStatus, 'running', 'Đang chạy');
  els.decisionBanner.className = 'decision-banner running';
  els.decisionText.textContent = 'Đang gửi ảnh. Hai cách sẽ nhận diện cùng một sản phẩm…';
  document.querySelector('.metric-card.gain')?.classList.remove('negative');
}

function updateDecision() {
  if (metrics.oldTotalMs == null || metrics.newBasicMs == null) return;
  const delta = metrics.oldTotalMs - metrics.newBasicMs;
  const abs = formatMs(Math.abs(delta));
  if (delta > 0) {
    els.savedMetric.textContent = `+${abs}`;
    els.decisionBanner.className = 'decision-banner good';
    els.decisionText.textContent = `Với Phase 1, người bán có thể bắt đầu sớm hơn ${abs} trong lần thử này.`;
  } else if (delta < 0) {
    els.savedMetric.textContent = `-${abs}`;
    els.decisionBanner.className = 'decision-banner bad';
    els.decisionText.textContent = `Trong lần thử này, Phase 1 cần chờ lâu hơn cách hiện tại ${abs}.`;
    document.querySelector('.metric-card.gain')?.classList.add('negative');
  } else {
    els.savedMetric.textContent = '0 ms';
    els.decisionBanner.className = 'decision-banner idle';
    els.decisionText.textContent = 'Hai cách có cùng thời gian chờ để bắt đầu trong lần thử này.';
  }
}

async function callAnalyze({ flow, stage, imageUrl, category, model }) {
  const startedAt = performance.now();
  const body = { flow, stage, imageUrl, category };
  if (flow === 'phase1') body.model = model;

  const response = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const payload = await response.json().catch(() => ({}));
  const clientMs = performance.now() - startedAt;
  if (!response.ok) {
    const error = new Error(payload.error || `HTTP ${response.status}`);
    error.providerMs = payload.providerMs;
    throw error;
  }
  return { ...payload, clientMs };
}

async function uploadImage(file) {
  const startedAt = performance.now();
  const response = await fetch('/api/upload', {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name),
    },
    body: file,
    signal: AbortSignal.timeout(120_000),
  });
  const payload = await response.json().catch(() => ({}));
  const clientMs = performance.now() - startedAt;
  if (!response.ok) throw new Error(payload.error || `Upload lỗi HTTP ${response.status}`);
  return { ...payload, clientMs };
}

async function localStage(flow, stage, ms) {
  const startedAt = performance.now();
  await sleep(ms);
  setStageMs(flow, stage, performance.now() - startedAt);
}

async function runOldFlow(imageUrl, uploadMs, activeRunId) {
  const startedAt = performance.now() - uploadMs;
  let currentStage = 'Basic';
  let basic = null;
  let attributes = null;
  try {
    setStageMs('old', 'Upload', uploadMs);

    const basicResponse = await callAnalyze({ flow: 'old', stage: 'basic', imageUrl });
    if (activeRunId !== runId) return;
    basic = basicResponse.result;
    setStageMs('old', 'Basic', basicResponse.clientMs);
    els.oldModelDisplay.textContent = basicResponse.model || CONFIG.oldModel;
    renderBasic('old', basic);

    currentStage = 'Schema';
    await localStage('old', 'Schema', 35);

    currentStage = 'Attributes';
    const attributesResponse = await callAnalyze({ flow: 'old', stage: 'attributes', imageUrl, category: basic?.category });
    if (activeRunId !== runId) return;
    attributes = attributesResponse.result;
    setStageMs('old', 'Attributes', attributesResponse.clientMs);
    renderAttributes('old', attributes);

    currentStage = 'Validate';
    await localStage('old', 'Validate', 10);

    const total = performance.now() - startedAt;
    metrics.oldTotalMs = total;
    els.oldUsableMetric.textContent = formatMs(total);
    els.oldFullTime.textContent = formatMs(total);
    setStatus(els.oldStatus, 'done', 'Hoàn tất');
    els.oldRawResult.textContent = JSON.stringify({ basic, attributes }, null, 2);
    updateDecision();
  } catch (error) {
    setStage('old', currentStage, 'Lỗi');
    setStatus(els.oldStatus, 'error', 'Lỗi');
    setError(els.oldError, `Chưa nhận đủ thông tin. Bạn có thể thử lại. Chi tiết: ${error.message}`);
    els.oldRawResult.textContent = JSON.stringify({ basic, attributes, error: error.message }, null, 2);
  }
}

async function runNewFlow(imageUrl, uploadMs, activeRunId, model) {
  const startedAt = performance.now() - uploadMs;
  let basic = null;
  let attributes = null;

  try {
    setStageMs('new', 'Upload', uploadMs);
    const basicResponse = await callAnalyze({ flow: 'phase1', stage: 'basic', imageUrl, model });
    if (activeRunId !== runId) return;

    basic = basicResponse.result;
    setStageMs('new', 'Basic', basicResponse.clientMs);
    els.newModelDisplay.textContent = basicResponse.model || model;
    renderBasic('new', basic);

    const basicElapsed = performance.now() - startedAt;
    metrics.newBasicMs = basicElapsed;
    els.newUsableMetric.textContent = formatMs(basicElapsed);
    els.newBasicTime.textContent = formatMs(basicElapsed);
    setStatus(els.newStatus, 'running', 'Đã có tên · Đang bổ sung');
    els.newRawResult.textContent = JSON.stringify({ basic, attributes: null }, null, 2);
    updateDecision();
  } catch (error) {
    setStage('new', 'Basic', 'Lỗi');
    setStatus(els.newStatus, 'error', 'Chưa nhận diện được');
    setError(els.newError, `Thử lại hoặc chọn model khác. Chi tiết: ${error.message}`);
    els.newRawResult.textContent = JSON.stringify({ error: error.message }, null, 2);
    return;
  }

  let currentStage = 'Schema';
  try {
    await localStage('new', 'Schema', 35);

    currentStage = 'Attributes';
    const attributesResponse = await callAnalyze({
      flow: 'phase1',
      stage: 'attributes',
      imageUrl,
      category: basic?.category,
      model,
    });
    if (activeRunId !== runId) return;
    attributes = attributesResponse.result;
    setStageMs('new', 'Attributes', attributesResponse.clientMs);
    renderAttributes('new', attributes);

    currentStage = 'Validate';
    await localStage('new', 'Validate', 10);

    const total = performance.now() - startedAt;
    metrics.newTotalMs = total;
    els.newFullTime.textContent = formatMs(total);
    setStatus(els.newStatus, 'done', 'Hoàn tất');
    els.newRawResult.textContent = JSON.stringify({ basic, attributes }, null, 2);
  } catch (error) {
    setStage('new', currentStage, 'Lỗi');
    setStatus(els.newStatus, 'warning', 'Thiếu chi tiết');
    setError(els.newError, `Đã có thông tin cơ bản, nhưng chưa bổ sung được chi tiết. Bạn có thể thử lại. Chi tiết: ${error.message}`);
    els.newRawResult.textContent = JSON.stringify({ basic, attributes, enrichmentError: error.message }, null, 2);
  }
}

function showSelectedFile(file) {
  selectedFile = file;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(file);
  els.previewImage.src = previewUrl;
  els.previewImage.classList.remove('hidden');
  els.emptyPicker.classList.add('hidden');
  els.fileMeta.textContent = file.name;
  els.previewName.textContent = file.name;
  els.previewSize.textContent = `${formatBytes(file.size)} • ${file.type || 'unknown type'}`;
  els.uploadInfo.textContent = 'Chưa upload';
  els.imageUrlText.textContent = '';
  els.uploadStrip.classList.remove('hidden');
  els.chooseImageButton.textContent = 'Đổi ảnh sản phẩm';
  refreshRunButton();
}

async function startBenchmark() {
  if (!selectedFile || !CONFIG.ready || els.runButton.dataset.running === 'true') return;
  const model = selectedModel();
  if (!validModelId(model)) {
    updateModelSelection();
    return;
  }

  runId += 1;
  const activeRunId = runId;
  resetResults();
  els.resultContext.textContent = `Ảnh: ${selectedFile.name} · Phase 1: ${model}`;
  els.newModelDisplay.textContent = model;
  els.oldModelDisplay.textContent = CONFIG.oldModel;
  document.querySelector('.results-section').setAttribute('aria-busy', 'true');
  els.runButton.dataset.running = 'true';
  els.runButton.textContent = 'Đang chạy…';
  els.chooseImageButton.disabled = true;
  els.phase1ModelInput.disabled = true;
  els.phase1ModelSelect.disabled = true;
  els.fileInput.disabled = true;
  refreshRunButton();

  try {
    const upload = await uploadImage(selectedFile);
    if (activeRunId !== runId) return;
    metrics.uploadMs = upload.clientMs;
    els.uploadMetric.textContent = formatMs(upload.clientMs);
    els.uploadInfo.textContent = `Upload ${formatMs(upload.clientMs)} • storage ${formatMs(upload.storageMs)}`;
    els.imageUrlText.textContent = upload.imageUrl;
    els.decisionText.textContent = 'AI đang nhận diện. Kết quả mỗi cách sẽ xuất hiện ngay khi sẵn sàng.';

    await Promise.all([
      runOldFlow(upload.imageUrl, upload.clientMs, activeRunId),
      runNewFlow(upload.imageUrl, upload.clientMs, activeRunId, model),
    ]);
    if (metrics.oldTotalMs == null || metrics.newBasicMs == null) {
      els.decisionBanner.className = 'decision-banner bad';
      els.decisionText.textContent = 'Chưa đủ kết quả để so sánh. Xem thông báo ở từng cách và thử lại.';
    } else {
      updateDecision();
      if (metrics.newTotalMs == null) els.decisionText.textContent += ' Phase 1 chưa có đủ chi tiết sản phẩm.';
    }
  } catch (error) {
    els.uploadInfo.textContent = 'Gửi ảnh không thành công';
    setStatus(els.oldStatus, 'error', 'Upload lỗi');
    setStatus(els.newStatus, 'error', 'Upload lỗi');
    setError(els.oldError, error.message);
    setError(els.newError, error.message);
    els.decisionBanner.className = 'decision-banner bad';
    els.decisionText.textContent = `Chưa gửi được ảnh. Vui lòng thử lại. Chi tiết: ${error.message}`;
  } finally {
    if (activeRunId === runId) {
      delete els.runButton.dataset.running;
      els.runButton.textContent = 'Chạy lại so sánh';
      els.chooseImageButton.disabled = false;
      els.phase1ModelInput.disabled = false;
      els.phase1ModelSelect.disabled = false;
      els.fileInput.disabled = false;
      document.querySelector('.results-section').setAttribute('aria-busy', 'false');
      refreshRunButton();
    }
  }
}

async function loadConfig() {
  try {
    const response = await fetch('/api/config', { cache: 'no-store' });
    if (!response.ok) throw new Error('Không đọc được cấu hình.');
    const config = await response.json();
    CONFIG.oldModel = config.oldModel || CONFIG.oldModel;
    CONFIG.newModel = config.newModel || CONFIG.newModel;
    CONFIG.ready = Boolean(config.hasApiKey && config.hasStorage);

    els.oldModelLabel.textContent = CONFIG.oldModel;
    els.oldModelDisplay.textContent = CONFIG.oldModel;
    if (![...els.phase1ModelSelect.options].some((option) => option.value === CONFIG.newModel)) {
      const option = document.createElement('option');
      option.value = CONFIG.newModel;
      option.textContent = `${CONFIG.newModel} · Cấu hình hiện tại`;
      els.phase1ModelSelect.insertBefore(option, els.phase1ModelSelect.lastElementChild);
    }
    if (Array.isArray(config.allowedModels)) {
      for (const option of [...els.phase1ModelSelect.options]) {
        if (!config.allowedModels.includes(option.value)) option.remove();
      }
    }
    els.phase1ModelSelect.value = 'gpt-4o';
    els.newModelDisplay.textContent = 'gpt-4o';

    if (CONFIG.ready) {
      els.apiStatus.className = 'server-status ready';
      els.apiStatus.textContent = 'Sẵn sàng trải nghiệm';
    } else {
      els.apiStatus.className = 'server-status error';
      els.apiStatus.textContent = 'Chưa sẵn sàng · Nhờ đội kỹ thuật kiểm tra kết nối AI và kho ảnh';
    }
    refreshRunButton();
  } catch {
    CONFIG.ready = false;
    els.apiStatus.className = 'server-status error';
    els.apiStatus.textContent = 'Mất kết nối · Tải lại trang hoặc liên hệ đội kỹ thuật';
    refreshRunButton();
  }
}

els.chooseImageButton.addEventListener('click', () => {
  els.fileInput.value = '';
  els.fileInput.click();
});

els.fileInput.addEventListener('change', (event) => {
  if (els.runButton.dataset.running === 'true') return;
  const [file] = event.target.files;
  if (!file) return;
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type) || !file.size || file.size > 25 * 1024 * 1024) {
    setError(els.fileError, 'Chọn ảnh JPG, PNG, WEBP hoặc GIF tĩnh, không rỗng và không quá 25 MB.');
    return;
  }
  setError(els.fileError, '');
  showSelectedFile(file);
});

els.phase1ModelInput.addEventListener('input', updateModelSelection);
els.phase1ModelSelect.addEventListener('change', updateModelSelection);

els.runButton.addEventListener('click', () => void startBenchmark());

void loadConfig();
