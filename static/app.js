/* =========================================================================
   SVS 病理图像查看器 —— 前端逻辑（OpenSeadragon + ROI + 项目/标注）
   ========================================================================= */
(function () {
  "use strict";

  // ---------- 全局状态 ----------
  var state = {
    slide: null,          // 当前切片 {name,width,height,mppX,mppY,mppSource}
    mppX: null,           // 当前生效的 µm/px
    roiMode: null,        // null | 6 | 6.5
    roi: { x: 0, y: 0, side: 0 },
    rotation: 0,
    flipped: false,       // 是否水平翻转（镜像）
    drawMode: null,       // null | "arrow" | "freehand"（与 roiMode 互斥）
    showAnno: false,      // 是否在画布层显示已保存标注
    focusAnno: null,      // null=显示全部；否则只显示该条标注（flatItems 中的引用）
  };

  // ---------- 401 认证处理 ----------
  // fetch 包装：响应 401 且 body 含 auth_required 时跳登录页。
  // 对现有调用透明——仍返回 Response，调用方照常 .json()/.ok 判断。
  function apiFetch(url, opts) {
    return fetch(url, opts).then(function (resp) {
      if (resp.status === 401) {
        // 尝试读 body 判断是否 auth_required（不消费主响应流：克隆一份）
        return resp.clone().json().then(
          function (body) {
            if (body && body.error === "auth_required") {
              location.href = "/login?next=" + encodeURIComponent(location.pathname);
            }
            return resp;
          },
          function () { return resp; }  // body 非 JSON，原样返回
        );
      }
      return resp;
    });
  }

  // 页面初始化时拉取认证状态：启用认证则显示退出登录（附用户名）
  function initAuth() {
    if (!els.logoutBtn) return;
    apiFetch("/api/auth/info").then(function (r) { return r.json(); }).then(function (info) {
      if (info && info.auth_enabled) {
        var label = "退出登录";
        if (info.username) { label += " (" + info.username + ")"; }
        els.logoutBtn.textContent = label;
        els.logoutBtn.hidden = false;
      }
    }).catch(function () { /* 忽略，不影响主功能 */ });
  }

  // 缓存：全部切片、全部项目、全部分享
  var allSlides = [];      // [{name,width,height,mpp_x,...}]
  var allProjects = [];    // [{pid,name,note,slides,roi_count,...}]
  var currentAnnotations = null; // 当前切片的标注 {slide, annotations:[{label,count,items}]}
  var annoOverlays = [];   // 兼容旧引用，已不再新增（标注改画到 canvas）
  var annoPanelOpen = false;

  // ---------- AI 读片助手状态 ----------
  var aiPanelOpen = false;
  var aiOverlay = [];        // canvas 叠加：agent 的 bbox（goto/snapshot），青色虚线框
  var aiConfig = null;       // {base_url, api_key_set, api_key_mask, model, max_tokens, ...}
  // AI 判读区配色（#3）：overlay 半透明填充 + 描边；AI 落标（进标注库 source=ai）填充
  // 颜色/透明度集中在此常量调，人工标注保持更淡（drawAnnoItem 内按 source 区分）。
  var AI_OVERLAY_FILL = "rgba(0,229,255,0.10)";   // agent goto/snapshot 判读区填充
  var AI_OVERLAY_STROKE = "#00E5FF";               // agent 判读区虚线描边
  var AI_ANNO_FILL = "rgba(0,229,255,0.14)";       // 进标注库的 AI 标注填充（比人工略浓）
  var aiRunning = false;     // 是否有进行中的 run（同时只允一个）
  var aiAbortCtrl = null;    // AbortController，停止用
  var aiTextBubbleEl = null; // 当前 text_delta 增量气泡（append 用）
  var aiSessionId = null;    // 当前 main session id（events 里带）
  var aiLastSeq = 0;         // 已消费的最大事件 seq（断线重挂用）
  var aiStreamCtrl = null;   // 断线重挂 SSE 流的 AbortController
  var aiPaused = false;      // 主 run 是否处于"已暂停，可继续"
  var aiTraceTarget = null;  // fork 批注对话的 DOM 容器（非空时轨迹渲染到此）

  // 编辑模式状态：选中/拖动（管理端所有标注可编辑）
  // editItem：flatItems 中的引用（可改本地几何）；editDrag：拖动会话
  // editing：是否处于「显式编辑态」（进入后画手柄、可拖动，防误挪位置）
  var editItem = null;
  var editDrag = null;
  var editing = false;

  // 临时选择器状态
  var pickerCtx = { targetPid: null, selected: {} };

  // 未归类勾选
  var slideChecked = {};   // 切片勾选状态（项目内 + 未归类统一，供分享/新建项目用）

  // 分享创建用的临时切片集（分享选中 / 项目分享）
  var sharePendingSlides = null; // 若非 null，则用此切片集创建分享

  // ---------- DOM ----------
  var viewer = null;
  function $(id) { return document.getElementById(id); }
  var els = {
    currentSlide: $("current-slide"),
    zoomIn: $("zoom-in"),
    zoomOut: $("zoom-out"),
    rotateBtn: $("rotate-btn"),
    flipBtn: $("flip-btn"),
    roi6: $("roi-6"),
    roi65: $("roi-6-5"),
    saveBtn: $("save-btn"),
    saveAnnoBtn: $("save-anno-btn"),
    annoBtn: $("anno-btn"),
    annoAllBtn: $("anno-all-btn"),
    annoArrowBtn: $("anno-arrow-btn"),
    annoFreeBtn: $("anno-free-btn"),
    annoLabelInput: $("anno-label-input"),
    annoCanvas: $("anno-canvas"),
    resetBtn: $("reset-btn"),
    mppSetter: $("mpp-setter"),
    mppInput: $("mpp-input"),
    mppSetBtn: $("mpp-set-btn"),
    zoomBadge: $("zoom-badge"),
    headerZoomBadge: $("header-zoom-badge"),
    tbbMoreBtn: $("tbb-more-btn"),
    tbbMore: $("tbb-more"),
    tbbMoreAi: $("tbb-more-ai"),
    uploadBtn: $("upload-btn"),
    fileInput: $("file-input"),
    progressWrap: $("progress-wrap"),
    progressBar: $("progress-bar"),
    progressText: $("progress-text"),
    viewerWrap: $("viewer-wrap"),
    dropOverlay: $("drop-overlay"),
    toastContainer: $("toast-container"),
    logoutBtn: $("logout-btn"),
    roiBoxBtn: $("roi-box-btn"),
    annoAllToggle: $("anno-all-toggle"),
    // 手机端侧栏抽屉
    menuBtn: $("menu-btn"),
    sidebar: $("sidebar"),
    sidebarMask: $("sidebar-mask"),
    // 项目
    newProjectBtn: $("new-project-btn"),
    newProjectForm: $("new-project-form"),
    npName: $("np-name"),
    npNote: $("np-note"),
    npConfirm: $("np-confirm"),
    npCancel: $("np-cancel"),
    projectList: $("project-list"),
    unfiledToggle: $("unfiled-toggle"),
    unfiledCount: $("unfiled-count"),
    unfiledBody: $("unfiled-body"),
    unfiledList: $("unfiled-list"),
    unfiledNewProject: $("unfiled-new-project"),
    unfiledShare: $("unfiled-share"),
    // 分享
    shareMgrToggle: $("share-mgr-toggle"),
    shareMgrBody: $("share-mgr-body"),
    shareExpiresSelect: $("share-expires-select"),
    shareExpiresCustom: $("share-expires-custom"),
    shareRoiSizeSelect: $("share-roi-size-select"),
    shareCreateBtn: $("share-create-btn"),
    shareResult: $("share-result"),
    shareResultUrl: $("share-result-url"),
    shareResultCopy: $("share-result-copy"),
    shareList: $("share-list"),
    // 切片选择器
    pickerMask: $("slide-picker-mask"),
    pickerTitleText: $("picker-title-text"),
    pickerClose: $("picker-close"),
    pickerList: $("picker-list"),
    pickerSelectedCount: $("picker-selected-count"),
    pickerConfirm: $("picker-confirm"),
    // 标注面板
    annoPanel: $("anno-panel"),
    annoPanelTitle: $("anno-panel-title"),
    annoPanelClose: $("anno-panel-close"),
    annoPanelList: $("anno-panel-list"),
    // AI 读片助手
    aiBtn: $("ai-btn"),
    aiPanel: $("ai-panel"),
    aiPanelClose: $("ai-panel-close"),
    aiConfigWrap: $("ai-config-wrap"),
    aiConfigCollapsed: $("ai-config-collapsed"),
    aiConfigSummary: $("ai-config-summary"),
    aiReconfigBtn: $("ai-reconfig-btn"),
    aiBaseUrl: $("ai-base-url"),
    aiApiKey: $("ai-api-key"),
    aiModel: $("ai-model"),
    aiMaxSteps: $("ai-max-steps"),
    aiApiProtocol: $("ai-api-protocol"),
    aiCtxWindow: $("ai-ctx-window"),
    aiReserve: $("ai-reserve"),
    aiSafetyMargin: $("ai-safety-margin"),
    aiKeepRecent: $("ai-keep-recent"),
    aiForkLimit: $("ai-fork-limit"),
    aiLeaseTtl: $("ai-lease-ttl"),
    aiConfigSave: $("ai-config-save"),
    aiConfigHint: $("ai-config-hint"),
    aiTask: $("ai-task"),
    aiTaskJump: $("ai-task-jump"),
    aiStartBtn: $("ai-start-btn"),
    aiContinueBtn: $("ai-continue-btn"),
    aiFreshBtn: $("ai-fresh-btn"),
    aiStopBtn: $("ai-stop-btn"),
    aiTrace: $("ai-trace"),
  };

  var roiBox = null;
  var dragInfo = null;
  // 底图缩略图层：铺在瓦片层后面的模糊预览，慢网下避免瓦片未到区域变白
  var baseThumbEl = null;

  // ---------- 工具函数 ----------
  function toast(msg, type) {
    type = type || "info";
    var el = document.createElement("div");
    el.className = "toast " + type;
    el.textContent = msg;
    els.toastContainer.appendChild(el);
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 3000);
  }

  function fmtSize(bytes) {
    if (bytes == null) return "-";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + " MB";
    return (bytes / 1073741824).toFixed(2) + " GB";
  }

  function mppTagClass(src) { return src || "missing"; }

  function clamp(v, lo, hi) {
    if (hi < lo) hi = lo;
    return Math.max(lo, Math.min(hi, v));
  }

  function esc(s) {
    // 简易转义，用于 innerHTML 注入（标题等用户输入）
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // 标注徽章文本（如 "标记 3 · 2 人"）
  function annoBadgeText(slideName) {
    if (!allAnnotationsBySlide) return null;
    var grps = allAnnotationsBySlide[slideName];
    if (!grps || grps.length === 0) return null;
    var total = 0;
    var people = 0;
    grps.forEach(function (g) { total += g.count || 0; people += 1; });
    return "标记 " + total + "·" + people + " 人";
  }

  // 文件名中间截断：保留首尾，中间用 … 连接
  function truncateMiddle(s, max) {
    s = String(s == null ? "" : s);
    if (!max || max < 6) max = 18;
    if (s.length <= max) return s;
    var head = Math.ceil((max - 1) / 2);
    var tail = Math.floor((max - 1) / 2);
    return s.slice(0, head) + "…" + s.slice(s.length - tail);
  }

  // 缓存 annotations_by_slide（从 /api/annotations 拉取全量后缓存）
  var allAnnotationsBySlide = null;
  function loadAnnotationsIndex() {
    return apiFetch("/api/annotations")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        allAnnotationsBySlide = data.by_slide || {};
      })
      .catch(function () { allAnnotationsBySlide = {}; });
  }

  // 某切片是否属于任一项目
  function isSlideInAnyProject(slideName) {
    for (var i = 0; i < allProjects.length; i++) {
      if (allProjects[i].slides && allProjects[i].slides.indexOf(slideName) >= 0) {
        return true;
      }
    }
    return false;
  }

  // label -> 颜色（哈希着色）
  function labelColor(label) {
    var s = String(label || "");
    var h = 0;
    for (var i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) >>> 0;
    }
    var hue = h % 360;
    return { fill: "hsla(" + hue + ",70%,55%,0.18)", stroke: "hsl(" + hue + ",70%,45%)" };
  }

  // ---------- 初始化 OpenSeadragon ----------
  function initViewer() {
    viewer = OpenSeadragon({
      element: $("viewer"),
      showNavigationControl: false,
      // 慢网下适度限制并发图像请求（略增并发以更快填补空隙）
      imageLoaderLimit: 8,
      // 瓦片未到位时透明：露出后面铺好的缩略图底图，避免白/灰块
      placeholderFillStyle: null,
      compositeOperation: "source-over",
      minZoomImageRatio: 0.5,
      maxZoomPixelRatio: 10,
      // 偏保守选层（默认 0.5 → 0.4）：同屏瓦片更倾向取自同一层，
      // 减少高低层混排的“割裂”接缝，同时降低慢网请求量（轻微变柔，可接受）
      minPixelRatio: 0.4,
      defaultZoomLevel: 0,           // 自适应初始缩放
      immediateRender: false,
      preload: false,
      wrapHorizontal: false,
      wrapVertical: false,
      preserveImageSizeOnResize: true,
      // 滚轮缩放更细腻，便于慢网手动控缩放，避免一次跳太多层
      pixelsPerWheelLine: 40,
      gestureSettingsMouse: {
        scrollToZoom: true,
        clickToZoom: false,
        dblClickToZoom: true,
      },
      gestureSettingsTouch: {
        pinchToZoom: true,
        flickEnabled: false,
      },
      animationTime: 0.3,
      visibilityRatio: 0.1,
      prefixUrl: "",
    });
    // 图外空白区用深色背景，减少慢网下大面积空白的刺眼感
    viewer.container.style.backgroundColor = "#262a30";
    viewer.addHandler("zoom", function () { updateZoomBadge(); syncBaseThumb(); });
    viewer.addHandler("open", onViewerOpen);
    // 底图随平移/缩放实时跟随（animation 每帧触发，跟随最平滑）
    viewer.addHandler("animation", function () { syncBaseThumb(); redrawAnnoCanvas(); });
    // 动画结束补画文本（标签/气泡）：动画期间为流畅省略了文本绘制
    viewer.addHandler("animation-finish", function () { redrawAnnoCanvas(); });
    viewer.addHandler("rotate", function () { syncBaseThumb(); redrawAnnoCanvas(); });
    // 镜像翻转：OSD 'flip' 事件 → 同步底图 transform / 重绘标注画布 / ROI 框重对位
    viewer.addHandler("flip", function () {
      state.flipped = !!viewer.viewport.getFlip();
      applyBaseThumbFlip();
      syncBaseThumb();
      redrawAnnoCanvas();
      updateRoiOverlay();
    });
    viewer.addHandler("resize", redrawAnnoCanvas);
    // 切片关闭时清理旧底图
    viewer.addHandler("close", clearBaseThumb);
  }

  function onViewerOpen() {
    updateZoomBadge();
    // 打开后把底图缩略图对齐到当前视口
    syncBaseThumb();
    // 打开新切片：退出绘制模式、清面板、重置标注画布尺寸
    exitDrawMode();
    resizeAnnoCanvas();
    els.annoBtn.disabled = true;
    els.annoAllBtn.disabled = true;
    els.annoPanel.style.display = "none";
    annoPanelOpen = false;
    // AI 助手：打开新切片时 enable 按钮、清空 overlay、关面板（保留配置）
    els.aiBtn.disabled = false;
    if (els.tbbMoreAi) els.tbbMoreAi.disabled = false;  // ⋯ 面板里的 AI 钮同步
    aiOverlay = [];
    redrawAnnoCanvas();
    syncAnnoAllBtns();
    state.showAnno = false;
    state.focusAnno = null;
    // 恢复该切片的 main 会话状态（有 running 的则重挂 SSE）
    aiSessionId = null;
    aiPaused = false;
    restoreAiSession();
    if (state.slide) {
      // 管理员标注工具在任意打开的切片上可用（箭头/描图不依赖 mpp）
      els.annoArrowBtn.disabled = false;
      els.annoFreeBtn.disabled = false;
      // 拉取该切片标注
      apiFetch("/api/annotations?slide=" + encodeURIComponent(state.slide.name))
        .then(function (r) { return r.json(); })
        .then(function (data) {
          currentAnnotations = data;
          var annos = data.annotations || [];
          if (annos.length > 0) {
            els.annoBtn.disabled = false;
            els.annoAllBtn.disabled = false;
          }
          editItem = null;
          state.focusAnno = null;
          editing = false;
          rebuildFlatItems();
          redrawAnnoCanvas();
        })
        .catch(function () { currentAnnotations = null; editItem = null; state.focusAnno = null; editing = false; rebuildFlatItems(); redrawAnnoCanvas(); });
    } else {
      els.annoArrowBtn.disabled = true;
      els.annoFreeBtn.disabled = true;
      redrawAnnoCanvas();
    }
  }

  // 把"图像缩放比"换算成读片软件常用的物镜等效倍率（如 20× / 40×）。
  // 约定屏幕 96 DPI（1 屏像素 ≈ 25400/96 µm）；缺 mpp 时无法换算，回退百分比。
  function formatMag(mag) {
    // 全片概览时屏显等效倍率会到天文数字（无物理意义），缩写为 k 避免撑爆徽章
    if (mag >= 1000000) return (mag / 1000000).toFixed(1).replace(/\.0$/, "") + "M×";
    if (mag >= 10000) return Math.round(mag / 1000) + "k×";
    if (mag >= 10) return Math.round(mag) + "×";
    if (mag >= 1) return mag.toFixed(1) + "×";
    return mag.toFixed(2) + "×";
  }
  // AI 轨迹里的倍率：可能是数字（需格式化）或已带单位的字符串（如 "20x (high power)"）
  function fmtAiMag(mag) {
    if (mag === null || mag === undefined || mag === "") return "";
    if (typeof mag === "string") return mag;  // 已格式化（如 ai_agent 的 magnification_label）
    var m = Number(mag);
    if (!isFinite(m)) return String(mag);
    return (m >= 10 ? Math.round(m) : m.toFixed(1)) + "x";
  }
  function updateZoomBadge() {
    var text = "—";
    try {
      if (viewer && viewer.viewport && viewer.source) {
        var zoom = viewer.viewport.getZoom(true);
        var containerW = viewer.viewport.getContainerSize().x;
        var imgW = viewer.source.dimensions.x;
        // 真实图像缩放 = 视口缩放 × 容器宽 / 图像宽（1 = 1 图像像素对应 1 屏幕像素）
        var imageZoom = (zoom * containerW) / imgW;
        var mpp = state.mppX;
        if (mpp && mpp > 0 && imageZoom > 0) {
          // 相对物镜倍率：以 1:1 图像像素 = 物镜倍率(10/mpp) 为锚，
          // 全片 fit 时 <1（如 0.2×），zoom 到细胞细节趋近 40×。像显微镜的相对倍率。
          var mag = imageZoom * (10 / mpp);
          text = formatMag(mag);
        } else {
          text = Math.round(imageZoom * 100) + "%";
        }
      }
    } catch (e) { /* 保持 — */ }
    els.zoomBadge.textContent = text;
    if (els.headerZoomBadge) els.headerZoomBadge.textContent = text;  // 同步顶部徽章（移动端）
  }

  // ---------- 底图缩略图层（慢网下瓦片未到区域的模糊预览） ----------
  function applyBaseThumbFlip() {
    if (!baseThumbEl) return;
    baseThumbEl.style.transformOrigin = "center";
    baseThumbEl.style.transform = state.flipped ? "scaleX(-1)" : "";
  }


  function clearBaseThumb() {
    if (baseThumbEl) {
      if (baseThumbEl.parentNode) baseThumbEl.parentNode.removeChild(baseThumbEl);
      baseThumbEl = null;
    }
  }

  function syncBaseThumb() {
    if (!baseThumbEl || !viewer || !viewer.viewport || !state.slide) return;
    var W = state.slide.width, H = state.slide.height;
    if (!W || !H) return;
    try {
      var tl = viewer.viewport.imageToViewerElementCoordinates(new OpenSeadragon.Point(0, 0));
      var br = viewer.viewport.imageToViewerElementCoordinates(new OpenSeadragon.Point(W, H));
      var left = Math.min(tl.x, br.x);
      var top = Math.min(tl.y, br.y);
      var width = Math.abs(br.x - tl.x);
      var height = Math.abs(br.y - tl.y);
      baseThumbEl.style.left = left + "px";
      baseThumbEl.style.top = top + "px";
      baseThumbEl.style.width = width + "px";
      baseThumbEl.style.height = height + "px";
      // 仅当旋转角为 0/180 时显示底图，避免 90/270 错位（瓦片本身正常旋转显示）
      baseThumbEl.style.display = (state.rotation % 180 === 0) ? "block" : "none";
    } catch (e) {}
  }

  // ---------- 打开切片 ----------
  function openSlide(name) {
    // 切换切片前移除旧底图
    clearBaseThumb();
    var url = "/api/slide/" + encodeURIComponent(name) + "/info";
    apiFetch(url)
      .then(function (r) { return r.json(); })
      .then(function (info) {
        if (info.error) { toast("打开失败: " + info.error, "error"); return; }
        state.slide = {
          name: info.name,
          width: info.width,
          height: info.height,
          mppX: info.mpp_x,
          mppY: info.mpp_y,
          mppSource: info.mpp_source,
        };
        state.mppX = info.mpp_x;
        state.rotation = 0;
        els.currentSlide.textContent = info.alias || info.name;
        els.currentSlide.title = info.name + (info.note ? " · " + info.note : "");
        updateMppSetterVisibility();
        exitRoi();
        // 创建底图缩略图层：铺在瓦片 canvas 之前（下层），慢网下透出模糊预览
        baseThumbEl = document.createElement("img");
        baseThumbEl.className = "osd-base-thumb";
        baseThumbEl.src = "/api/slide/" + encodeURIComponent(name) + "/thumbnail";
        baseThumbEl.alt = "";
        viewer.container.insertBefore(baseThumbEl, viewer.canvas);
        applyBaseThumbFlip();
        viewer.open("/api/slide/" + encodeURIComponent(name) + ".dzi");
        // 高亮列表项（未归类与项目切片行）
        document.querySelectorAll(".slide-row").forEach(function (it) {
          it.classList.toggle("active", it.dataset.name === name);
        });
        // 手机端：打开切片后自动收起侧栏抽屉，让用户立刻看到查看器；
        // 抽屉收起会改变 viewer 容器宽度，这里补一次画布尺寸同步。
        if (isMobileWidth()) {
          closeSidebarDrawer();
          resizeAnnoCanvas();
          redrawAnnoCanvas();
        }
      })
      .catch(function (e) { toast("获取切片信息失败: " + e, "error"); });
  }

  // ---------- mpp 设置区显示控制 ----------
  function updateMppSetterVisibility() {
    if (!state.slide) { els.mppSetter.style.display = "none"; return; }
    var src = state.slide.mppSource;
    if (src === "missing" || src === "estimated") {
      els.mppSetter.style.display = "flex";
      els.mppInput.value = state.mppX != null ? state.mppX : "";
    } else {
      els.mppSetter.style.display = "none";
    }
  }

  // ---------- 缩放 / 旋转 / 复位 ----------
  function zoomIn() {
    if (!viewer || !viewer.viewport) return;
    viewer.viewport.zoomBy(1.4);
    viewer.viewport.applyConstraints();
  }
  function zoomOut() {
    if (!viewer || !viewer.viewport) return;
    viewer.viewport.zoomBy(1 / 1.4);
    viewer.viewport.applyConstraints();
  }
  function rotate() {
    if (!viewer || !viewer.viewport) return;
    state.rotation = (state.rotation + 90) % 360;
    viewer.viewport.setRotation(state.rotation);
    updateRoiOverlay();
    redrawAnnoCanvas();
  }
  function flip() {
    if (!viewer || !viewer.viewport || !viewer.viewport.toggleFlip) return;
    viewer.viewport.toggleFlip();
    // 'flip' 事件负责同步 state/各层；toggleFlip 可能未触发事件时兜底
    state.flipped = !!viewer.viewport.getFlip();
    applyBaseThumbFlip();
    syncBaseThumb();
    redrawAnnoCanvas();
    updateRoiOverlay();
  }
  function reset() {
    if (!viewer || !viewer.viewport) return;
    state.rotation = 0;
    viewer.viewport.setRotation(0);
    // 复位时取消镜像（回到默认朝向）
    if (viewer.viewport.getFlip && viewer.viewport.getFlip()) {
      viewer.viewport.toggleFlip();
    }
    viewer.viewport.goHome(true);
  }

  // ---------- ROI 功能 ----------
  function roiSide(sizeMm) {
    if (!state.mppX || state.mppX <= 0) return 0;
    return Math.round((sizeMm * 1000) / state.mppX);
  }

  function toggleRoi(sizeMm) {
    if (!state.slide) { toast("请先打开一个切片", "error"); return; }
    if (!state.mppX || state.mppX <= 0) {
      toast("缺少 mpp（µm/px），请先在工具栏设置 mpp", "error");
      return;
    }
    // 进入 ROI 模式时退出箭头/描图绘制模式（互斥）
    exitDrawMode();
    if (state.slide.mppSource === "estimated") {
      toast("提示：当前 mpp 为估算值，ROI 尺寸仅供参考", "info");
    }
    if (state.roiMode === sizeMm) { exitRoi(); return; }

    var newSide = roiSide(sizeMm);
    if (newSide <= 0) { toast("ROI 尺寸计算失败", "error"); return; }

    var W0 = state.slide.width, H0 = state.slide.height;
    if (newSide > W0 || newSide > H0) {
      var physW = (W0 * state.mppX / 1000).toFixed(1);
      var physH = (H0 * state.mppX / 1000).toFixed(1);
      toast("注意：整张图像仅约 " + physW + "×" + physH + " mm，" +
            sizeMm + "mm 选区已超出图像范围（mpp=" + state.mppX + "）", "info");
    }

    var W = state.slide.width, H = state.slide.height;
    var cx, cy;
    if (state.roiMode != null && state.roi.side > 0) {
      cx = state.roi.x + state.roi.side / 2;
      cy = state.roi.y + state.roi.side / 2;
    } else {
      cx = W / 2; cy = H / 2;
      try {
        var center = viewer.viewport.getCenter();
        var imgPt = viewer.viewport.viewportToImageCoordinates(center);
        cx = imgPt.x; cy = imgPt.y;
      } catch (e) {}
    }
    var x = clamp(cx - newSide / 2, 0, Math.max(0, W - newSide));
    var y = clamp(cy - newSide / 2, 0, Math.max(0, H - newSide));

    state.roiMode = sizeMm;
    state.roi.x = Math.round(x);
    state.roi.y = Math.round(y);
    state.roi.side = newSide;

    createRoiBox();
    updateRoiOverlay();
    updateRoiButtons();
    els.saveBtn.disabled = false;
    els.saveAnnoBtn.disabled = false;
    updateCtxBar();
  }

  function exitRoi() {
    state.roiMode = null;
    if (roiBox && viewer && viewer.currentOverlays) {
      try { viewer.removeOverlay(roiBox); } catch (e) {}
    }
    if (roiBox && roiBox.parentNode) roiBox.parentNode.removeChild(roiBox);
    roiBox = null;
    updateRoiButtons();
    els.saveBtn.disabled = true;
    els.saveAnnoBtn.disabled = true;
    updateCtxBar();
  }

  function updateRoiButtons() {
    els.roi6.classList.toggle("active", state.roiMode === 6);
    els.roi65.classList.toggle("active", state.roiMode === 6.5);
    syncRoiSlider(); // 同步移动端滑块分段 + 滑动拇指
  }

  // ---------- 移动端 ROI 滑块分段（取代旧弹窗选择器） ----------
  // 管理端固定 6 / 6.5 两段；#roi-box-btn 为分段容器，滑块拇指滑到激活段。
  function syncRoiSlider() {
    var box = els.roiBoxBtn;
    if (!box) return;
    var segs = box.querySelectorAll(".roi-slider-seg");
    if (!segs.length) return;
    var activeIdx = -1;
    segs.forEach(function (seg, i) {
      var sz = Number(seg.getAttribute("data-size"));
      var on = state.roiMode === sz;
      seg.classList.toggle("active", on);
      if (on) activeIdx = i;
    });
    box.classList.toggle("active", activeIdx >= 0);
    var thumb = box.querySelector(".roi-slider-thumb");
    if (thumb) {
      var n = segs.length || 1;
      thumb.style.width = (100 / n) + "%";
      thumb.style.transform = "translateX(" + (activeIdx >= 0 ? activeIdx * 100 : 0) + "%)";
      thumb.style.opacity = activeIdx >= 0 ? "1" : "0";
    }
  }

  function createRoiBox() {
    if (roiBox) return;
    roiBox = document.createElement("div");
    roiBox.id = "roi-box";
    var tl = document.createElement("div"); tl.className = "roi-corner tl";
    var tr = document.createElement("div"); tr.className = "roi-corner tr";
    var bl = document.createElement("div"); bl.className = "roi-corner bl";
    var br = document.createElement("div"); br.className = "roi-corner br";
    roiBox.appendChild(tl); roiBox.appendChild(tr);
    roiBox.appendChild(bl); roiBox.appendChild(br);
    var label = document.createElement("div");
    label.className = "roi-label";
    roiBox.appendChild(label);
    roiBox.addEventListener("pointerdown", onRoiPointerDown);
    viewer.container.appendChild(roiBox);
  }

  function updateRoiOverlay() {
    if (!roiBox || !state.slide) return;
    var r = state.roi;
    if (r.side <= 0) return;
    var label = roiBox.querySelector(".roi-label");
    // 仅在 ROI 模式下刷新标签，避免 roiMode 为 null 时显示 "nullmm × nullmm"
    if (label && state.roiMode != null) label.textContent = state.roiMode + "mm × " + state.roiMode + "mm";
    var rect = viewer.viewport.imageToViewportRectangle(r.x, r.y, r.side, r.side);
    var existing = viewer.getOverlayById(roiBox);
    if (existing) {
      viewer.updateOverlay(roiBox, rect, OpenSeadragon.Placement.TOP_LEFT);
    } else {
      var opts = { element: roiBox, location: rect,
                   placement: OpenSeadragon.Placement.TOP_LEFT };
      if (state.rotation % 360 !== 0 && OpenSeadragon.OverlayRotationMode &&
          OpenSeadragon.OverlayRotationMode.BOUNDING_BOX) {
        opts.rotationMode = OpenSeadragon.OverlayRotationMode.BOUNDING_BOX;
      }
      viewer.addOverlay(opts);
    }
  }

  // ---------- ROI 拖拽 ----------
  function onRoiPointerDown(e) {
    if (!state.slide) return;
    e.preventDefault(); e.stopPropagation();
    try { roiBox.setPointerCapture(e.pointerId); } catch (err) {}
    dragInfo = {
      pointerId: e.pointerId,
      startRoiX: state.roi.x,
      startRoiY: state.roi.y,
      startImg: viewer.viewport.viewerElementToImageCoordinates(
        new OpenSeadragon.Point(e.clientX - getViewerRect().left,
                                e.clientY - getViewerRect().top)),
    };
    viewer.setMouseNavEnabled(false);
    roiBox.addEventListener("pointermove", onRoiPointerMove);
    roiBox.addEventListener("pointerup", onRoiPointerUp);
    roiBox.addEventListener("pointercancel", onRoiPointerUp);
  }

  function onRoiPointerMove(e) {
    if (!dragInfo) return;
    e.preventDefault(); e.stopPropagation();
    var rect = getViewerRect();
    var curImg = viewer.viewport.viewerElementToImageCoordinates(
      new OpenSeadragon.Point(e.clientX - rect.left, e.clientY - rect.top));
    var grabX = dragInfo.startImg.x - dragInfo.startRoiX;
    var grabY = dragInfo.startImg.y - dragInfo.startRoiY;
    var W = state.slide.width, H = state.slide.height, side = state.roi.side;
    var nx = clamp(Math.round(curImg.x - grabX), 0, Math.max(0, W - side));
    var ny = clamp(Math.round(curImg.y - grabY), 0, Math.max(0, H - side));
    state.roi.x = nx; state.roi.y = ny;
    viewer.updateOverlay(
      roiBox,
      viewer.viewport.imageToViewportRectangle(nx, ny, side, side),
      OpenSeadragon.Placement.TOP_LEFT
    );
  }

  function onRoiPointerUp(e) {
    if (!dragInfo) return;
    e.preventDefault(); e.stopPropagation();
    try { roiBox.releasePointerCapture(dragInfo.pointerId); } catch (err) {}
    roiBox.removeEventListener("pointermove", onRoiPointerMove);
    roiBox.removeEventListener("pointerup", onRoiPointerUp);
    roiBox.removeEventListener("pointercancel", onRoiPointerUp);
    dragInfo = null;
    viewer.setMouseNavEnabled(true);
  }

  function getViewerRect() { return viewer.container.getBoundingClientRect(); }

  // ---------- 保存图片（裁剪） ----------
  function saveCrop() {
    if (!state.slide || state.roiMode == null) return;
    var r = state.roi;
    var name = state.slide.name;
    var url = "/api/slide/" + encodeURIComponent(name) +
      "/crop?x=" + Math.round(r.x) + "&y=" + Math.round(r.y) +
      "&size=" + Math.round(r.side);
    var originalText = els.saveBtn.textContent;
    els.saveBtn.textContent = "导出中...";
    els.saveBtn.disabled = true;
    apiFetch(url)
      .then(function (res) {
        if (!res.ok) {
          return res.json().then(function (j) {
            throw new Error(j.error || ("导出失败 " + res.status));
          });
        }
        return res.blob();
      })
      .then(function (blob) {
        var stem = name.replace(/\.[^.]+$/, "");
        var fname = stem + "_" + state.roiMode + "mm_x" + Math.round(r.x) +
          "_y" + Math.round(r.y) + ".png";
        var a = document.createElement("a");
        var objUrl = URL.createObjectURL(blob);
        a.href = objUrl; a.download = fname;
        document.body.appendChild(a); a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(objUrl); }, 1000);
        toast("已导出: " + fname, "success");
      })
      .catch(function (e) { toast("导出失败: " + e.message, "error"); })
      .finally(function () {
        els.saveBtn.textContent = originalText;
        els.saveBtn.disabled = state.roiMode == null;
      });
  }

  // ---------- 保存矩形选区为标注（管理员 rect 标注） ----------
  function saveAnno() {
    if (!state.slide || state.roiMode == null) return;
    var r = state.roi;
    var label = (els.annoLabelInput.value || "").trim() || "管理员";
    var body = {
      slide: state.slide.name,
      type: "rect",
      label: label,
      x: Math.round(r.x),
      y: Math.round(r.y),
      side_px: Math.round(r.side),
      size_mm: state.roiMode,
      shared: false,
      note: "",
    };
    els.saveAnnoBtn.disabled = true;
    apiFetch("/api/annotation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (j) {
          throw new Error(j.error || ("保存失败 " + res.status));
        });
        return res.json();
      })
      .then(function () {
        toast("标注已保存（可在标注面板设为公开）", "success");
        refreshCurrentAnnotations();
        loadAnnotationsIndex().then(function () {
          renderProjects(allProjects);
          renderUnfiled();
        });
      })
      .catch(function (e) { toast("保存失败: " + e.message, "error"); })
      .finally(function () {
        els.saveAnnoBtn.disabled = state.roiMode == null;
      });
  }

  // ---------- 手动设置 mpp ----------
  function setMpp() {
    var v = parseFloat(els.mppInput.value);
    if (!isFinite(v) || v <= 0) { toast("请输入有效的 mpp 数值", "error"); return; }
    state.mppX = v;
    if (state.slide) { state.slide.mppX = v; state.slide.mppSource = "manual"; }
    if (state.roiMode != null) {
      var newSide = roiSide(state.roiMode);
      var W = state.slide.width, H = state.slide.height;
      var cx = state.roi.x + state.roi.side / 2;
      var cy = state.roi.y + state.roi.side / 2;
      var x = clamp(cx - newSide / 2, 0, Math.max(0, W - newSide));
      var y = clamp(cy - newSide / 2, 0, Math.max(0, H - newSide));
      state.roi.x = Math.round(x); state.roi.y = Math.round(y);
      state.roi.side = newSide;
      updateRoiOverlay();
    }
    updateMppSetterVisibility();
    toast("mpp 已设为 " + v + " µm/px", "success");
  }

  // =========================================================================
  // 项目渲染与管理
  // =========================================================================
  function loadAll() {
    // 并行加载切片、项目、分享、标注索引、AI 配置
    return Promise.all([
      fetch("/api/slides").then(function (r) { return r.json(); }),
      fetch("/api/projects").then(function (r) { return r.json(); }),
      fetch("/api/share/list").then(function (r) { return r.json(); }),
      loadAnnotationsIndex(),
      loadAiConfig(),
    ]).then(function (results) {
      allSlides = results[0] || [];
      allProjects = results[1] || [];
      renderProjects(allProjects);
      renderUnfiled();
      renderShareList((results[2] && results[2].shares) || []);
    }).catch(function (e) {
      toast("加载数据失败: " + e, "error");
    });
  }

  function reloadProjectsAndUnfiled() {
    return Promise.all([
      fetch("/api/projects").then(function (r) { return r.json(); }),
      fetch("/api/slides").then(function (r) { return r.json(); }),
      loadAnnotationsIndex(),
    ]).then(function (results) {
      allProjects = results[0] || [];
      allSlides = results[1] || [];
      renderProjects(allProjects);
      renderUnfiled();
    });
  }

  function reloadShares() {
    return apiFetch("/api/share/list")
      .then(function (r) { return r.json(); })
      .then(function (data) { renderShareList((data && data.shares) || []); });
  }

  // 渲染单个切片信息块（用于项目行、未归类项、选择器项）
  // 行式版：纯文本 "宽×高 · mpp x.xx"，估算值带 *
  function slideMetaTags(s) {
    var parts = [];
    if (s.width && s.height) {
      parts.push(s.width + "×" + s.height);
    }
    if (s.mpp_x != null) {
      // mpp 保留 3 位小数，避免副行过长被截断
      var mpp = Math.round(s.mpp_x * 1000) / 1000;
      parts.push("mpp " + mpp + (s.mpp_source === "estimated" ? "*" : ""));
    } else {
      parts.push("mpp 缺失");
    }
    return parts.join(" · ");
  }

  function renderProjects(projects) {
    els.projectList.innerHTML = "";
    if (!projects || projects.length === 0) {
      var empty = document.createElement("div");
      empty.className = "proj-empty";
      empty.textContent = "暂无项目，点击「＋ 新建项目」";
      els.projectList.appendChild(empty);
      return;
    }
    projects.forEach(function (p) {
      var row = document.createElement("div");
      row.className = "proj-row";
      row.dataset.pid = p.pid;

      var slideCount = p.slide_count != null ? p.slide_count : (p.slides || []).length;
      var roiCount = p.roi_count || 0;

      // 头部行：chevron + 图标 + 名称/副行 + 计数 + 操作
      var head = document.createElement("div");
      head.className = "proj-head";

      var chevron = document.createElement("span");
      chevron.className = "chevron";
      chevron.textContent = "▸";
      chevron.title = "展开/收起";
      head.appendChild(chevron);

      var icon = document.createElement("span");
      icon.className = "icon";
      icon.textContent = "📁";
      head.appendChild(icon);

      var main = document.createElement("div");
      main.className = "ph-main";
      var nameEl = document.createElement("div");
      nameEl.className = "proj-name";
      nameEl.textContent = p.name || "未命名项目";
      var meta = document.createElement("div");
      meta.className = "proj-meta";
      meta.textContent = slideCount + " 切片 · " + roiCount + " 标注" +
        (p.note ? " · " + p.note : "");
      main.appendChild(nameEl);
      main.appendChild(meta);
      head.appendChild(main);

      var countBadge = document.createElement("span");
      countBadge.className = "proj-count";
      countBadge.textContent = String(slideCount);
      head.appendChild(countBadge);

      // 操作按钮（hover 浮现）
      var ops = document.createElement("div");
      ops.className = "proj-ops";
      function opBtn(cls, glyph, title) {
        var b = document.createElement("button");
        b.className = "proj-op " + cls;
        b.textContent = glyph; b.title = title || "";
        return b;
      }
      var shareBtn = opBtn("po-share", "↗", "分享本项目");
      var editBtn = opBtn("po-edit", "✎", "重命名/编辑");
      var addBtn = opBtn("po-add", "＋", "添加切片");
      var delBtn = opBtn("po-del", "🗑", "删除项目");
      ops.appendChild(shareBtn);
      ops.appendChild(editBtn);
      ops.appendChild(addBtn);
      ops.appendChild(delBtn);
      head.appendChild(ops);
      row.appendChild(head);

      shareBtn.addEventListener("click", function (e) { e.stopPropagation(); shareProject(p); });
      editBtn.addEventListener("click", function (e) { e.stopPropagation(); editProject(p); });
      addBtn.addEventListener("click", function (e) { e.stopPropagation(); openSlidePicker(p.pid, p.name); });
      delBtn.addEventListener("click", function (e) { e.stopPropagation(); deleteProject(p); });

      // 展开体：切片行
      var body = document.createElement("div");
      body.className = "proj-body";
      (p.slides || []).forEach(function (sname) {
        body.appendChild(renderSlideRow(sname, false));
      });
      row.appendChild(body);

      // 点击头部（chevron 或名称区）展开/收起
      function toggleExpand(e) {
        if (e.target.closest(".proj-ops")) return; // 操作按钮不触发展开
        row.classList.toggle("expanded");
      }
      chevron.addEventListener("click", toggleExpand);
      main.addEventListener("click", toggleExpand);
      countBadge.addEventListener("click", toggleExpand);

      els.projectList.appendChild(row);
    });
  }

  // 切片行（项目展开体内 / 未归类）。unfiled=true 时显示复选框。
  function renderSlideRow(sname, unfiled) {
    var sinfo = findSlideInfo(sname);
    var row = document.createElement("div");
    row.className = "slide-row";
    row.dataset.name = sname;
    if (state.slide && state.slide.name === sname) row.classList.add("active");

    // 所有切片行（项目内 + 未归类）都带复选框，可勾选用于分享/新建项目
    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "slide-check";
    cb.title = "勾选（用于分享/新建项目）";
    if (slideChecked[sname]) cb.checked = true;
    cb.addEventListener("click", function (ev) { ev.stopPropagation(); });
    cb.addEventListener("change", function () { slideChecked[sname] = cb.checked; });
    row.appendChild(cb);

    var mid = document.createElement("div");
    mid.className = "slide-mid";
    var failed = (sinfo && sinfo.error) || (!sinfo);
    var alias = (sinfo && sinfo.alias) || "";

    // 第一行：别名优先（无别名则截断文件名）+ 标注 pill，第二行：meta
    var top = document.createElement("div");
    top.className = "slide-top";
    var nameEl = document.createElement("span");
    nameEl.className = "slide-name";
    if (alias) {
      nameEl.classList.add("alias-first");
      nameEl.innerHTML = esc(alias) +
        '<span class="alias-filename">' + esc(truncateMiddle(sname, 20)) + "</span>";
      nameEl.title = sname + (failed ? "（读取失败）" : "");
    } else {
      nameEl.textContent = truncateMiddle(sname, 24) + (failed ? " (读取失败)" : "");
    }
    top.appendChild(nameEl);

    // 标注 pill
    var badgeText = annoBadgeText(sname);
    if (badgeText) {
      var badge = document.createElement("button");
      badge.className = "anno-pill";
      badge.textContent = badgeText;
      badge.title = "查看该切片标注";
      badge.addEventListener("click", function (e) {
        e.stopPropagation();
        openSlide(sname);
        // 打开后自动展开标注面板
        setTimeout(function () { openAnnoPanel(); }, 600);
      });
      top.appendChild(badge);
    }
    mid.appendChild(top);

    var meta = document.createElement("div");
    meta.className = "slide-meta";
    var metaParts = [];
    if (sinfo) {
      metaParts.push(slideMetaTags(sinfo));
      if (unfiled && sinfo.size_bytes) metaParts.push(fmtSize(sinfo.size_bytes));
      if (sinfo.note) metaParts.push('<span class="sm-note">' + esc(sinfo.note) + "</span>");
    } else {
      metaParts.push("未找到");
    }
    meta.innerHTML = metaParts.join(" · ");
    mid.appendChild(meta);
    row.appendChild(mid);

    // 别名/备注编辑钮（hover 浮现）
    var editBtn = document.createElement("button");
    editBtn.className = "slide-edit";
    editBtn.textContent = "✎";
    editBtn.title = "编辑别名/备注";
    editBtn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      enterSlideMetaEdit(row, sname, sinfo);
    });
    row.appendChild(editBtn);

    // 单独分享按钮（hover 浮现）：直接分享这一张，无需勾选
    var shareBtn = document.createElement("button");
    shareBtn.className = "slide-share";
    shareBtn.textContent = "↗";
    shareBtn.title = "单独分享此切片";
    shareBtn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      doCreateShare([sname]);
    });
    row.appendChild(shareBtn);

    // 删除按钮（hover 浮现）
    var delBtn = document.createElement("button");
    delBtn.className = "slide-del";
    delBtn.textContent = "×";
    delBtn.title = "删除切片";
    delBtn.addEventListener("click", function (ev) { ev.stopPropagation(); deleteSlide(sname); });
    row.appendChild(delBtn);

    row.addEventListener("click", function () { openSlide(sname); });
    return row;
  }

  // 行内别名/备注编辑态
  function enterSlideMetaEdit(row, sname, sinfo) {
    if (!row) return;
    var alias0 = (sinfo && sinfo.alias) || "";
    var note0 = (sinfo && sinfo.note) || "";
    // 清空行内容，替换为编辑表单
    row.innerHTML = "";
    row.classList.add("editing");
    row.removeEventListener("click", openSlide);
    var form = document.createElement("div");
    form.className = "slide-edit-form";
    var aInput = document.createElement("input");
    aInput.type = "text"; aInput.maxLength = 60; aInput.placeholder = "别名";
    aInput.value = alias0;
    var nInput = document.createElement("input");
    nInput.type = "text"; nInput.maxLength = 200; nInput.placeholder = "备注";
    nInput.value = note0;
    var actions = document.createElement("div");
    actions.className = "sef-actions";
    var okBtn = document.createElement("button");
    okBtn.className = "btn primary small"; okBtn.textContent = "确认";
    var cancelBtn = document.createElement("button");
    cancelBtn.className = "btn secondary small"; cancelBtn.textContent = "取消";
    actions.appendChild(okBtn); actions.appendChild(cancelBtn);
    form.appendChild(aInput); form.appendChild(nInput); form.appendChild(actions);
    row.appendChild(form);
    aInput.focus();

    function commit() {
      var alias = aInput.value;
      var note = nInput.value;
      apiFetch("/api/slide/" + encodeURIComponent(sname) + "/meta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alias: alias, note: note }),
      })
        .then(function (r) {
          if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || "保存失败"); });
          return r.json();
        })
        .then(function () {
          toast("已更新", "success");
          reloadProjectsAndUnfiled();
        })
        .catch(function (e) { toast("保存失败: " + e.message, "error"); });
    }
    okBtn.addEventListener("click", function (e) { e.stopPropagation(); commit(); });
    cancelBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      reloadProjectsAndUnfiled();
    });
    aInput.addEventListener("keydown", function (e) { if (e.key === "Enter") nInput.focus(); });
    nInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.stopPropagation(); commit(); }
      if (e.key === "Escape") { e.stopPropagation(); reloadProjectsAndUnfiled(); }
    });
  }

  function findSlideInfo(name) {
    for (var i = 0; i < allSlides.length; i++) {
      if (allSlides[i].name === name) return allSlides[i];
    }
    return null;
  }

  // ---------- 未归类切片 ----------
  function renderUnfiled() {
    var unfiled = allSlides.filter(function (s) { return !isSlideInAnyProject(s.name); });
    els.unfiledCount.textContent = String(unfiled.length);
    els.unfiledList.innerHTML = "";
    if (unfiled.length === 0) {
      var empty = document.createElement("div");
      empty.className = "unfiled-empty";
      empty.textContent = "无未归类切片";
      els.unfiledList.appendChild(empty);
      return;
    }
    unfiled.forEach(function (s) {
      els.unfiledList.appendChild(renderSlideRow(s.name, true));
    });
  }

  // ---------- 新建项目 ----------
  // 待加入新建项目的切片（来自未归类勾选）；表单确认时带上
  var pendingNewProjectSlides = null;

  function toggleNewProjectForm(show) {
    els.newProjectForm.style.display = show ? "block" : "none";
    if (show) { els.npName.value = ""; els.npNote.value = ""; els.npName.focus(); }
  }

  // slidesArg 为显式传入的切片（如顶部"新建项目"为空数组）；
  // 为空时回退到 pendingNewProjectSlides（未归类勾选预填）
  function createProjectFromForm(slidesArg) {
    var slides = (slidesArg && slidesArg.length) ? slidesArg : (pendingNewProjectSlides || []);
    var name = (els.npName.value || "").trim();
    if (!name) { toast("请输入项目名称", "error"); els.npName.focus(); return; }
    var note = els.npNote.value || "";
    apiFetch("/api/project/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name, note: note, slides: slides }),
    })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || "创建失败"); });
        return r.json();
      })
      .then(function () {
        toast("项目已创建", "success");
        toggleNewProjectForm(false);
        pendingNewProjectSlides = null;
        slideChecked = {};
        reloadProjectsAndUnfiled();
      })
      .catch(function (e) { toast("创建失败: " + e.message, "error"); });
  }

  // ---------- 编辑项目 ----------
  function editProject(p) {
    var name = prompt("项目名称", p.name || "");
    if (name == null) return;
    var note = prompt("备注", p.note || "");
    if (note == null) return;
    apiFetch("/api/project/" + encodeURIComponent(p.pid), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), note: note }),
    })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || "更新失败"); });
        return r.json();
      })
      .then(function () { toast("已更新", "success"); reloadProjectsAndUnfiled(); })
      .catch(function (e) { toast("更新失败: " + e.message, "error"); });
  }

  // ---------- 删除项目 ----------
  function deleteProject(p) {
    if (!confirm("确认删除项目「" + (p.name || "") + "」？（仅删除项目，不删除切片文件）")) return;
    apiFetch("/api/project/" + encodeURIComponent(p.pid), { method: "DELETE" })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || "删除失败"); });
        return r.json();
      })
      .then(function () { toast("项目已删除", "success"); reloadProjectsAndUnfiled(); })
      .catch(function (e) { toast("删除失败: " + e.message, "error"); });
  }

  // =========================================================================
  // 切片选择器（添加切片到项目）
  // =========================================================================
  function openSlidePicker(pid, pname) {
    pickerCtx.targetPid = pid;
    pickerCtx.selected = {};
    els.pickerTitleText.textContent = "添加切片到项目" + (pname ? "：" + pname : "");
    els.pickerList.innerHTML = "";
    allSlides.forEach(function (s) {
      var row = document.createElement("label");
      row.className = "picker-item";
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = s.name;
      cb.addEventListener("change", function () {
        pickerCtx.selected[s.name] = cb.checked;
        updatePickerCount();
      });
      row.appendChild(cb);
      var info = document.createElement("span");
      info.className = "pi-info";
      var nameHtml = s.alias
        ? '<span class="pi-alias">' + esc(s.alias) + "</span>" +
          '<span class="alias-filename">' + esc(truncateMiddle(s.name, 24)) + "</span>"
        : esc(truncateMiddle(s.name, 30));
      info.innerHTML = '<span class="pi-name">' + nameHtml + "</span>" +
        '<span class="pi-meta">' + slideMetaTags(s) + "</span>";
      row.appendChild(info);
      els.pickerList.appendChild(row);
    });
    updatePickerCount();
    els.pickerMask.style.display = "flex";
  }

  function updatePickerCount() {
    var n = 0;
    Object.keys(pickerCtx.selected).forEach(function (k) { if (pickerCtx.selected[k]) n++; });
    els.pickerSelectedCount.textContent = "已选 " + n;
  }

  function closeSlidePicker() {
    els.pickerMask.style.display = "none";
    pickerCtx.targetPid = null;
    pickerCtx.selected = {};
  }

  function confirmSlidePicker() {
    var slides = Object.keys(pickerCtx.selected).filter(function (k) { return pickerCtx.selected[k]; });
    if (slides.length === 0) { toast("请至少选择一张切片", "error"); return; }
    var pid = pickerCtx.targetPid;
    if (!pid) return;
    apiFetch("/api/project/" + encodeURIComponent(pid) + "/slides", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slides: slides }),
    })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || "添加失败"); });
        return r.json();
      })
      .then(function () {
        toast("已添加 " + slides.length + " 张切片", "success");
        closeSlidePicker();
        reloadProjectsAndUnfiled();
      })
      .catch(function (e) { toast("添加失败: " + e.message, "error"); });
  }

  // =========================================================================
  // 分享功能
  // =========================================================================
  function getExpiresHours() {
    var v = els.shareExpiresSelect.value;
    if (v === "custom") {
      var c = parseFloat(els.shareExpiresCustom.value);
      if (!isFinite(c) || c <= 0) return null;
      return c;
    }
    return parseFloat(v);
  }

  // 读取"标记尺寸"下拉值 → roi_sizes 数组（[6,6.5]/[6]/[6.5]）
  function getShareRoiSizes() {
    var v = els.shareRoiSizeSelect ? els.shareRoiSizeSelect.value : "both";
    if (v === "6") return [6];
    if (v === "6.5") return [6.5];
    return [6, 6.5];
  }

  // roi_sizes 数组 → 人类可读标签（用于分享列表 meta）
  function roiSizesLabel(sizes) {
    if (!sizes || !sizes.length) return "6/6.5mm";
    var set = {};
    sizes.forEach(function (s) { set[Number(s)] = true; });
    if (set[6] && set[6.5]) return "6/6.5mm";
    if (set[6.5]) return "仅 6.5mm";
    if (set[6]) return "仅 6mm";
    return "6/6.5mm";
  }

  // 统一创建分享入口：slides 为要分享的切片名数组
  function doCreateShare(slides) {
    if (!slides || slides.length === 0) { toast("请先选择要分享的切片", "error"); return; }
    var hours = getExpiresHours();
    if (hours == null) { toast("请输入有效的小时数", "error"); return; }
    var roiSizes = getShareRoiSizes();
    els.shareCreateBtn.disabled = true;
    els.shareCreateBtn.textContent = "生成中...";
    apiFetch("/api/share/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slides: slides, expires_hours: hours, roi_sizes: roiSizes }),
    })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || ("创建失败 " + r.status)); });
        return r.json();
      })
      .then(function (data) {
        els.shareResult.style.display = "flex";
        els.shareResultUrl.value = data.url;
        copyText(data.url);
        toast("分享链接已生成并复制", "success");
        sharePendingSlides = null;
        slideChecked = {};
        renderUnfiled();
        reloadShares();
      })
      .catch(function (e) { toast("创建失败: " + e.message, "error"); })
      .finally(function () {
        els.shareCreateBtn.disabled = false;
        els.shareCreateBtn.textContent = "分享选中切片";
      });
  }

  // 分享本项目
  function shareProject(p) {
    var slides = p.slides || [];
    if (slides.length === 0) { toast("该项目暂无切片", "error"); return; }
    sharePendingSlides = slides.slice();
    // 展开分享管理区，预填提示
    var shareSec = els.shareMgrBody.closest(".section");
    if (shareSec) shareSec.classList.remove("collapsed");
    els.shareCreateBtn.textContent = "分享项目「" + (p.name || "") + "」（" + slides.length + " 张）";
    toast("已选中项目 " + slides.length + " 张切片，选择时效后点击下方按钮生成链接", "info");
    els.shareResult.style.display = "none";
  }

  // 分享管理区按钮：若有 sharePendingSlides 则用它，否则用未归类勾选
  function onShareCreateClick() {
    var slides;
    if (sharePendingSlides) {
      slides = sharePendingSlides;
    } else {
      slides = Object.keys(slideChecked).filter(function (k) { return slideChecked[k]; });
    }
    doCreateShare(slides);
  }

  // 未归类"分享选中"
  function onUnfiledShare() {
    var slides = Object.keys(slideChecked).filter(function (k) { return slideChecked[k]; });
    if (slides.length === 0) { toast("请先勾选切片", "error"); return; }
    doCreateShare(slides);
  }

  function renderShareList(shares) {
    els.shareList.innerHTML = "";
    if (!shares || shares.length === 0) {
      var empty = document.createElement("div");
      empty.className = "share-empty";
      empty.textContent = "暂无分享";
      els.shareList.appendChild(empty);
      return;
    }
    shares.forEach(function (sh) {
      var row = document.createElement("div");
      row.className = "share-row-item";

      // 状态彩色圆点
      var dot = document.createElement("span");
      dot.className = "sr-status-dot " + sh.status;
      dot.title = sh.status === "active" ? "有效" :
                  (sh.status === "expired" ? "已过期" : "已撤销");
      row.appendChild(dot);

      // 中部：token（等宽） + 副行 meta
      var mid = document.createElement("div");
      mid.className = "sr-mid";
      var shortTok = sh.token.length > 8 ? sh.token.slice(0, 8) : sh.token;
      var tokEl = document.createElement("span");
      tokEl.className = "sr-token";
      tokEl.textContent = shortTok;
      tokEl.title = sh.url;
      mid.appendChild(tokEl);

      var meta = document.createElement("span");
      meta.className = "sr-meta";
      var slidesTxt = sh.slides.length + " 张：" + sh.slides.join(", ");
      meta.innerHTML =
        '<span title="' + esc(slidesTxt) + '">' + sh.slides.length + " 张</span>" +
        '<span class="sr-sep">·</span>' +
        "<span>到期 " + fmtExpire(sh.expires_at) + "</span>" +
        '<span class="sr-sep">·</span>' +
        "<span>选区 " + (sh.roi_count || 0) + "</span>" +
        '<span class="sr-sep">·</span>' +
        "<span>" + esc(roiSizesLabel(sh.roi_sizes)) + "</span>";
      mid.appendChild(meta);
      row.appendChild(mid);

      // 操作按钮（hover 浮现）
      var ops = document.createElement("div");
      ops.className = "sr-ops";
      var copyBtn = document.createElement("button");
      copyBtn.className = "sr-btn sr-copy";
      copyBtn.textContent = "⧉";
      copyBtn.title = "复制链接";
      copyBtn.addEventListener("click", function () { copyText(sh.url); });
      ops.appendChild(copyBtn);
      var revBtn = document.createElement("button");
      revBtn.className = "sr-btn sr-revoke";
      revBtn.textContent = "⊘";
      revBtn.title = "撤销";
      revBtn.addEventListener("click", function () { revokeShare(sh.token); });
      if (sh.status !== "active") revBtn.disabled = true;
      ops.appendChild(revBtn);
      row.appendChild(ops);
      els.shareList.appendChild(row);
    });
  }

  function revokeShare(token) {
    if (!confirm("确认撤销该分享？撤销后链接立即失效。")) return;
    apiFetch("/api/share/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token }),
    })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || ("撤销失败 " + r.status)); });
        return r.json();
      })
      .then(function () { toast("已撤销", "success"); reloadShares(); })
      .catch(function (e) { toast("撤销失败: " + e.message, "error"); });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(function () { toast("已复制到剪贴板", "success"); })
        .catch(function () { fallbackCopy(text); });
    } else { fallbackCopy(text); }
  }
  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast("已复制到剪贴板", "success"); }
    catch (e) { toast("复制失败，请手动复制", "error"); }
    document.body.removeChild(ta);
  }
  function fmtExpire(ts) {
    if (!ts) return "-";
    var d = new Date(ts * 1000);
    var p = function (n) { return n < 10 ? "0" + n : n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  // =========================================================================
  // 手机端侧栏抽屉
  // =========================================================================
  // 仅手机端（≤768px）启用抽屉行为；桌面端 sidebar 始终静态可见，
  // open/close 在桌面下也是 no-op（CSS 不生效，DOM class 无副作用）。
  function isMobileWidth() {
    return window.matchMedia && window.matchMedia("(max-width: 768px)").matches;
  }
  function openSidebarDrawer() {
    if (!els.sidebar || !els.sidebarMask) return;
    els.sidebar.classList.add("open");
    els.sidebarMask.classList.add("open");
  }
  function closeSidebarDrawer() {
    if (!els.sidebar || !els.sidebarMask) return;
    els.sidebar.classList.remove("open");
    els.sidebarMask.classList.remove("open");
  }
  function toggleSidebarDrawer() {
    if (!els.sidebar) return;
    if (els.sidebar.classList.contains("open")) { closeSidebarDrawer(); }
    else { openSidebarDrawer(); }
  }

  // ---------- 移动端上下文动作条显隐 ----------
  // ROI 模式或箭头/描图绘制模式任一激活时，显示底部主栏上方的上下文条
  // （标注人输入 + 保存标记/保存图片）。桌面端不受影响（display:contents）。
  function updateCtxBar() {
    var on = state.roiMode != null || state.drawMode != null;
    document.body.classList.toggle("ctx-on", on);
  }

  // ---------- 移动端 ⋯ 溢出面板（装 AI 读片 + 缩放徽章，避免挤爆底栏） ----------
  function bindTbbMore() {
    if (!els.tbbMoreBtn || !els.tbbMore) return;
    var mask = $("tbb-more-mask");
    function closeMore() {
      els.tbbMore.classList.remove("open");
      if (mask) mask.classList.remove("open");
    }
    function openMore() {
      els.tbbMore.classList.add("open");
      if (mask) mask.classList.add("open");
    }
    els.tbbMoreBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (els.tbbMore.classList.contains("open")) { closeMore(); } else { openMore(); }
    });
    if (mask) mask.addEventListener("click", closeMore);
    // ⋯ 面板里的 AI 钮：转发给主 AI 钮（打开/关闭 AI 面板），并关闭 ⋯
    if (els.tbbMoreAi) {
      els.tbbMoreAi.addEventListener("click", function () {
        closeMore();
        if (els.aiBtn && !els.aiBtn.disabled) els.aiBtn.click();
      });
    }
  }

  // =========================================================================
  // 标注画布层（rect/arrow/freehand 统一绘制）
  // =========================================================================
  var annoCtx = null;

  function resizeAnnoCanvas() {
    var c = els.annoCanvas;
    if (!c || !viewer) return;
    var rect = viewer.container.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, Math.floor(rect.width * dpr));
    c.height = Math.max(1, Math.floor(rect.height * dpr));
    c.style.width = rect.width + "px";
    c.style.height = rect.height + "px";
    annoCtx = c.getContext("2d");
    annoCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // 把图像坐标转为画布层屏幕坐标（自带旋转支持）
  function imgToCanvas(ix, iy) {
    if (!viewer || !viewer.viewport) return { x: 0, y: 0 };
    var p = viewer.viewport.imageToViewerElementCoordinates(
      new OpenSeadragon.Point(ix, iy));
    return { x: p.x, y: p.y };
  }

  // 当前切片的标注展开为扁平 item 列表（带 label/type/几何）
  // flatItems 为持久缓存（编辑拖动时改本地几何），每次标注刷新时重建
  var flatItems = [];
  function flatAnnoItems() {
    return flatItems;
  }
  function rebuildFlatItems() {
    var out = [];
    if (currentAnnotations) {
      (currentAnnotations.annotations || []).forEach(function (grp) {
        (grp.items || []).forEach(function (it) {
          var copy = {};
          for (var k in it) copy[k] = it[k];
          copy.label = grp.label;
          out.push(copy);
        });
      });
    }
    flatItems = out;
  }

  function redrawAnnoCanvas() {
    var c = els.annoCanvas;
    if (!c || !annoCtx) { if (c) resizeAnnoCanvas(); }
    if (!annoCtx) return;
    var rect = viewer ? viewer.container.getBoundingClientRect() : { width: c.clientWidth, height: c.clientHeight };
    annoCtx.clearRect(0, 0, rect.width, rect.height);
    // AI overlay（青色虚线框）独立于 showAnno：agent 进行中/完成后始终画
    var hasAiOverlay = aiOverlay && aiOverlay.length > 0;
    if (!state.showAnno && state.drawMode == null && !hasAiOverlay) return;
    if (!state.slide) return;
    // 性能：缩放/平移动画期间省略文本（标签/气泡）只画矢量，
    // 动画结束（animation-finish）再补全，避免每帧逐条 measureText/fillText
    var animating = !!(viewer && viewer.viewport &&
      typeof viewer.viewport.isAnimating === "function" && viewer.viewport.isAnimating());
    // 拖动编辑中只保留选中项的气泡，其余气泡暂停（视图静止时减少文本重绘）
    var dragging = !!(editDrag && editItem);
    // 已保存标注（focus 过滤：有 focusAnno 时只画它）
    if (state.showAnno) {
      flatAnnoItems().forEach(function (it) {
        if (state.focusAnno && it !== state.focusAnno) return;
        var selected = (editItem === it);
        drawAnnoItem(it, labelColor(it.label), selected, !animating);
      });
    }
    // AI overlay（agent 的 goto/snapshot bbox）：青色虚线框 + 半透明填充，区别于人工标注
    if (hasAiOverlay) {
      aiOverlay.forEach(function (bb) {
        var tl = imgToCanvas(bb.x, bb.y);
        var br = imgToCanvas(bb.x + bb.w, bb.y + bb.h);
        var x = Math.min(tl.x, br.x), y = Math.min(tl.y, br.y);
        var w = Math.abs(br.x - tl.x), h = Math.abs(br.y - tl.y);
        annoCtx.save();
        // 半透明青色填充：判读区更醒目（#3），颜色/透明度集中在此常量调
        annoCtx.fillStyle = AI_OVERLAY_FILL;
        annoCtx.fillRect(x, y, w, h);
        annoCtx.lineWidth = 2;
        annoCtx.strokeStyle = AI_OVERLAY_STROKE;
        annoCtx.setLineDash([6, 4]);
        annoCtx.strokeRect(x, y, w, h);
        annoCtx.setLineDash([]);
        if (!animating && bb.magnification) {
          annoCtx.fillStyle = "rgba(0,229,255,0.9)";
          annoCtx.font = "12px -apple-system, sans-serif";
          annoCtx.fillText("AI · " + fmtAiMag(bb.magnification), x + 4, y + 14);
        }
        annoCtx.restore();
      });
    }
    // 编辑手柄（仅显式编辑态才画，纯选中不画，防误挪位置）
    if (editItem && editing && state.showAnno) {
      drawEditHandles(editItem);
    }
    // 绘制中的预览
    if (state.drawMode === "arrow" && drawPreview && drawPreview.type === "arrow") {
      drawArrow(drawPreview.x1, drawPreview.y1, drawPreview.x2, drawPreview.y2, "#FFD700", "预览");
    }
    if (state.drawMode === "freehand" && drawPreview && drawPreview.type === "freehand" && drawPreview.points.length >= 2) {
      drawFreehand(drawPreview.points, { fill: "rgba(255,215,0,0.12)", stroke: "#FFD700" }, "预览");
    }
    // 备注气泡（在标注与手柄之上；动画/拖动期间按需精简；focus 过滤同步）
    if (state.showAnno && !animating) {
      flatAnnoItems().forEach(function (it) {
        if (state.focusAnno && it !== state.focusAnno) return; // focus 模式只显示该条气泡
        if (dragging && it !== editItem) return; // 拖动中只画选中项气泡
        var note = String(it.note || "");
        if (!note) return;
        var selected = (editItem === it);
        drawNoteBubble(it, note, selected);
      });
    }
  }

  // 绘制编辑手柄（管理端所有标注可编辑）
  function drawEditHandles(it) {
    var hs = editHandles(it);
    annoCtx.fillStyle = "#fff";
    annoCtx.strokeStyle = "#007AFF";
    annoCtx.lineWidth = 2;
    hs.forEach(function (h) {
      var isMid = (h.id === "mid" || h.id === "fmid" || h.id === "move");
      if (isMid) {
        annoCtx.beginPath();
        annoCtx.arc(h.x, h.y, 6, 0, Math.PI * 2);
        annoCtx.fill(); annoCtx.stroke();
      } else {
        annoCtx.fillRect(h.x - 5, h.y - 5, 10, 10);
        annoCtx.strokeRect(h.x - 5, h.y - 5, 10, 10);
      }
    });
  }

  function drawAnnoItem(it, color, selected, showText) {
    var typ = it.type || "rect";
    var hlStroke = selected ? "#007AFF" : null;
    var lbl = showText ? it.label : null;
    // AI 落标（进标注库 source=ai）给半透明青色填充，区别于人工标注（#3）
    var isAi = (it.source === "ai");
    if (typ === "rect") {
      var tl = imgToCanvas(it.x, it.y);
      var br = imgToCanvas(it.x + it.side_px, it.y + it.side_px);
      var w = Math.abs(br.x - tl.x), h = Math.abs(br.y - tl.y);
      var x = Math.min(tl.x, br.x), y = Math.min(tl.y, br.y);
      // 半透明填充：AI 标注青色（更醒目），人工标注用 label 哈希淡色
      annoCtx.fillStyle = isAi ? AI_ANNO_FILL : (color.fill || "rgba(0,0,0,0)");
      annoCtx.fillRect(x, y, w, h);
      if (hlStroke) {
        annoCtx.lineWidth = 6;
        annoCtx.strokeStyle = hlStroke;
        annoCtx.strokeRect(x, y, w, h);
      }
      annoCtx.lineWidth = 3;
      annoCtx.strokeStyle = "#FFD700";
      annoCtx.strokeRect(x, y, w, h);
      // 角点
      annoCtx.fillStyle = "#FFD700";
      [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].forEach(function (p) {
        annoCtx.beginPath(); annoCtx.arc(p[0], p[1], 3, 0, Math.PI * 2); annoCtx.fill();
      });
      if (lbl) drawLabel(it.label, x, y, it.size_mm != null ? (it.size_mm + "mm") : "");
    } else if (typ === "arrow") {
      drawArrow(it.x1, it.y1, it.x2, it.y2, hlStroke || color.stroke, lbl);
    } else if (typ === "freehand") {
      drawFreehand(it.points, { fill: color.fill, stroke: hlStroke || color.stroke }, lbl);
    }
  }

  function drawArrow(x1, y1, x2, y2, stroke, label) {
    var a = imgToCanvas(x1, y1), b = imgToCanvas(x2, y2);
    annoCtx.lineWidth = 3;
    annoCtx.strokeStyle = stroke;
    annoCtx.fillStyle = stroke;
    annoCtx.beginPath();
    annoCtx.moveTo(a.x, a.y);
    annoCtx.lineTo(b.x, b.y);
    annoCtx.stroke();
    // 箭头三角头部（根据两端点屏幕坐标算角度）
    var ang = Math.atan2(b.y - a.y, b.x - a.x);
    var head = 12;
    annoCtx.beginPath();
    annoCtx.moveTo(b.x, b.y);
    annoCtx.lineTo(b.x - head * Math.cos(ang - Math.PI / 6), b.y - head * Math.sin(ang - Math.PI / 6));
    annoCtx.lineTo(b.x - head * Math.cos(ang + Math.PI / 6), b.y - head * Math.sin(ang + Math.PI / 6));
    annoCtx.closePath();
    annoCtx.fill();
    if (label) drawLabel(label, b.x + 6, b.y - 6, "", stroke);
  }

  function drawFreehand(points, color, label) {
    if (!points || points.length < 2) return;
    annoCtx.lineWidth = 3;
    annoCtx.strokeStyle = color.stroke;
    annoCtx.fillStyle = color.fill || "rgba(0,0,0,0.12)";
    annoCtx.beginPath();
    var p0 = imgToCanvas(points[0][0], points[0][1]);
    annoCtx.moveTo(p0.x, p0.y);
    for (var i = 1; i < points.length; i++) {
      var p = imgToCanvas(points[i][0], points[i][1]);
      annoCtx.lineTo(p.x, p.y);
    }
    annoCtx.closePath();
    annoCtx.fill();
    annoCtx.stroke();
    if (label) drawLabel(label, p0.x, p0.y, "", color.stroke);
  }

  // 标签文字：黄底深字（与现有 ROI 标签风格一致）
  function drawLabel(label, x, y, sizeText, strokeColor) {
    var text = String(label || "");
    if (sizeText) text = (text ? text + " · " : "") + sizeText;
    if (!text) return;
    annoCtx.font = "600 11px " + "-apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif";
    var padX = 5, padY = 3;
    var m = annoCtx.measureText(text);
    var w = m.width + padX * 2;
    var h = 16;
    var bx = x, by = y - h - 2;
    if (strokeColor && strokeColor !== "#FFD700") {
      annoCtx.fillStyle = strokeColor;
    } else {
      annoCtx.fillStyle = "#FFD700";
    }
    annoCtx.fillRect(bx, by, w, h);
    annoCtx.fillStyle = (strokeColor && strokeColor !== "#FFD700") ? "#fff" : "#5a3500";
    annoCtx.textBaseline = "middle";
    annoCtx.fillText(text, bx + padX, by + h / 2 + 0.5);
  }

  // ---------- 备注气泡（macOS callout 风格，与 share.js 一致） ----------
  var BUBBLE_FONT = "12px " + "-apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif";
  // 布局缓存：note 文本 → {lines, boxW, boxH}（font/maxWidth 固定，布局与视图无关，
  // 避免每帧逐字符 measureText——标注多时这是动画卡顿的主因）
  var _bubbleLayoutCache = {};
  function bubbleLayout(note) {
    var hit = _bubbleLayoutCache[note];
    if (hit) return hit;
    annoCtx.font = BUBBLE_FONT;
    var maxWidth = 240;
    var lines = wrapText(note, maxWidth);
    var padX = 8, padY = 6, lineH = 15;
    var textW = 0;
    lines.forEach(function (ln) {
      var w = annoCtx.measureText(ln).width;
      if (w > textW) textW = w;
    });
    var out = {
      lines: lines,
      boxW: Math.min(maxWidth, Math.max(20, textW)) + padX * 2,
      boxH: lines.length * lineH + padY * 2,
    };
    if (Object.keys(_bubbleLayoutCache).length > 300) _bubbleLayoutCache = {};
    _bubbleLayoutCache[note] = out;
    return out;
  }

  function wrapText(text, maxWidth) {
    annoCtx.font = BUBBLE_FONT;
    var lines = [];
    String(text).split("\n").forEach(function (para) {
      if (para === "") { lines.push(""); return; }
      var cur = "";
      for (var i = 0; i < para.length; i++) {
        var test = cur + para[i];
        if (annoCtx.measureText(test).width > maxWidth && cur) {
          lines.push(cur);
          cur = para[i];
        } else {
          cur = test;
        }
      }
      if (cur) lines.push(cur);
    });
    return lines;
  }

  function annoAnchor(it) {
    var typ = it.type || "rect";
    if (typ === "rect") {
      var tl = imgToCanvas(it.x, it.y);
      var br = imgToCanvas(it.x + it.side_px, it.y + it.side_px);
      var x = Math.min(tl.x, br.x), y = Math.min(tl.y, br.y);
      var w = Math.abs(br.x - tl.x), h = Math.abs(br.y - tl.y);
      return { x: x + w / 2, y: y, minSide: Math.min(w, h) };
    } else if (typ === "arrow") {
      var a = imgToCanvas(it.x1, it.y1), b = imgToCanvas(it.x2, it.y2);
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, minSide: 40 };
    } else if (typ === "freehand") {
      var pts = (it.points || []).map(function (p) { return imgToCanvas(p[0], p[1]); });
      var xs = pts.map(function (p) { return p.x; });
      var ys = pts.map(function (p) { return p.y; });
      var minx = Math.min.apply(null, xs), maxx = Math.max.apply(null, xs);
      var miny = Math.min.apply(null, ys), maxy = Math.max.apply(null, ys);
      return { x: (minx + maxx) / 2, y: miny, minSide: Math.min(maxx - minx, maxy - miny) };
    }
    return { x: 0, y: 0, minSide: 0 };
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawNoteBubble(it, note, selected) {
    var anchor = annoAnchor(it);
    if (anchor.minSide < 24) return;
    var c = els.annoCanvas;
    var canvasW = c.clientWidth, canvasH = c.clientHeight;

    // 布局走缓存（避免每帧逐字符 measureText）
    var layout = bubbleLayout(note);
    var lines = layout.lines;
    var boxW = layout.boxW, boxH = layout.boxH;
    var padX = 8, padY = 6, lineH = 15;

    var cx = anchor.x;
    var above = true;
    var boxX = cx - boxW / 2;
    var boxY = anchor.y - 8 - boxH;

    if (boxY < 4) { above = false; boxY = anchor.y + 10; }
    if (boxX < 4) boxX = 4;
    if (boxX + boxW > canvasW - 4) boxX = canvasW - 4 - boxW;
    if (boxY + boxH > canvasH - 4) boxY = Math.max(4, canvasH - 4 - boxH);

    var borderColor = selected ? "#007AFF" : "rgba(0,0,0,0.15)";
    var triSize = 6;
    var triTipX = cx;
    annoCtx.save();
    annoCtx.globalAlpha = 0.85;
    annoCtx.fillStyle = "#ffffff";
    roundRect(annoCtx, boxX, boxY, boxW, boxH, 8);
    annoCtx.fill();
    annoCtx.globalAlpha = 1;
    annoCtx.strokeStyle = borderColor;
    annoCtx.lineWidth = 1;
    annoCtx.stroke();
    annoCtx.restore();

    annoCtx.save();
    annoCtx.fillStyle = "#ffffff";
    annoCtx.strokeStyle = borderColor;
    annoCtx.lineWidth = 1;
    annoCtx.beginPath();
    if (above) {
      var baseY = boxY + boxH;
      annoCtx.moveTo(triTipX - triSize, baseY - 0.5);
      annoCtx.lineTo(triTipX, baseY + triSize);
      annoCtx.lineTo(triTipX + triSize, baseY - 0.5);
    } else {
      var baseY2 = boxY;
      annoCtx.moveTo(triTipX - triSize, baseY2 + 0.5);
      annoCtx.lineTo(triTipX, baseY2 - triSize);
      annoCtx.lineTo(triTipX + triSize, baseY2 + 0.5);
    }
    annoCtx.closePath();
    annoCtx.fill();
    annoCtx.stroke();
    annoCtx.restore();

    annoCtx.fillStyle = "#333";
    annoCtx.font = "12px " + "-apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif";
    annoCtx.textBaseline = "top";
    lines.forEach(function (ln, i) {
      annoCtx.fillText(ln, boxX + padX, boxY + padY + i * lineH);
    });
  }

  // =========================================================================
  // 编辑模式：非绘制模式下点击标注画布层，命中检测 + 选中 + 拖动手柄
  // （管理端所有标注可编辑）
  // =========================================================================
  function pointSegDist(px, py, x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1;
    var len2 = dx * dx + dy * dy;
    if (len2 <= 0) return Math.hypot(px - x1, py - y1);
    var t = ((px - x1) * dx + (py - y1) * dy) / len2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  function pointInPolygon(px, py, pts) {
    var inside = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
      var intersect = ((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / ((yj - yi) || 1e-9) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function hitAnno(sx, sy) {
    var items = flatAnnoItems();
    for (var i = items.length - 1; i >= 0; i--) {
      var it = items[i];
      var typ = it.type || "rect";
      if (typ === "rect") {
        var tl = imgToCanvas(it.x, it.y);
        var br = imgToCanvas(it.x + it.side_px, it.y + it.side_px);
        var x = Math.min(tl.x, br.x), y = Math.min(tl.y, br.y);
        var w = Math.abs(br.x - tl.x), h = Math.abs(br.y - tl.y);
        if (sx >= x - 6 && sx <= x + w + 6 && sy >= y - 6 && sy <= y + h + 6) return it;
      } else if (typ === "arrow") {
        var a = imgToCanvas(it.x1, it.y1), b = imgToCanvas(it.x2, it.y2);
        if (pointSegDist(sx, sy, a.x, a.y, b.x, b.y) <= 8) return it;
      } else if (typ === "freehand") {
        var pts = (it.points || []).map(function (p) { return imgToCanvas(p[0], p[1]); });
        if (pts.length >= 3 && pointInPolygon(sx, sy, pts)) return it;
        for (var k = 0; k < pts.length - 1; k++) {
          if (pointSegDist(sx, sy, pts[k].x, pts[k].y, pts[k + 1].x, pts[k + 1].y) <= 8) return it;
        }
      }
    }
    return null;
  }

  function editHandles(it) {
    var typ = it.type || "rect";
    var out = [];
    if (typ === "rect") {
      var tl = imgToCanvas(it.x, it.y);
      var br = imgToCanvas(it.x + it.side_px, it.y + it.side_px);
      var x = Math.min(tl.x, br.x), y = Math.min(tl.y, br.y);
      var w = Math.abs(br.x - tl.x), h = Math.abs(br.y - tl.y);
      out = [
        { id: "tl", x: x, y: y }, { id: "t", x: x + w / 2, y: y },
        { id: "tr", x: x + w, y: y }, { id: "r", x: x + w, y: y + h / 2 },
        { id: "br", x: x + w, y: y + h }, { id: "b", x: x + w / 2, y: y + h },
        { id: "bl", x: x, y: y + h }, { id: "l", x: x, y: y + h / 2 },
      ];
    } else if (typ === "arrow") {
      var a = imgToCanvas(it.x1, it.y1), b = imgToCanvas(it.x2, it.y2);
      out = [
        { id: "p1", x: a.x, y: a.y }, { id: "p2", x: b.x, y: b.y },
        { id: "mid", x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      ];
    } else if (typ === "freehand") {
      var xs = it.points.map(function (p) { return p[0]; });
      var ys = it.points.map(function (p) { return p[1]; });
      var minx = Math.min.apply(null, xs), miny = Math.min.apply(null, ys);
      var maxx = Math.max.apply(null, xs), maxy = Math.max.apply(null, ys);
      var tl2 = imgToCanvas(minx, miny), br2 = imgToCanvas(maxx, maxy);
      var x2 = Math.min(tl2.x, br2.x), y2 = Math.min(tl2.y, br2.y);
      var w2 = Math.abs(br2.x - tl2.x), h2 = Math.abs(br2.y - tl2.y);
      out = [
        { id: "ftl", x: x2, y: y2 }, { id: "ftr", x: x2 + w2, y: y2 },
        { id: "fbr", x: x2 + w2, y: y2 + h2 }, { id: "fbl", x: x2, y: y2 + h2 },
        { id: "fmid", x: x2 + w2 / 2, y: y2 + h2 / 2 },
      ];
    }
    return out;
  }

  function hitHandle(sx, sy, it) {
    var hs = editHandles(it);
    for (var i = 0; i < hs.length; i++) {
      if (Math.hypot(sx - hs[i].x, sy - hs[i].y) <= 8) return hs[i].id;
    }
    return null;
  }

  function selectEditItem(it) {
    editItem = it;
    state.focusAnno = it; // 选中某条 → 只显示它（focus 可见性）
    editing = false;  // 选中只是查看，不进入可拖动编辑态
    redrawAnnoCanvas();
    openEditCard(it);
  }

  function clearEditItem() {
    editItem = null;
    state.focusAnno = null; // 取消选中 → 恢复显示全部
    editing = false;
    closeEditCard();
    redrawAnnoCanvas();
  }

  // ---------- 显示全部标记（切换画布层显隐） ----------
  // 同步所有相关按钮的 active 态：旧 #anno-all-btn + 新面板头部 #anno-all-toggle
  function syncAnnoAllBtns() {
    if (els.annoAllBtn) els.annoAllBtn.classList.toggle("active", state.showAnno);
    if (els.annoAllToggle) {
      els.annoAllToggle.classList.toggle("active", state.showAnno);
      els.annoAllToggle.setAttribute("aria-pressed", state.showAnno ? "true" : "false");
    }
  }
  function toggleAnnoAll() {
    // 👁 =「显示全部标记」语义：若当前处于"只看选中那条"的 focus 状态，
    // 先清空 focus 恢复显示全部；否则在「显示全部 ↔ 全部隐藏」之间切换。
    // （画布层非绘制时 pointer-events:none，无法点空白取消 focus，故由该钮兜底。）
    if (state.focusAnno) {
      state.focusAnno = null;
      state.showAnno = true;
    } else {
      state.showAnno = !state.showAnno;
    }
    syncAnnoAllBtns();
    redrawAnnoCanvas();
  }
  // 旧函数别名（兼容）
  function clearAnnoOverlays() { annoOverlays = []; redrawAnnoCanvas(); }
  function refreshAnnoOverlays() { redrawAnnoCanvas(); }

  // =========================================================================
  // 标注绘制工具（arrow / freehand）
  // =========================================================================
  var drawPreview = null;     // {type, ...}
  var drawPointer = null;     // 当前指针捕获信息

  function enterDrawMode(mode) {
    if (!state.slide) { toast("请先打开一个切片", "error"); return; }
    exitRoi();
    state.drawMode = mode;
    els.annoArrowBtn.classList.toggle("active", mode === "arrow");
    els.annoFreeBtn.classList.toggle("active", mode === "freehand");
    var c = els.annoCanvas;
    c.classList.add("drawing");
    if (viewer) viewer.setMouseNavEnabled(false);
    state.showAnno = true;
    syncAnnoAllBtns();
    redrawAnnoCanvas();
    updateCtxBar();
    toast(mode === "arrow" ? "箭头模式：拖动绘制" : "描图模式：沿边缘描绘", "info");
  }

  function exitDrawMode() {
    state.drawMode = null;
    drawPreview = null;
    drawPointer = null;
    els.annoArrowBtn.classList.remove("active");
    els.annoFreeBtn.classList.remove("active");
    if (els.annoCanvas) els.annoCanvas.classList.remove("drawing");
    if (viewer) viewer.setMouseNavEnabled(true);
    redrawAnnoCanvas();
    updateCtxBar();
  }

  function toggleDrawMode(mode) {
    if (state.drawMode === mode) { exitDrawMode(); return; }
    enterDrawMode(mode);
  }

  function onAnnoPointerDown(e) {
    if (!state.slide) return;
    // 绘制模式优先
    if (state.drawMode) {
      e.preventDefault(); e.stopPropagation();
      var c = els.annoCanvas;
      try { c.setPointerCapture(e.pointerId); } catch (err) {}
      drawPointer = { id: e.pointerId };
      var img0 = screenToImg(e);
      if (state.drawMode === "arrow") {
        drawPreview = { type: "arrow", x1: img0.x, y1: img0.y, x2: img0.x, y2: img0.y };
      } else {
        drawPreview = { type: "freehand", points: [[img0.x, img0.y]], lastScreen: screenPt(e) };
      }
      redrawAnnoCanvas();
      return;
    }
    // 非绘制模式：编辑/选中
    if (!state.showAnno) return;
    e.preventDefault(); e.stopPropagation();
    var sp = screenPt(e);
    // 显式编辑态且点中手柄 → 拖动手柄（平移/缩放必须先进入编辑态）
    if (editItem && editing) {
      var handleId = hitHandle(sp.x, sp.y, editItem);
      if (handleId) {
        startEditDrag(e, editItem, handleId);
        return;
      }
    }
    // 命中标注 → 重新选中查看（editing 复位，不直接平移；要改需先点"✎ 编辑"）
    var hit = hitAnno(sp.x, sp.y);
    if (hit) {
      selectEditItem(hit);
      return;
    }
    // 点空白 → 取消选中
    clearEditItem();
  }

  function onAnnoPointerMove(e) {
    if (state.drawMode && drawPreview) {
      e.preventDefault(); e.stopPropagation();
      var img = screenToImg(e);
      if (drawPreview.type === "arrow") {
        drawPreview.x2 = img.x; drawPreview.y2 = img.y;
      } else {
        var sp0 = screenPt(e);
        var last = drawPreview.lastScreen;
        if (Math.hypot(sp0.x - last.x, sp0.y - last.y) > 4) {
          drawPreview.points.push([img.x, img.y]);
          drawPreview.lastScreen = sp0;
          if (drawPreview.points.length >= 500) { finishDraw(); return; }
        }
      }
      redrawAnnoCanvas();
      return;
    }
    if (!editDrag) return;
    e.preventDefault(); e.stopPropagation();
    applyEditDrag(e);
  }

  function onAnnoPointerUp(e) {
    if (state.drawMode && drawPreview) {
      e.preventDefault(); e.stopPropagation();
      finishDraw();
      return;
    }
    if (!editDrag) return;
    e.preventDefault(); e.stopPropagation();
    endEditDrag(e);
  }

  // ---------- 编辑拖动会话（与 share.js 同构） ----------
  function startEditDrag(e, it, handleId) {
    var c = els.annoCanvas;
    try { c.setPointerCapture(e.pointerId); } catch (err) {}
    editDrag = {
      pointerId: e.pointerId,
      handle: handleId,
      item: it,
      start: snapshotGeom(it),
      startImg: screenToImg(e),
    };
    if (viewer) viewer.setMouseNavEnabled(false);
  }

  function snapshotGeom(it) {
    var typ = it.type || "rect";
    if (typ === "rect") return { x: it.x, y: it.y, side_px: it.side_px };
    if (typ === "arrow") return { x1: it.x1, y1: it.y1, x2: it.x2, y2: it.y2 };
    if (typ === "freehand") return { points: (it.points || []).map(function (p) { return [p[0], p[1]]; }) };
    return {};
  }

  function applyEditDrag(e) {
    var d = editDrag;
    var it = d.item;
    var typ = it.type || "rect";
    var cur = screenToImg(e);
    var dx = cur.x - d.startImg.x;
    var dy = cur.y - d.startImg.y;
    var s = d.start;

    if (typ === "rect") {
      if (d.handle === "move") {
        it.x = Math.max(0, Math.round(s.x + dx));
        it.y = Math.max(0, Math.round(s.y + dy));
      } else {
        var anchorX;
        if (d.handle === "tl" || d.handle === "bl" || d.handle === "l") anchorX = s.x + s.side_px;
        else if (d.handle === "tr" || d.handle === "br" || d.handle === "r") anchorX = s.x;
        else anchorX = s.x + s.side_px / 2;
        var anchorY;
        if (d.handle === "tl" || d.handle === "t" || d.handle === "tr") anchorY = s.y + s.side_px;
        else if (d.handle === "bl" || d.handle === "b" || d.handle === "br") anchorY = s.y;
        else anchorY = s.y + s.side_px / 2;
        var spanX = Math.abs(cur.x - anchorX);
        var spanY = Math.abs(cur.y - anchorY);
        var side = clamp(Math.round(Math.max(spanX, spanY)), 1, 40000);
        var nx = (cur.x <= anchorX) ? (anchorX - side) : anchorX;
        var ny = (cur.y <= anchorY) ? (anchorY - side) : anchorY;
        if (d.handle === "t" || d.handle === "b") nx = s.x + s.side_px / 2 - side / 2;
        if (d.handle === "l" || d.handle === "r") ny = s.y + s.side_px / 2 - side / 2;
        it.side_px = side;
        it.x = Math.max(0, Math.round(nx));
        it.y = Math.max(0, Math.round(ny));
      }
    } else if (typ === "arrow") {
      if (d.handle === "p1") {
        it.x1 = Math.max(0, Math.round(s.x1 + dx));
        it.y1 = Math.max(0, Math.round(s.y1 + dy));
      } else if (d.handle === "p2") {
        it.x2 = Math.max(0, Math.round(s.x2 + dx));
        it.y2 = Math.max(0, Math.round(s.y2 + dy));
      } else if (d.handle === "mid") {
        it.x1 = Math.max(0, Math.round(s.x1 + dx));
        it.y1 = Math.max(0, Math.round(s.y1 + dy));
        it.x2 = Math.max(0, Math.round(s.x2 + dx));
        it.y2 = Math.max(0, Math.round(s.y2 + dy));
      }
    } else if (typ === "freehand") {
      if (d.handle === "fmid") {
        it.points = s.points.map(function (p) {
          return [Math.max(0, Math.round(p[0] + dx)), Math.max(0, Math.round(p[1] + dy))];
        });
      } else {
        var pts = s.points;
        var xs0 = pts.map(function (p) { return p[0]; });
        var ys0 = pts.map(function (p) { return p[1]; });
        var minx0 = Math.min.apply(null, xs0), maxx0 = Math.max.apply(null, xs0);
        var miny0 = Math.min.apply(null, ys0), maxy0 = Math.max.apply(null, ys0);
        var w0 = Math.max(1, maxx0 - minx0), h0 = Math.max(1, maxy0 - miny0);
        var aX = (d.handle === "ftl") ? maxx0 : minx0;
        var aY = (d.handle === "ftl") ? maxy0 : miny0;
        if (d.handle === "ftr") { aX = minx0; aY = maxy0; }
        if (d.handle === "fbr") { aX = minx0; aY = miny0; }
        if (d.handle === "fbl") { aX = maxx0; aY = miny0; }
        var newW = Math.max(2, Math.abs(cur.x - aX));
        var newH = Math.max(2, Math.abs(cur.y - aY));
        var scale = Math.max(newW / w0, newH / h0);
        var newPts = pts.map(function (p) {
          return [Math.round(aX + (p[0] - aX) * scale), Math.round(aY + (p[1] - aY) * scale)];
        });
        var nminx = Math.min.apply(null, newPts.map(function (p) { return p[0]; }));
        var nminy = Math.min.apply(null, newPts.map(function (p) { return p[1]; }));
        var offX = nminx < 0 ? -nminx : 0;
        var offY = nminy < 0 ? -nminy : 0;
        it.points = newPts.map(function (p) { return [p[0] + offX, p[1] + offY]; });
      }
    }
    redrawAnnoCanvas();
  }

  function endEditDrag(e) {
    var c = els.annoCanvas;
    if (editDrag) {
      try { c.releasePointerCapture(editDrag.pointerId); } catch (err) {}
    }
    editDrag = null;
    if (viewer) viewer.setMouseNavEnabled(true);
  }

  function finishDraw() {
    var dp = drawPreview;
    var c = els.annoCanvas;
    if (drawPointer) { try { c.releasePointerCapture(drawPointer.id); } catch (err) {} }
    drawPointer = null;
    drawPreview = null;
    if (!dp) { exitDrawMode(); return; }
    if (dp.type === "arrow") {
      var dist = Math.hypot(dp.x2 - dp.x1, dp.y2 - dp.y1);
      if (dist < 10) { toast("距离过短，已取消", "info"); exitDrawMode(); return; }
      saveAnnotation({ type: "arrow", x1: dp.x1, y1: dp.y1, x2: dp.x2, y2: dp.y2 });
    } else {
      var pts = dp.points;
      if (pts.length < 3) { toast("描图点太少，已取消", "info"); exitDrawMode(); return; }
      // 包围盒 > 10px
      var xs = pts.map(function (p) { return p[0]; });
      var ys = pts.map(function (p) { return p[1]; });
      var bb = Math.max(Math.max.apply(null, xs) - Math.min.apply(null, xs),
                        Math.max.apply(null, ys) - Math.min.apply(null, ys));
      if (bb < 10) { toast("描图范围太小，已取消", "info"); exitDrawMode(); return; }
      saveAnnotation({ type: "freehand", points: pts });
    }
  }

  // 屏幕坐标 → 图像坐标
  function screenToImg(e) {
    var rect = viewer.container.getBoundingClientRect();
    var p = viewer.viewport.viewerElementToImageCoordinates(
      new OpenSeadragon.Point(e.clientX - rect.left, e.clientY - rect.top));
    return { x: Math.round(p.x), y: Math.round(p.y) };
  }
  function screenPt(e) {
    var rect = viewer.container.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // 保存管理员标注
  function saveAnnotation(geom) {
    if (!state.slide) return;
    var label = (els.annoLabelInput.value || "").trim();
    if (!label) label = "管理员";
    var body = { slide: state.slide.name, type: geom.type, label: label };
    for (var k in geom) body[k] = geom[k];
    apiFetch("/api/annotation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || "保存失败"); });
        return r.json();
      })
      .then(function () {
        toast("标注已保存", "success");
        exitDrawMode();
        refreshCurrentAnnotations();
        loadAnnotationsIndex().then(function () {
          renderProjects(allProjects);
          renderUnfiled();
        });
      })
      .catch(function (e) { toast("保存失败: " + e.message, "error"); exitDrawMode(); });
  }

  // 重新拉取当前切片标注并重绘
  function refreshCurrentAnnotations() {
    if (!state.slide) { redrawAnnoCanvas(); return; }
    apiFetch("/api/annotations?slide=" + encodeURIComponent(state.slide.name))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        currentAnnotations = data;
        var annos = data.annotations || [];
        els.annoBtn.disabled = annos.length === 0;
        els.annoAllBtn.disabled = annos.length === 0;
        if (annos.length === 0) { state.showAnno = false; syncAnnoAllBtns(); }
        if (editItem && flatItems.indexOf(editItem) < 0) { editItem = null; editing = false; }
        // focusAnno 引用失效（flatItems 重建）→ 清空，恢复显示全部
        if (state.focusAnno && flatItems.indexOf(state.focusAnno) < 0) { state.focusAnno = null; }
        rebuildFlatItems();
        redrawAnnoCanvas();
      })
      .catch(function () {});
  }

  // =========================================================================
  // 标注面板 + 全部标记叠加（查看器）
  // =========================================================================
  function openAnnoPanel() {
    if (!state.slide || !currentAnnotations) { toast("当前切片暂无标注", "info"); return; }
    annoPanelOpen = true;
    els.annoPanel.style.display = "flex";
    els.annoPanelTitle.textContent = "标注：" + truncateMiddle(state.slide.name, 28);
    renderAnnoPanel(currentAnnotations.annotations || []);
  }

  function closeAnnoPanel() {
    annoPanelOpen = false;
    els.annoPanel.style.display = "none";
  }

  function renderAnnoPanel(groups) {
    els.annoPanelList.innerHTML = "";
    if (!groups || groups.length === 0) {
      var empty = document.createElement("div");
      empty.className = "anno-panel-empty";
      empty.textContent = "暂无标注";
      els.annoPanelList.appendChild(empty);
      return;
    }
    groups.forEach(function (grp) {
      // 分组标题
      var gh = document.createElement("div");
      gh.className = "anno-group-head";
      gh.innerHTML = '<span class="agh-label">' + esc(grp.label) + "</span>" +
        '<span class="agh-count">' + grp.count + " 条</span>";
      els.annoPanelList.appendChild(gh);

      (grp.items || []).forEach(function (it) {
        var row = document.createElement("div");
        row.className = "anno-item";
        if (!it.shared) row.classList.add("anno-private");
        var left = document.createElement("div");
        left.className = "ai-info";
        var typIcon = (it.type === "arrow") ? "↗" : (it.type === "freehand" ? "〰" : "▭");
        var sizeStr = "";
        if ((it.type || "rect") === "rect" && it.size_mm != null) sizeStr = " · " + it.size_mm + "mm";
        else if (it.type === "arrow") sizeStr = " · (" + it.x1 + "," + it.y1 + ")→(" + it.x2 + "," + it.y2 + ")";
        else if (it.type === "freehand") sizeStr = " · " + (it.points ? it.points.length : 0) + "点";
        left.innerHTML =
          '<div class="ai-title"><span class="ai-type-icon">' + typIcon + "</span>" +
          '<span class="ai-label">' + esc(grp.label) + "</span>" + sizeStr + "</div>" +
          '<div class="ai-sub">' + fmtTime(it.ts) +
          (it.token ? " · 来源 " + String(it.token).slice(0, 6) : "") +
          (it.visitor ? " · 设备 " + esc(String(it.visitor).slice(0, 6)) : "") + "</div>";
        row.appendChild(left);

        // 「公开」切换钮：管理员可策展任意来源标注
        var sharedBtn = document.createElement("button");
        sharedBtn.className = "ai-share" + (it.shared ? " on" : "");
        sharedBtn.textContent = it.shared ? "🌐" : "👁";
        sharedBtn.title = it.shared ? "已公开展示给所有分享用户（点击取消公开）"
                                    : "未公开（点击公开展示给所有分享用户）";
        sharedBtn.addEventListener("click", function (ev) {
          ev.stopPropagation();
          toggleAnnoShared(it, sharedBtn, row);
        });
        row.appendChild(sharedBtn);

        // AI 落标（source=ai）：挂 💬 → 就地展开批注对话（§6 标注面板 fork）
        if (it.source === "ai" && it.annotation_id) {
          var forkBtn = document.createElement("button");
          forkBtn.className = "ai-op ai-fork";
          forkBtn.textContent = "💬";
          forkBtn.title = "就此标注提问（批注对话）";
          forkBtn.addEventListener("click", function (ev) {
            ev.stopPropagation();
            openForkChat(it.annotation_id, row);
          });
          row.appendChild(forkBtn);
        }

        // 编辑钮：跳转到该标注并进入选中编辑态
        var editBtn = document.createElement("button");
        editBtn.className = "ai-op ai-edit";
        editBtn.textContent = "✎";
        editBtn.title = "编辑（移动/缩放/备注）";
        editBtn.addEventListener("click", function (ev) {
          ev.stopPropagation();
          jumpAndEditAnno(it);
        });
        row.appendChild(editBtn);

        // 删除钮：调 DELETE 接口
        var delBtn = document.createElement("button");
        delBtn.className = "ai-op ai-del";
        delBtn.textContent = "🗑";
        delBtn.title = "删除标注";
        delBtn.addEventListener("click", function (ev) {
          ev.stopPropagation();
          deleteAnnoItem(it);
        });
        row.appendChild(delBtn);

        row.style.cursor = "pointer";
        row.addEventListener("click", function (ev) {
          if (ev.target === sharedBtn || ev.target === editBtn || ev.target === delBtn) return;
          jumpToAnno(it);
        });
        els.annoPanelList.appendChild(row);
      });
    });
  }

  function fmtTime(ts) {
    if (!ts) return "";
    var d = new Date(ts * 1000);
    var p = function (n) { return n < 10 ? "0" + n : n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  // 兜底：解析某标注条目在其 token 下的 index（仅旧缓存无 index 时使用；
  // annotations 接口现已直接带 index，正常路径走 resolveIndexFast 不会到这。
  // 通过 /api/share/rois 取该 token 列表，按 slide+ts+几何匹配）
  function resolveAnnoIndex(it) {
    var token = it.token;
    if (!token) return Promise.reject(new Error("缺少 token"));
    // annotations 接口的条目可能不带 slide（旧数据），用当前切片名兜底
    var slideName = it.slide || (state.slide ? state.slide.name : null);
    return apiFetch("/api/share/rois")
      .then(function (r) { return r.json(); })
      .then(function (rois) {
        var cands = (rois || []).filter(function (r) { return r.token === token; });
        // 优先按 slide+ts 精确匹配；ts 不在则退回 slide+几何
        var match = null;
        for (var i = 0; i < cands.length; i++) {
          var r = cands[i];
          if (r.slide === slideName && Number(r.ts) === Number(it.ts)) { match = r; break; }
        }
        if (!match) {
          for (var j = 0; j < cands.length; j++) {
            var rr = cands[j];
            if (rr.slide !== slideName || (rr.type || "rect") !== (it.type || "rect")) continue;
            if ((rr.type || "rect") === "rect" &&
                Number(rr.x) === Number(it.x) && Number(rr.y) === Number(it.y) &&
                Number(rr.side_px) === Number(it.side_px)) { match = rr; break; }
            if (rr.type === "arrow" &&
                Number(rr.x1) === Number(it.x1) && Number(rr.y1) === Number(it.y1) &&
                Number(rr.x2) === Number(it.x2) && Number(rr.y2) === Number(it.y2)) { match = rr; break; }
            if (rr.type === "freehand" && rr.points && it.points &&
                rr.points.length === it.points.length) { match = rr; break; }
          }
        }
        if (!match) throw new Error("未找到对应标注");
        return match.index;
      });
  }

  // 快速取 index：新数据（annotations 接口已带 index）直接用本地 it.index，
  // 省掉一次 /api/share/rois 全量拉取；仅极端旧缓存（无 index）才回退
  // resolveAnnoIndex 全量反推。
  function resolveIndexFast(it) {
    if (it && it.index != null) return Promise.resolve(it.index);
    return resolveAnnoIndex(it);
  }

  // 切换某标注的「公开」状态（策展）
  function toggleAnnoShared(it, btnEl, rowEl) {
    var token = it.token;
    if (!token) { toast("缺少来源 token", "error"); return; }
    var target = !it.shared;
    btnEl.disabled = true;
    resolveIndexFast(it)
      .then(function (index) {
        return apiFetch("/api/annotation/" + encodeURIComponent(token) + "/" + index, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shared: target }),
        }).then(function (r) {
          if (!r.ok) return r.json().then(function (j) {
            throw new Error(j.error || ("更新失败 " + r.status));
          });
          return r.json();
        });
      })
      .then(function () {
        it.shared = target;
        btnEl.classList.toggle("on", target);
        btnEl.textContent = target ? "🌐" : "👁";
        btnEl.title = target ? "已公开展示给所有分享用户（点击取消公开）"
                             : "未公开（点击公开展示给所有分享用户）";
        if (rowEl) rowEl.classList.toggle("anno-private", !target);
        toast(target ? "已设为公开" : "已取消公开", "success");
      })
      .catch(function (e) { toast("更新失败: " + e.message, "error"); })
      .finally(function () { btnEl.disabled = false; });
  }

  // 点击标注条目：fitBounds（按类型算包围盒）+ 在画布上选中高亮该标注。
  // 不再画黄色临时 ROI 框（旧实现会残留且对箭头/描图显示 "0mm × 0mm"，
  // 还会覆盖 state.roi 破坏 ROI 模式选区）。改为复用既有的"选中态高亮"：
  // 被 editItem 选中的标注在 redrawAnnoCanvas/drawAnnoItem 中以蓝色描边。
  function jumpToAnno(it) {
    if (!state.slide || !viewer || !viewer.viewport) return;
    var typ = it.type || "rect";
    var x, y, side;
    if (typ === "arrow") {
      x = Math.min(it.x1, it.x2); y = Math.min(it.y1, it.y2);
      side = Math.max(Math.abs(it.x2 - it.x1), Math.abs(it.y2 - it.y1));
      side = Math.max(side, 1);
    } else if (typ === "freehand") {
      var xs = it.points.map(function (p) { return p[0]; });
      var ys = it.points.map(function (p) { return p[1]; });
      x = Math.min.apply(null, xs); y = Math.min.apply(null, ys);
      side = Math.max(Math.max.apply(null, xs) - x, Math.max.apply(null, ys) - y);
      side = Math.max(side, 1);
    } else {
      x = it.x; y = it.y; side = it.side_px;
    }
    // 扩 20% 边距
    var pad = side * 0.2;
    try {
      var rect = viewer.viewport.imageToViewportRectangle(
        x - pad, y - pad, side + pad * 2, side + pad * 2);
      viewer.viewport.fitBounds(rect);
    } catch (e) {}

    // 选中高亮：flatItems 是 rebuildFlatItems 生成的副本，it 来自面板分组，
    // 引用不同，需按 token+ts+type 在 flatAnnoItems() 里找到匹配副本再选中。
    if (!state.showAnno) {
      state.showAnno = true;
      syncAnnoAllBtns();
    }
    var match = null;
    var items = flatAnnoItems();
    for (var i = 0; i < items.length; i++) {
      var f = items[i];
      if (f.token === it.token && Number(f.ts) === Number(it.ts) &&
          (f.type || "rect") === (it.type || "rect")) { match = f; break; }
    }
    if (match) {
      editItem = match;     // 选中态：drawAnnoItem 会给蓝色描边
      state.focusAnno = match; // 跳转/选中该条 → 只显示它
      editing = false;      // 只高亮，不开可拖动编辑态
      closeEditCard();      // 不弹编辑卡（仅点击行，非"编辑"按钮）
      redrawAnnoCanvas();
    }
    return match;           // 供 jumpAndEditAnno 复用匹配结果
  }

  // ---------- 编辑卡（标注面板顶部） + 删除 ----------
  // 显式编辑态：非编辑态只显示「✎ 编辑」入口，点它才进入可拖动编辑态；
  // 备注 textarea 两种状态下都可直接改（备注改动不属于"移动"）。
  function openEditCard(it) {
    var wrap = $("anno-edit-wrap");
    if (!wrap) return;
    var typ = it.type || "rect";
    var titleText = typ === "arrow" ? "编辑箭头" : (typ === "freehand" ? "编辑描图" : "编辑选区");
    wrap.innerHTML = "";
    var card = document.createElement("div");
    card.className = "anno-edit-card";
    var head = document.createElement("div");
    head.className = "aec-head";
    head.textContent = titleText;
    card.appendChild(head);
    var ta = document.createElement("textarea");
    ta.className = "aec-note";
    ta.maxLength = 500;
    ta.placeholder = "备注（可选，气泡显示）";
    ta.value = it.note || "";
    ta.rows = 2;
    card.appendChild(ta);
    var ops = document.createElement("div");
    ops.className = "aec-ops";
    if (editing) {
      // 编辑态：保存 / 取消 / 删除
      var saveB = document.createElement("button");
      saveB.className = "btn primary small"; saveB.textContent = "保存";
      var cancelB = document.createElement("button");
      cancelB.className = "btn secondary small"; cancelB.textContent = "取消";
      var delB = document.createElement("button");
      delB.className = "btn danger small"; delB.textContent = "删除";
      ops.appendChild(delB); ops.appendChild(cancelB); ops.appendChild(saveB);
      card.appendChild(ops);
      wrap.appendChild(card);
      wrap.style.display = "block";

      saveB.addEventListener("click", function () { commitAdminEdit(it, ta.value); });
      cancelB.addEventListener("click", function () { cancelAdminEdit(it); });
      delB.addEventListener("click", function () {
        delB.disabled = true;
        deleteAnnoItem(it);
      });
      ta.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitAdminEdit(it, ta.value); }
      });
    } else {
      // 非编辑态：✎ 编辑 / 保存 / 删除
      var editB = document.createElement("button");
      editB.className = "btn small"; editB.textContent = "✎ 编辑";
      editB.title = "进入可拖动编辑态";
      var saveB2 = document.createElement("button");
      saveB2.className = "btn primary small"; saveB2.textContent = "保存";
      var delB2 = document.createElement("button");
      delB2.className = "btn danger small"; delB2.textContent = "删除";
      ops.appendChild(delB2); ops.appendChild(editB); ops.appendChild(saveB2);
      card.appendChild(ops);
      wrap.appendChild(card);
      wrap.style.display = "block";

      editB.addEventListener("click", function () {
        editing = true;
        redrawAnnoCanvas();
        openEditCard(it);
      });
      saveB2.addEventListener("click", function () { commitAdminEdit(it, ta.value); });
      delB2.addEventListener("click", function () {
        delB2.disabled = true;
        deleteAnnoItem(it);
      });
      ta.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitAdminEdit(it, ta.value); }
      });
    }
  }

  function closeEditCard() {
    var wrap = $("anno-edit-wrap");
    if (wrap) { wrap.innerHTML = ""; wrap.style.display = "none"; }
  }

  // 收集编辑后几何（图片坐标，round 整数，clamp ≥0）
  function buildEditGeom(it) {
    var typ = it.type || "rect";
    var g = {};
    if (typ === "rect") {
      g.x = Math.max(0, Math.round(it.x));
      g.y = Math.max(0, Math.round(it.y));
      g.side_px = clamp(Math.round(it.side_px), 1, 40000);
    } else if (typ === "arrow") {
      g.x1 = Math.max(0, Math.round(it.x1));
      g.y1 = Math.max(0, Math.round(it.y1));
      g.x2 = Math.max(0, Math.round(it.x2));
      g.y2 = Math.max(0, Math.round(it.y2));
    } else if (typ === "freehand") {
      g.points = (it.points || []).map(function (p) {
        return [Math.max(0, Math.round(p[0])), Math.max(0, Math.round(p[1]))];
      });
    }
    return g;
  }

  // 提交管理员编辑：PATCH geom + note（index 直接用 it.index，无则兜底反推）
  function commitAdminEdit(it, noteVal) {
    var geom = buildEditGeom(it);
    var body = { geom: geom, note: noteVal };
    // rect 的 size_mm 前端重算
    if ((it.type || "rect") === "rect" && state.mppX && state.mppX > 0) {
      body.geom.size_mm = Math.round(geom.side_px * state.mppX / 1000 * 100) / 100;
    } else if ((it.type || "rect") === "rect") {
      body.geom.size_mm = it.size_mm != null ? it.size_mm : 0;
    }
    resolveIndexFast(it)
      .then(function (index) {
        return apiFetch("/api/annotation/" + encodeURIComponent(it.token) + "/" + index, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }).then(function (r) {
          if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || "保存失败"); });
          return r.json();
        });
      })
      .then(function () {
        toast("已保存修改", "success");
        editItem = null;
        editing = false;
        closeEditCard();
        refreshCurrentAnnotations();
        loadAnnotationsIndex().then(function () {
          renderProjects(allProjects);
          renderUnfiled();
        });
      })
      .catch(function (e) { toast("保存失败: " + e.message, "error"); });
  }

  function cancelAdminEdit(it) {
    editItem = null;
    editing = false;
    closeEditCard();
    refreshCurrentAnnotations();
  }

  // 删除标注（管理员，任意来源）：
  // 幂等 + 过期自动重试。后端 index 是该 token 下按插入序的序号，数据变动后
  // 本地缓存 index（it.index）可能过期 → 后端 404「标注不存在」。处理：
  //   1) 先按 resolveIndexFast（优先 it.index）发 DELETE；
  //   2) 若 404：改用 resolveAnnoIndex（重新拉 /api/share/rois 按 slide+ts+几何
  //      反推最新 index）重试 DELETE 一次；
  //   3) 若 resolveAnnoIndex 也找不到（抛"未找到对应标注"）或重试仍 404 → 说明
  //      该标注在服务端已不存在，删除本就幂等，视为成功，走乐观移除 + toast；
  //   4) 非 404 错误（网络/403 等）按原逻辑 toast「删除失败」并刷新恢复。
  function deleteAnnoItem(it) {
    // 发 DELETE，返回 { ok, status }：成功 ok=true；失败携带 HTTP status 供上层
    // 区分 404（幂等可放过）与其他错误（需报错恢复）。
    function sendDelete(index) {
      return apiFetch("/api/annotation/" + encodeURIComponent(it.token) + "/" + index, {
        method: "DELETE",
      }).then(function (r) {
        if (r.ok) return { ok: true, status: r.status };
        // 消费 body 以释放流，失败也无所谓（仅取 status）
        return r.json().catch(function () { return {}; }).then(function () {
          return { ok: false, status: r.status };
        });
      });
    }

    // 乐观更新：成功路径与"视为已删除"路径共用，立即反馈 + 后台异步同步。
    function applyAnnoRemoved() {
      // 1) flatItems 按引用移除（画布数据源）
      var items = flatAnnoItems();
      var fi = items.indexOf(it);
      if (fi >= 0) items.splice(fi, 1);
      // 2) currentAnnotations 分组中按引用移除，grp.count--，空组剔除
      if (currentAnnotations && currentAnnotations.annotations) {
        var groups = currentAnnotations.annotations;
        for (var gi = groups.length - 1; gi >= 0; gi--) {
          var g = groups[gi];
          var ii = (g.items || []).indexOf(it);
          if (ii >= 0) {
            g.items.splice(ii, 1);
            g.count = Math.max(0, (g.count || 1) - 1);
            if (g.items.length === 0) groups.splice(gi, 1);
          }
        }
      }
      // 3) 若当前编辑/选中项正是它，清选中并关编辑卡
      //    （editItem 多为 flatItems 副本，引用不等时按 token+ts+type 判定）
      if (editItem && (editItem === it ||
          (editItem.token === it.token && Number(editItem.ts) === Number(it.ts) &&
           (editItem.type || "rect") === (it.type || "rect")))) {
        editItem = null;
        editing = false;
        closeEditCard();
      }
      // focusAnno 若指向被删项（按引用或 token+ts+type 判定）→ 清空恢复显示全部
      if (state.focusAnno && (state.focusAnno === it ||
          (state.focusAnno.token === it.token && Number(state.focusAnno.ts) === Number(it.ts) &&
           (state.focusAnno.type || "rect") === (it.type || "rect")))) {
        state.focusAnno = null;
      }
      // 4) 重建扁平缓存 + 重绘 + 面板即时重渲 + 立即 toast
      rebuildFlatItems();
      redrawAnnoCanvas();
      if (annoPanelOpen) renderAnnoPanel((currentAnnotations || {}).annotations || []);
      toast("已删除标注", "success");
      // ---- 后台异步同步（不阻塞上面的即时反馈）----
      refreshCurrentAnnotations();
      // 全量索引只影响项目/未归类行的计数徽章，后台慢慢同步即可
      loadAnnotationsIndex().then(function () {
        renderProjects(allProjects);
        renderUnfiled();
      });
    }

    resolveIndexFast(it)
      .then(function (index) {
        return sendDelete(index).then(function (res) {
          if (res.ok) return { treated: true };
          // 第一次 404：index 可能过期，用 resolveAnnoIndex 反推最新 index 重试一次
          if (res.status === 404) {
            return resolveAnnoIndex(it)
              .then(function (freshIndex) { return sendDelete(freshIndex); })
              .then(function (res2) {
                if (res2.ok) return { treated: true };
                // 重试仍 404 → 服务端已无此标注，删除幂等，视为成功
                if (res2.status === 404) return { treated: true, alreadyGone: true };
                // 其他错误冒泡到 catch
                throw new Error("删除失败 (" + res2.status + ")");
              })
              .catch(function (e) {
                // resolveAnnoIndex 抛"未找到对应标注" → 服务端已无此标注，视为成功
                if (e && /未找到对应标注/.test(e.message)) {
                  return { treated: true, alreadyGone: true };
                }
                throw e; // 其余错误继续冒泡
              });
          }
          // 非 404 错误：报错并在 catch 中刷新恢复
          throw new Error("删除失败 (" + res.status + ")");
        });
      })
      .then(function (outcome) {
        // 成功或"已不存在视为成功"，统一走乐观移除
        applyAnnoRemoved();
      })
      .catch(function (e) {
        toast("删除失败: " + (e && e.message ? e.message : "未知错误"), "error");
        // 失败恢复：重新拉取真实状态
        refreshCurrentAnnotations();
      });
  }

  // 跳转并打开编辑卡（标注面板"编辑"按钮）：
  // 复用 jumpToAnno 的定位 + 选中高亮，再对匹配项打开编辑卡。
  function jumpAndEditAnno(it) {
    var match = jumpToAnno(it);
    if (match) {
      editing = false;        // 打开"查看态"编辑卡（含 ✎ 编辑入口）
      openEditCard(match);
    }
  }

  // ---------- 删除切片 ----------
  function deleteSlide(name) {
    if (!confirm("确认删除切片 " + name + " ？")) return;
    apiFetch("/api/slide/" + encodeURIComponent(name), { method: "DELETE" })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error); });
        if (state.slide && state.slide.name === name) {
          state.slide = null; state.mppX = null; state.roiMode = null;
          els.currentSlide.textContent = "未打开切片";
          updateMppSetterVisibility();
          if (roiBox) exitRoi();
          if (viewer) viewer.close();
        }
        toast("已删除 " + name, "success");
        loadAll();
      })
      .catch(function (e) { toast("删除失败: " + e.message, "error"); });
  }

  // ---------- 上传 ----------
  function uploadFile(file) {
    if (!file) return;
    var formData = new FormData();
    formData.append("file", file);
    var xhr = new XMLHttpRequest();
    els.progressWrap.style.display = "block";
    els.progressBar.style.width = "0%";
    els.progressText.textContent = "0%";
    xhr.upload.addEventListener("progress", function (e) {
      if (e.lengthComputable) {
        var pct = Math.round((e.loaded / e.total) * 100);
        els.progressBar.style.width = pct + "%";
        els.progressText.textContent = pct + "%";
      }
    });
    xhr.addEventListener("load", function () {
      els.progressWrap.style.display = "none";
      var data;
      try { data = JSON.parse(xhr.responseText); } catch (e) { toast("上传响应解析失败", "error"); return; }
      if (xhr.status >= 200 && xhr.status < 300) {
        toast("上传成功: " + data.name, "success");
        loadAll();
        openSlide(data.name);
      } else {
        toast("上传失败: " + (data.error || xhr.status), "error");
      }
    });
    xhr.addEventListener("error", function () {
      els.progressWrap.style.display = "none";
      toast("上传出错（网络）", "error");
    });
    xhr.open("POST", "/api/upload");
    xhr.send(formData);
  }

  // ---------- 拖拽上传 ----------
  function setupDragDrop() {
    var wrap = els.viewerWrap;
    var counter = 0;
    wrap.addEventListener("dragenter", function (e) { e.preventDefault(); counter++; els.dropOverlay.classList.add("active"); });
    wrap.addEventListener("dragover", function (e) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
    wrap.addEventListener("dragleave", function (e) { e.preventDefault(); counter--; if (counter <= 0) { counter = 0; els.dropOverlay.classList.remove("active"); } });
    wrap.addEventListener("drop", function (e) {
      e.preventDefault(); counter = 0; els.dropOverlay.classList.remove("active");
      var files = e.dataTransfer.files;
      if (files && files.length > 0) { for (var i = 0; i < files.length; i++) uploadFile(files[i]); }
    });
  }

  // ---------- 事件绑定 ----------
  function bindEvents() {
    els.zoomIn.addEventListener("click", zoomIn);
    els.zoomOut.addEventListener("click", zoomOut);
    els.rotateBtn.addEventListener("click", rotate);
    els.flipBtn.addEventListener("click", flip);
    els.resetBtn.addEventListener("click", reset);
    els.roi6.addEventListener("click", function () { toggleRoi(6); });
    els.roi65.addEventListener("click", function () { toggleRoi(6.5); });
    els.saveBtn.addEventListener("click", saveCrop);
    els.saveAnnoBtn.addEventListener("click", saveAnno);
    els.mppSetBtn.addEventListener("click", setMpp);
    els.mppInput.addEventListener("keydown", function (e) { if (e.key === "Enter") setMpp(); });

    els.uploadBtn.addEventListener("click", function () { els.fileInput.click(); });
    els.fileInput.addEventListener("change", function () {
      if (this.files && this.files[0]) { uploadFile(this.files[0]); this.value = ""; }
    });

    // 标注
    els.annoBtn.addEventListener("click", function () {
      if (annoPanelOpen) { closeAnnoPanel(); } else { openAnnoPanel(); }
    });
    els.annoPanelClose.addEventListener("click", closeAnnoPanel);
    els.annoAllBtn.addEventListener("click", toggleAnnoAll);
    // 面板头部「显示全部标记」切换钮（与 toggleAnnoAll 同一逻辑）
    if (els.annoAllToggle) els.annoAllToggle.addEventListener("click", toggleAnnoAll);
    els.annoArrowBtn.addEventListener("click", function () { toggleDrawMode("arrow"); });
    els.annoFreeBtn.addEventListener("click", function () { toggleDrawMode("freehand"); });
    // 移动端 ROI 滑块分段：点一段切换该尺寸，再点同段退出
    if (els.roiBoxBtn) {
      els.roiBoxBtn.querySelectorAll(".roi-slider-seg").forEach(function (seg) {
        seg.addEventListener("click", function () {
          if (seg.classList.contains("disabled")) return;
          toggleRoi(Number(seg.getAttribute("data-size")));
        });
      });
      syncRoiSlider();
    }

    // 标注画布层绘制事件
    var c = els.annoCanvas;
    c.addEventListener("pointerdown", onAnnoPointerDown);
    c.addEventListener("pointermove", onAnnoPointerMove);
    c.addEventListener("pointerup", onAnnoPointerUp);
    c.addEventListener("pointercancel", onAnnoPointerUp);
    window.addEventListener("resize", function () { resizeAnnoCanvas(); redrawAnnoCanvas(); });

    // 手机端侧栏抽屉：菜单按钮切换、遮罩点击关闭
    if (els.menuBtn) {
      els.menuBtn.addEventListener("click", toggleSidebarDrawer);
    }
    if (els.sidebarMask) {
      els.sidebarMask.addEventListener("click", closeSidebarDrawer);
    }

    // 移动端 ⋯ 溢出面板（AI 读片 + 缩放徽章）
    bindTbbMore();

    // 新建项目
    els.newProjectBtn.addEventListener("click", function () {
      var showing = els.newProjectForm.style.display !== "none";
      toggleNewProjectForm(!showing);
    });
    els.npConfirm.addEventListener("click", function () { createProjectFromForm([]); });
    els.npCancel.addEventListener("click", function () { toggleNewProjectForm(false); });
    els.npName.addEventListener("keydown", function (e) { if (e.key === "Enter") els.npNote.focus(); });
    els.npNote.addEventListener("keydown", function (e) { if (e.key === "Enter") createProjectFromForm([]); });

    // 未归类
    els.unfiledToggle.addEventListener("click", function () {
      var sec = els.unfiledBody.closest(".section");
      if (sec) sec.classList.toggle("collapsed");
    });
    els.unfiledNewProject.addEventListener("click", function () {
      var slides = Object.keys(slideChecked).filter(function (k) { return slideChecked[k]; });
      if (slides.length === 0) { toast("请先勾选切片", "error"); return; }
      // 预填并打开表单：这里直接以选中切片创建项目
      toggleNewProjectForm(true);
      // 记录待加入切片，确认时带上
      pendingNewProjectSlides = slides;
      toast("已选中 " + slides.length + " 张，输入名称后确认", "info");
    });

    // 分享
    els.shareExpiresSelect.addEventListener("change", function () {
      els.shareExpiresCustom.style.display = this.value === "custom" ? "inline-block" : "none";
    });
    els.shareCreateBtn.addEventListener("click", onShareCreateClick);
    els.shareResultCopy.addEventListener("click", function () { copyText(els.shareResultUrl.value); });
    els.shareMgrToggle.addEventListener("click", function () {
      var sec = els.shareMgrBody.closest(".section");
      if (sec) sec.classList.toggle("collapsed");
    });

    // 切片选择器
    els.pickerClose.addEventListener("click", closeSlidePicker);
    els.pickerConfirm.addEventListener("click", confirmSlidePicker);
    els.pickerMask.addEventListener("click", function (e) {
      if (e.target === els.pickerMask) closeSlidePicker();
    });

    // AI 读片助手
    els.aiBtn.addEventListener("click", function () {
      if (aiPanelOpen) { closeAiPanel(); } else { openAiPanel(); }
    });
    els.aiPanelClose.addEventListener("click", closeAiPanel);
    els.aiConfigSave.addEventListener("click", saveAiConfig);
    els.aiReconfigBtn.addEventListener("click", function () {
      els.aiConfigCollapsed.style.display = "none";
      els.aiConfigWrap.style.display = "block";
      // 把掩码回填到 api_key 输入框（占位提示），明文不回填
      if (aiConfig && aiConfig.api_key_mask) {
        els.aiApiKey.value = aiConfig.api_key_mask;
        els.aiApiKey.placeholder = "与掩码同值=不变，清空=删除";
      }
      fillAiTuningFields();
    });
    els.aiStartBtn.addEventListener("click", startAiRun);
    els.aiContinueBtn.addEventListener("click", continueAiRun);
    els.aiFreshBtn.addEventListener("click", freshAiRun);
    els.aiStopBtn.addEventListener("click", stopAiRun);
    els.aiTaskJump.addEventListener("click", function () {
      var bbox = currentSelectionBbox();
      if (!bbox) { toast("请先用 ROI 框选区域或选中一个标注", "info"); return; }
      var prefix = "重点看 level-0 区域 (x=" + bbox.x + ",y=" + bbox.y +
                   ",w=" + bbox.w + ",h=" + bbox.h + ")：";
      var cur = els.aiTask.value || "";
      els.aiTask.value = prefix + cur;
      els.aiTask.focus();
    });
  }

  // =========================================================================
  // AI 读片助手（仅管理员）
  // =========================================================================
  // 加载 AI 配置（GET /api/ai/config，api_key 脱敏）
  function loadAiConfig() {
    return apiFetch("/api/ai/config").then(function (r) { return r.json(); }).then(function (cfg) {
      aiConfig = cfg;
      renderAiConfigState();
      return cfg;
    }).catch(function () { /* 静默，面板里会提示未配置 */ });
  }

  // 根据配置渲染设置区/折叠区
  function renderAiConfigState() {
    if (!aiConfig) return;
    var configured = !!(aiConfig.base_url && aiConfig.api_key_set);
    if (configured) {
      els.aiConfigWrap.style.display = "none";
      els.aiConfigCollapsed.style.display = "flex";
      els.aiConfigSummary.textContent =
        (aiConfig.model || "(未设模型)") + " @ " + aiConfig.base_url;
    } else {
      els.aiConfigWrap.style.display = "block";
      els.aiConfigCollapsed.style.display = "none";
      // 回填已知的非敏感字段
      els.aiBaseUrl.value = aiConfig.base_url || "";
      els.aiModel.value = aiConfig.model || "";
      fillAiTuningFields();
    }
  }

  // 把调优参数（步数上限/协议/高级区）回填到表单（用 aiConfig 当前值或文档默认）
  function fillAiTuningFields() {
    if (!aiConfig) return;
    els.aiMaxSteps.value = aiConfig.max_steps != null ? aiConfig.max_steps : 50;
    if (els.aiApiProtocol) {
      els.aiApiProtocol.value = aiConfig.api_protocol || "openai";
    }
    if (els.aiCtxWindow) els.aiCtxWindow.value = aiConfig.context_window_tokens != null ? aiConfig.context_window_tokens : "";
    if (els.aiReserve) els.aiReserve.value = aiConfig.reserve_tokens != null ? aiConfig.reserve_tokens : "";
    if (els.aiSafetyMargin) els.aiSafetyMargin.value = aiConfig.safety_margin != null ? aiConfig.safety_margin : "";
    if (els.aiKeepRecent) els.aiKeepRecent.value = aiConfig.keep_recent_tokens != null ? aiConfig.keep_recent_tokens : "";
    if (els.aiForkLimit) els.aiForkLimit.value = aiConfig.fork_active_limit != null ? aiConfig.fork_active_limit : "";
    if (els.aiLeaseTtl) els.aiLeaseTtl.value = aiConfig.lease_ttl != null ? aiConfig.lease_ttl : "";
  }

  // 保存配置（PUT /api/ai/config）
  function saveAiConfig() {
    var payload = {
      base_url: els.aiBaseUrl.value.trim(),
      model: els.aiModel.value.trim(),
    };
    var keyVal = els.aiApiKey.value;
    // 空串或与掩码同值都不传（后端按规则处理）；这里显式传让后端判断
    if (keyVal !== "") { payload.api_key = keyVal; }
    // 步数上限（必填项）
    var steps = parseInt(els.aiMaxSteps.value, 10);
    if (isNaN(steps) || steps < 1) {
      toast("步数上限需为 ≥1 的整数", "error");
      els.aiMaxSteps.focus();
      return;
    }
    payload.max_steps = steps;
    // 协议
    if (els.aiApiProtocol) { payload.api_protocol = els.aiApiProtocol.value || "openai"; }
    // 高级调优参数（填了才提交，后端校验数值）
    var advFields = [
      ["context_window_tokens", els.aiCtxWindow],
      ["reserve_tokens", els.aiReserve],
      ["safety_margin", els.aiSafetyMargin],
      ["keep_recent_tokens", els.aiKeepRecent],
      ["fork_active_limit", els.aiForkLimit],
      ["lease_ttl", els.aiLeaseTtl],
    ];
    advFields.forEach(function (pair) {
      var val = pair[1] ? pair[1].value.trim() : "";
      if (val !== "") { payload[pair[0]] = Number(val); }
    });
    els.aiConfigHint.textContent = "保存中…";
    els.aiConfigSave.disabled = true;
    apiFetch("/api/ai/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(function (r) { return r.json(); }).then(function (cfg) {
      aiConfig = cfg;
      renderAiConfigState();
      els.aiApiKey.value = "";
      els.aiConfigHint.textContent = "已保存";
      toast("AI 配置已保存", "success");
    }).catch(function (e) {
      els.aiConfigHint.textContent = "";
      toast("保存失败: " + (e && e.message ? e.message : e), "error");
    }).then(function () { els.aiConfigSave.disabled = false; });
  }

  function openAiPanel() {
    if (!state.slide) { toast("请先打开一个切片", "info"); return; }
    aiPanelOpen = true;
    els.aiPanel.style.display = "flex";
  }

  function closeAiPanel() {
    aiPanelOpen = false;
    els.aiPanel.style.display = "none";
    // 关面板不停止进行中的 run（后台继续，结果仍落标注）
  }

  // 当前选区 bbox（ROI 框 或 选中标注），用于"判读当前选区"快捷钮
  function currentSelectionBbox() {
    // 优先 ROI 框
    if (state.roi && state.roi.side > 0) {
      return { x: state.roi.x, y: state.roi.y, w: state.roi.side, h: state.roi.side };
    }
    // 选中标注（rect）
    if (editItem && editItem.type === "rect" && editItem.side_px) {
      return { x: editItem.x, y: editItem.y, w: editItem.side_px, h: editItem.side_px };
    }
    return null;
  }

  // 开始 AI run（POST /api/ai/run?fresh=1，SSE）
  function startAiRun() {
    if (!state.slide) { toast("请先打开一个切片", "info"); return; }
    if (aiRunning) { toast("已有任务进行中", "info"); return; }
    if (!aiConfig || !aiConfig.base_url || !aiConfig.api_key_set) {
      toast("请先配置 AI 服务", "error");
      els.aiConfigWrap.style.display = "block";
      els.aiConfigCollapsed.style.display = "none";
      return;
    }
    var task = (els.aiTask.value || "").trim();
    if (!task) { toast("请输入任务描述", "info"); els.aiTask.focus(); return; }

    // 重置轨迹流
    resetAiTrace();
    aiRunning = true;
    aiPaused = false;
    setAiRunningUi(true);
    aiSessionId = null;
    aiLastSeq = 0;

    fetch("/api/ai/run?fresh=1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slide: state.slide.name, task: task }),
      credentials: "same-origin",
    }).then(function (resp) {
      if (!resp.ok || !resp.body) {
        return resp.text().then(function (t) {
          throw new Error(t || ("HTTP " + resp.status));
        });
      }
      pumpAiSse(resp.body.getReader());
    }).catch(function (e) {
      toast("AI 运行失败: " + (e && e.message ? e.message : e), "error");
      appendTraceRow("error", "AI 运行失败: " + (e && e.message ? e.message : e));
      finishAiRun();
    });
  }

  // 继续 paused 的主 run（POST /api/ai/continue，SSE）
  function continueAiRun() {
    if (!state.slide) { toast("请先打开一个切片", "info"); return; }
    if (aiRunning) { toast("已有任务进行中", "info"); return; }
    if (!aiConfig || !aiConfig.base_url || !aiConfig.api_key_set) {
      toast("请先配置 AI 服务", "error");
      return;
    }
    aiRunning = true;
    aiPaused = false;
    setAiRunningUi(true);
    appendTraceRow("info", "继续读片…");
    fetch("/api/ai/continue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slide: state.slide.name }),
      credentials: "same-origin",
    }).then(function (resp) {
      if (!resp.ok || !resp.body) {
        return resp.text().then(function (t) { throw new Error(t || ("HTTP " + resp.status)); });
      }
      pumpAiSse(resp.body.getReader());
    }).catch(function (e) {
      toast("继续失败: " + (e && e.message ? e.message : e), "error");
      appendTraceRow("error", "继续失败: " + (e && e.message ? e.message : e));
      finishAiRun();
    });
  }

  // 新会话（fresh）：归档旧 main 开新，不影响标注与批注
  function freshAiRun() {
    if (!state.slide) { toast("请先打开一个切片", "info"); return; }
    if (aiRunning) { toast("已有任务进行中，请先停止", "info"); return; }
    if (!aiConfig || !aiConfig.base_url || !aiConfig.api_key_set) {
      toast("请先配置 AI 服务", "error");
      return;
    }
    if (!confirm("归档旧对话开新会话，不影响已落标注与批注对话，确认？")) return;
    els.aiTask.value = "";
    startAiRun();
  }

  function stopAiRun() {
    // 走 /cancel（不只是断开 SSE，§5.4）
    if (aiSessionId) {
      apiFetch("/api/ai/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: aiSessionId }),
      }).catch(function () {});
    }
    if (aiAbortCtrl) { try { aiAbortCtrl.abort(); } catch (e) {} }
    finishAiRun();
  }

  function finishAiRun() {
    aiRunning = false;
    setAiRunningUi(false);
    aiAbortCtrl = null;
    aiStreamCtrl = null;
  }

  // 运行中/暂停/空闲的按钮组状态
  function setAiRunningUi(running) {
    if (running) {
      els.aiStartBtn.style.display = "none";
      els.aiContinueBtn.style.display = "none";
      els.aiFreshBtn.style.display = "none";
      els.aiStopBtn.style.display = "inline-block";
    } else if (aiPaused) {
      els.aiStartBtn.style.display = "none";
      els.aiContinueBtn.style.display = "inline-block";
      els.aiFreshBtn.style.display = "inline-block";
      els.aiStopBtn.style.display = "none";
    } else {
      els.aiStartBtn.style.display = "inline-block";
      els.aiContinueBtn.style.display = "none";
      els.aiFreshBtn.style.display = "none";
      els.aiStopBtn.style.display = "none";
    }
  }

  // 通用 SSE 泵：解析帧 → handleAiEvent（同时推进 aiLastSeq）
  function pumpAiSse(reader) {
    var decoder = new TextDecoder("utf-8");
    var buffer = "";
    function pump() {
      return reader.read().then(function (result) {
        if (result.done) {
          // 正常结束：若 run 是 paused 则保持按钮组
          finishAiRun();
          return;
        }
        buffer += decoder.decode(result.value, { stream: true });
        var idx;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          var frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          handleSseFrame(frame);
        }
        return pump();
      });
    }
    return pump();
  }

  // 解析单条 SSE 帧（event:/data:/id: 行）
  function handleSseFrame(frame) {
    var eventType = null;
    var dataStr = "";
    var seq = null;
    var lines = frame.split("\n");
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf(":") === 0) continue; // 注释/心跳
      if (line.indexOf("id:") === 0) {
        seq = parseInt(line.slice(3).trim(), 10);
        if (!isFinite(seq)) seq = null;
      } else if (line.indexOf("event:") === 0) {
        eventType = line.slice(6).trim();
      } else if (line.indexOf("data:") === 0) {
        dataStr += line.slice(5).trim();
      }
    }
    if (!eventType) return;
    if (eventType === "session_ended") {
      finishAiRun();
      return;
    }
    if (eventType === "event_reset") {
      // 事件缓冲已滚过断点：后端要求前端全量刷新（§5.6 event_reset）
      var rp = {};
      if (dataStr) {
        try { rp = JSON.parse(dataStr); } catch (e) { rp = { raw: dataStr }; }
      }
      if (seq != null) aiLastSeq = Math.max(aiLastSeq, seq);
      handleAiEventReset(rp);
      return;
    }
    var payload = {};
    if (dataStr) {
      try { payload = JSON.parse(dataStr); } catch (e) { payload = { raw: dataStr }; }
    }
    if (seq != null) aiLastSeq = Math.max(aiLastSeq, seq);
    if (payload && payload.session_id) aiSessionId = payload.session_id;
    handleAiEvent(eventType, payload);
  }

  // GET session detail，把脱敏 transcript 渲染成 SMS 聊天气泡（#1）。
  // container=主 AI 轨迹 或 fork 对话流；opts 透传给 renderAiTranscript。
  function loadAndRenderTranscript(sessionId, container, opts) {
    if (!sessionId || !container) return Promise.resolve();
    return apiFetch("/api/ai/session/" + encodeURIComponent(sessionId))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var s = data && data.session;
        var t = (data && data.transcript) || [];
        // 清空容器里的旧内容（保留 fork 头部/输入框——只清 stream 区）
        container.innerHTML = "";
        if (t && t.length) {
          renderAiTranscript(t, { container: container, emphasis: (opts && opts.emphasis) || "main" });
        } else {
          appendTraceRow("info", "（暂无对话记录）", container);
        }
        if (s && s.last_event_seq != null) {
          aiLastSeq = Math.max(aiLastSeq, Number(s.last_event_seq) || 0);
        }
      })
      .catch(function () {
        appendTraceRow("info", "（对话记录加载失败）", container);
      });
  }

  // 断线重挂：页面刷新/重开切片后，GET session + 带 Last-Event-ID 重放进行中的 run
  function restoreAiSession() {
    if (!state.slide) return;
    if (!aiConfig || !aiConfig.base_url || !aiConfig.api_key_set) return;
    apiFetch("/api/ai/sessions?slide=" + encodeURIComponent(state.slide.name))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var sessions = (data && data.sessions) || [];
        var main = null;
        for (var i = 0; i < sessions.length; i++) {
          if (sessions[i].kind === "main") { main = sessions[i]; break; }
        }
        if (!main) { setAiRunningUi(false); return; }
        aiSessionId = main.id;
        if (main.status === "running") {
          // 有进行中的 run：重挂 SSE（带 last seq），并把已有 transcript 渲染出来
          aiRunning = true;
          aiPaused = false;
          setAiRunningUi(true);
          appendTraceRow("info", "检测到进行中的读片，恢复事件流…");
          loadAndRenderTranscript(main.id, els.aiTrace, { emphasis: "main" });
          attachAiStream(main.id);
        } else if (main.status === "paused" || main.status === "finished" || main.status === "error") {
          aiPaused = (main.status === "paused");
          setAiRunningUi(false);
          // 渲染完整 SMS 式对话记录（#1）：paused/finished/error 都把历史铺出来
          loadAndRenderTranscript(main.id, els.aiTrace, { emphasis: "main" });
          if (main.status === "paused") {
            appendTraceRow("info", "(已暂停，可继续)");
          } else if (main.status === "finished") {
            appendTraceRow("finished", "读片已完成");
          } else {
            appendTraceRow("error", "上次读片异常终止");
          }
        }
      })
      .catch(function () { /* 静默 */ });
  }

  function attachAiStream(sessionId) {
    var url = "/api/ai/session/" + encodeURIComponent(sessionId) + "/stream?after_seq=" + aiLastSeq;
    if (aiStreamCtrl) { try { aiStreamCtrl.abort(); } catch (e) {} }
    aiStreamCtrl = new AbortController();
    fetch(url, {
      headers: { "Last-Event-ID": String(aiLastSeq || 0) },
      signal: aiStreamCtrl.signal,
      credentials: "same-origin",
    }).then(function (resp) {
      if (!resp.ok || !resp.body) { throw new Error("HTTP " + resp.status); }
      return pumpAiSse(resp.body.getReader());
    }).catch(function (e) {
      if (e && e.name === "AbortError") return;
      // 重挂失败：后台继续，稍后手动"继续"或刷新
      toast("事件流重挂失败", "error");
    });
  }

  // 按 SSE 事件类型渲染轨迹流 + canvas overlay
  function handleAiEvent(type, p) {
    if (type === "slide_opened") {
      if (p.viewport) {
        aiOverlay = [{ x: p.viewport.x, y: p.viewport.y, w: p.viewport.w, h: p.viewport.h,
                       magnification: "概览" }];
        redrawAnnoCanvas();
      }
      appendTraceRow("info", "已打开切片 " + (p.slide || "") + "，开始读片…");
      return;
    }
    if (type === "session_resumed" || type === "fork_resumed" || type === "fork_created") {
      appendTraceRow("info", (type === "fork_created" ? "批注对话已建立" : "会话已恢复"));
      return;
    }
    if (type === "agent_thinking") {
      setThinkingRow();
      return;
    }
    if (type === "text_delta") {
      appendTextBubble(p.text || "");
      return;
    }
    if (type === "tool_started") {
      clearThinkingRow();
      if (p.tool === "goto") {
        appendTraceRow("tool", "→ goto (" + fmtNum(p.x) + "," + fmtNum(p.y) +
          ") @ " + (p.magnification || "") + (p.reason ? " · " + p.reason : ""));
      } else {
        appendTraceRow("tool", "→ " + p.tool);
      }
      return;
    }
    if (type === "snapshot_captured") {
      clearThinkingRow();
      var bb = p.bboxLevel0 || {};
      aiOverlay.push({ x: bb.x, y: bb.y, w: bb.w, h: bb.h,
                       magnification: p.magnification || "" });
      // 只保留最近一次框（按需求"完成后保留最近一次框"；过程中也只显示最新）
      if (aiOverlay.length > 1) aiOverlay = aiOverlay.slice(-1);
      redrawAnnoCanvas();
      // 友好卡片：只显示"📷 快照 @倍率（点击跳转）"，不暴露 out_w/out_h 原始参数
      var row = appendTraceRow("snapshot", "📷 快照 @" + fmtAiMag(p.magnification) +
                               "　（点击跳转）");
      row.dataset.bbox = JSON.stringify(bb);
      return;
    }
    if (type === "observation") {
      clearThinkingRow();
      // 观察卡：标题（label）+ 正文（note），no_annotation_reason 显示为小字备注。
      // 不显示原始 JSON / h / snapshot_id（任务1：卡片化）。
      appendObservationCard(p);
      return;
    }
    if (type === "snapshot_reviewed") {
      clearThinkingRow();
      // 判读卡：一行简洁状态 + summary 副标题。不显示 snapshot_id/disposition 原文。
      var disp = p.disposition || "";
      var title = (disp === "annotated") ? "✓ 快照已判读（已标注）"
                : (disp === "no_annotation") ? "✓ 快照已判读（无需标注）"
                : "✓ 快照已判读";
      appendReviewCard(title, p.summary || "", disp === "no_annotation" ? (p.no_annotation_reason || "") : "");
      return;
    }
    if (type === "annotation_created") {
      clearThinkingRow();
      var aRow = appendTraceRow("annotation", "📌 AI 建议 · " + (p.label || "") +
                     (p.note ? "（" + p.note + "）" : "") +
                     " @(" + fmtNum(p.x) + "," + fmtNum(p.y) + "," + p.side_px + "px)");
      if (p.annotation_id) aRow.dataset.annotationId = p.annotation_id;
      if (aiTraceTarget) {
        // fork 无 create_annotation，但保险起见也挂 💬
      } else {
        attachForkBtn(aRow, p.annotation_id);
      }
      // 刷新标注层与面板，让 AI 标注出现在现有标注体系
      refreshCurrentAnnotations();
      loadAnnotationsIndex();
      return;
    }
    if (type === "session_compacted") {
      clearThinkingRow();
      if (p && p.reason === "context_length_exceeded") {
        appendTraceRow("info", "上下文已满，已压缩并继续");
      } else {
        appendTraceRow("info", "上下文已压缩，继续读片…");
      }
      return;
    }
    if (type === "agent_paused") {
      clearThinkingRow();
      appendTraceRow("paused", "已暂停，可继续（" + (p.summary || "") + "）");
      aiPaused = true;
      finishAiRun();
      return;
    }
    if (type === "agent_finished") {
      clearThinkingRow();
      appendTraceRow("finished", p.summary || "(完成)");
      redrawAnnoCanvas();
      finishAiRun();
      return;
    }
    if (type === "agent_retrying") {
      // 瞬时错误（网络抖动）退避重试：提示但不终止（区别于 agent_error）
      if (p && p.reason) appendTraceRow("info", "⟳ " + p.reason);
      return;
    }
    if (type === "agent_error") {
      clearThinkingRow();
      appendTraceRow("error", p.error || "出错");
      finishAiRun();
      return;
    }
  }

  // event_reset：事件缓冲已滚过客户端断点 → 清空轨迹，GET session 全量
  // transcript 重建轨迹，再继续接 live 流（§5.6 event_reset 语义）
  function handleAiEventReset(payload) {
    resetAiTrace();
    appendTraceRow("info", "对话历史过长，正在刷新到最新状态…");
    if (!aiSessionId) {
      toast("对话历史过长，已刷新到最新状态", "info");
      return;
    }
    apiFetch("/api/ai/session/" + encodeURIComponent(aiSessionId))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var s = data && data.session;
        var t = data && data.transcript;
        resetAiTrace();  // 清掉刷新期间追加的 live 行，以全量 transcript 为准
        if (t && t.length) {
          renderAiTranscript(t);
        } else {
          appendTraceRow("info", "对话历史过长，已刷新到最新状态");
        }
        if (s && s.last_event_seq != null) {
          aiLastSeq = Math.max(aiLastSeq, Number(s.last_event_seq) || 0);
        }
        toast("已刷新到最新状态", "success");
      })
      .catch(function () {
        appendTraceRow("info", "对话历史过长，已刷新到最新状态");
        toast("对话历史过长，已刷新到最新状态", "info");
      });
  }

  // 把 GET session 的脱敏 transcript（canonical messages）渲染成 SMS 聊天气泡。
  // user → 右气泡；assistant 文本 → 左气泡；tool 调用（goto/snapshot/annotation）
  // → 紧凑灰色系统行；image_ref → "📷 快照 @倍率"占位行（可点击跳 bbox）。
  // opts.emphasis: "main"（跑批，工具行多，文本气泡次要）/ "fork"（问答，气泡为主）。
  function renderAiTranscript(msgs, opts) {
    var target = (opts && opts.container) || els.aiTrace;
    opts = opts || {};
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i] || {};
      var role = m.role || "";
      var text = messageText(m);
      // system / spot_updated / spot_deleted 等 user-system 行：当作紧凑系统行
      var isSystem = (role === "system") ||
                     (role === "user" && (m.spot_updated || m.spot_deleted ||
                                          /^spot_(updated|deleted)/.test(text)));
      if (isSystem) {
        if (text) appendSysRow(target, truncateStr(text, 400));
        continue;
      }
      if (role === "user") {
        appendChatBubble(target, "user", text);
      } else if (role === "assistant") {
        // assistant 文本（无 tool_calls）→ 左气泡（fork 里是回答，main 里是总结）
        var tcs = m.tool_calls || [];
        if (text) {
          appendChatBubble(target, "assistant", text);
        }
        // tool_calls → 友好渲染（任务1：不再 dump 原始 JSON 参数）
        // mark_observation/complete_snapshot_review → 卡片；snapshot/goto/create_annotation → 简洁行
        for (var j = 0; j < tcs.length; j++) {
          var fn = tcs[j].function || {};
          var nm = fn.name || "";
          var args = parseToolArgs(fn.arguments);
          if (nm === "mark_observation") {
            appendObservationCard({
              label: args.label || "", note: args.note || "",
              no_annotation_reason: args.no_annotation_reason || "", bbox: {},
            }, target);
          } else if (nm === "complete_snapshot_review") {
            var disp = args.disposition || "";
            appendReviewCard(
              disp === "annotated" ? "✓ 快照已判读（已标注）"
              : disp === "no_annotation" ? "✓ 快照已判读（无需标注）"
              : "✓ 快照已判读",
              args.summary || "",
              disp === "no_annotation" ? (args.no_annotation_reason || "") : "",
              target);
          } else if (nm === "goto") {
            appendSysRow(target, "→ goto (" + fmtNum(args.x) + "," + fmtNum(args.y) +
              ") @ " + (args.level != null ? args.level : "?") +
              (args.reason ? " · " + args.reason : ""), "tool");
          } else if (nm === "create_annotation") {
            appendSysRow(target, "📌 " + (args.label || "AI 建议") +
              (args.note ? "（" + truncateStr(args.note, 80) + "）" : ""), "tool");
          } else if (nm === "snapshot") {
            // 不显示 out_w/out_h 原始参数（image_ref 占位行由后续 tool 结果渲染）
            appendSysRow(target, "📷 抓取快照…", "tool");
          } else if (nm === "finish") {
            // finish 的总结已在 assistant 文本气泡里，不重复
          } else {
            appendSysRow(target, "→ " + nm, "tool");
          }
        }
      } else if (role === "tool") {
        // tool 结果：含 image_ref 的渲染为 📷 快照行（可点跳 bbox）；纯文本结果
        // 中若含守卫拒绝信息（snapshot_id/pending），转成用户可读的紧凑行
        var imgRef = findImageRef(m);
        if (imgRef) {
          appendSnapshotPlaceholder(target, imgRef);
        }
        var resText = messageText(m);
        if (resText && !imgRef) {
          appendSysRow(target, "⇠ " + friendlyToolResult(resText), "tool");
        }
      }
    }
    target.scrollTop = target.scrollHeight;
  }

  function messageText(m) {
    var c = m.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      var out = [];
      for (var i = 0; i < c.length; i++) {
        var p = c[i] || {};
        if (p.type === "text" && p.text) out.push(p.text);
        else if (p.type === "image_ref" || p.type === "image_url") out.push("（图像）");
      }
      return out.join(" ");
    }
    return "";
  }

  // 取消息里第一个 image_ref（tool 结果的 snapshot 物化引用）
  function findImageRef(m) {
    var c = m.content;
    if (Array.isArray(c)) {
      for (var i = 0; i < c.length; i++) {
        var p = c[i] || {};
        if (p.type === "image_ref") return p;
      }
    }
    return null;
  }

  // SMS 气泡：side="user"（右，accent 底）/ "assistant"（左，灰底）
  function appendChatBubble(container, side, text) {
    if (!text) return;
    var empty = container.querySelector(".ai-trace-empty");
    if (empty) empty.remove();
    var row = document.createElement("div");
    row.className = "ai-chat-bubble " + side;
    row.textContent = text;
    container.appendChild(row);
    container.scrollTop = container.scrollHeight;
    return row;
  }

  // 紧凑系统行（灰色小字，工具调用 / tool 结果 / system / spot_*）
  function appendSysRow(container, text, sub) {
    if (!text) return null;
    var empty = container.querySelector(".ai-trace-empty");
    if (empty) empty.remove();
    var row = document.createElement("div");
    row.className = "ai-chat-sys" + (sub ? " " + sub : "");
    row.textContent = text;
    container.appendChild(row);
    container.scrollTop = container.scrollHeight;
    return row;
  }

  // image_ref 占位行："📷 快照 @倍率"，可点击跳转 bbox
  function appendSnapshotPlaceholder(container, imgRef) {
    var empty = container.querySelector(".ai-trace-empty");
    if (empty) empty.remove();
    var row = document.createElement("div");
    row.className = "ai-chat-sys snapshot";
    var mag = imgRef.magnification;
    var label = "📷 快照" + (mag ? " @" + fmtAiMag(mag) : "");
    row.textContent = label;
    row.title = "点击跳转到该区域";
    var src = imgRef.src;
    if (src && src.x != null && src.w) {
      row.dataset.bbox = JSON.stringify(src);
      row.style.cursor = "pointer";
      row.addEventListener("click", function () {
        try {
          var bb = JSON.parse(row.dataset.bbox || "{}");
          if (bb.x != null && viewer && viewer.viewport) {
            viewer.viewport.fitBounds(
              viewer.viewport.imageToViewportRectangle(bb.x, bb.y, bb.w, bb.h));
          }
        } catch (e) {}
      });
    }
    container.appendChild(row);
    container.scrollTop = container.scrollHeight;
    return row;
  }

  // 观察卡：标题（label）+ 正文（note）+ 可选的"未落标注"小字备注。
  // 不显示原始 JSON / h / snapshot_id（任务1：卡片化）。
  // container 默认主轨迹（live 流），恢复历史时由调用方传入。
  // live 流走 handleAiEvent（fork 时 aiTraceTarget 已被切到 fork 流）。
  function appendObservationCard(p, container) {
    var target = container || aiTraceTarget || els.aiTrace;
    var empty = target.querySelector(".ai-trace-empty");
    if (empty) empty.remove();
    var card = document.createElement("div");
    card.className = "ai-card observation";
    var title = document.createElement("div");
    title.className = "ai-card-title";
    title.textContent = "👁 " + (p.label || "观察");
    card.appendChild(title);
    if (p.note) {
      var body = document.createElement("div");
      body.className = "ai-card-body";
      body.textContent = p.note;
      card.appendChild(body);
    }
    var reason = p.no_annotation_reason;
    if (reason && String(reason).trim()) {
      var sub = document.createElement("div");
      sub.className = "ai-card-sub";
      sub.textContent = "未落标注：" + reason;
      card.appendChild(sub);
    }
    target.appendChild(card);
    target.scrollTop = target.scrollHeight;
    return card;
  }

  // 判读卡：一行状态 + 可选 summary 副标题 + 可选 reason 备注。
  function appendReviewCard(title, summary, reason, container) {
    var target = container || aiTraceTarget || els.aiTrace;
    var empty = target.querySelector(".ai-trace-empty");
    if (empty) empty.remove();
    var card = document.createElement("div");
    card.className = "ai-card review";
    var head = document.createElement("div");
    head.className = "ai-card-title";
    head.textContent = title;
    card.appendChild(head);
    if (summary) {
      var body = document.createElement("div");
      body.className = "ai-card-body";
      body.textContent = summary;
      card.appendChild(body);
    }
    if (reason && String(reason).trim()) {
      var sub = document.createElement("div");
      sub.className = "ai-card-sub";
      sub.textContent = "原因：" + reason;
      card.appendChild(sub);
    }
    target.appendChild(card);
    target.scrollTop = target.scrollHeight;
    return card;
  }

  // 解析 tool_call 的 arguments（OpenAI 为 JSON 字符串，已解析对象也兼容）
  function parseToolArgs(argsStr) {
    if (typeof argsStr === "string") {
      try { return JSON.parse(argsStr) || {}; } catch (e) { return {}; }
    }
    if (argsStr && typeof argsStr === "object") return argsStr;
    return {};
  }

  // 把 tool 结果文本里的内部细节（snapshot_id / tool_call_id / pending 措辞）
  // 转成用户可读，避免暴露 call_xxx 这类内部 id（任务1：守卫信息可读化）。
  function friendlyToolResult(text) {
    var t = String(text || "");
    // 含 tool_call_id（call_xxx）→ 抽象成"该操作未关联到当前快照"
    if (/call_[A-Za-z0-9]{6,}/.test(t) && /snapshot_id|pending|必须引用/.test(t)) {
      return "该观察未关联到当前快照，已忽略（请先抓取并消化快照）";
    }
    // 仅暴露 snapshot_id 的行也折叠
    t = t.replace(/snapshot_id[（(]?\s*[:：]?\s*call_[A-Za-z0-9]+[)）]?/gi, "");
    return truncateStr(t.trim(), 200);
  }

  function truncateStr(s, n) {
    s = String(s == null ? "" : s);
    if (s.length <= n) return s;
    return s.slice(0, n) + "…";
  }

  function fmtNum(v) {
    if (v == null) return "?";
    return Math.round(v);
  }

  // ---------- 轨迹流 DOM 辅助 ----------
  // container 默认主 AI 轨迹；传 container 则渲染到 fork 对话流
  function appendTraceRow(cls, text, container) {
    var target = container || els.aiTrace;
    // 清掉空提示
    var empty = target.querySelector(".ai-trace-empty");
    if (empty) empty.remove();
    var row = document.createElement("div");
    row.className = "ai-trace-row " + cls;
    row.textContent = text;
    if (cls === "snapshot") {
      row.style.cursor = "pointer";
      row.title = "点击跳转到该区域";
      row.addEventListener("click", function () {
        try {
          var bb = JSON.parse(row.dataset.bbox || "{}");
          if (bb.x != null && viewer && viewer.viewport) {
            viewer.viewport.fitBounds(
              viewer.viewport.imageToViewportRectangle(bb.x, bb.y, bb.w, bb.h));
          }
        } catch (e) {}
      });
    }
    target.appendChild(row);
    target.scrollTop = target.scrollHeight;
    return row;
  }

  function resetAiTrace() {
    els.aiTrace.innerHTML = "";
    aiOverlay = [];
    aiTextBubbleEl = null;
    redrawAnnoCanvas();
  }

  // 📌 行挂 💬 按钮：以该标注 fork 批注对话
  function attachForkBtn(row, annotationId) {
    if (!annotationId) return;
    var btn = document.createElement("button");
    btn.className = "ai-fork-btn";
    btn.textContent = "💬";
    btn.title = "就此标注提问";
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      openForkChat(annotationId, row);
    });
    row.appendChild(btn);
  }

  // 就地展开 fork 批注对话（标注面板内）
  function openForkChat(annotationId, anchorRow) {
    if (!state.slide) return;
    // 若已在标注面板内，就地展开；否则打开标注面板后滚动到该条
    var existing = $("fork-chat-" + annotationId);
    if (existing) {
      existing.style.display = existing.style.display === "none" ? "block" : "none";
      return;
    }
    var wrap = document.createElement("div");
    wrap.id = "fork-chat-" + annotationId;
    wrap.className = "fork-chat";
    var head = document.createElement("div");
    head.className = "fork-chat-head";
    head.textContent = "💬 批注对话";
    var close = document.createElement("button");
    close.className = "icon-btn close";
    close.textContent = "×";
    close.addEventListener("click", function () { wrap.style.display = "none"; });
    head.appendChild(close);
    var stream = document.createElement("div");
    stream.className = "fork-chat-stream";
    stream.innerHTML = '<div class="ai-trace-empty">就此标注提问…</div>';
    var inputRow = document.createElement("div");
    inputRow.className = "fork-chat-input";
    var input = document.createElement("input");
    input.type = "text";
    input.placeholder = "问：这个区域是什么？";
    var send = document.createElement("button");
    send.className = "btn primary small";
    send.textContent = "发送";
    send.addEventListener("click", function () {
      sendForkQuestion(annotationId, input.value, stream, wrap);
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") sendForkQuestion(annotationId, input.value, stream, wrap);
    });
    inputRow.appendChild(input);
    inputRow.appendChild(send);
    wrap.appendChild(head);
    wrap.appendChild(stream);
    wrap.appendChild(inputRow);
    // 挂载：若 anchor 是标注面板行，插到其后；否则插到面板列表顶部
    var panelList = els.annoPanelList;
    if (anchorRow && anchorRow.parentNode) {
      anchorRow.parentNode.insertBefore(wrap, anchorRow.nextSibling);
    } else if (panelList) {
      panelList.insertBefore(wrap, panelList.firstChild);
    } else {
      document.body.appendChild(wrap);
    }
    input.focus();
    // 恢复历史（#1）：若此标注已有 fork 会话，渲染完整 SMS 式对话记录
    restoreForkTranscript(annotationId, stream);
  }

  // 查找该标注已有的 fork 会话并渲染历史 transcript（fork 打开时）
  function restoreForkTranscript(annotationId, streamEl) {
    if (!state.slide || !annotationId || !streamEl) return;
    apiFetch("/api/ai/sessions?slide=" + encodeURIComponent(state.slide.name))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var sessions = (data && data.sessions) || [];
        var fork = null;
        for (var i = 0; i < sessions.length; i++) {
          if (sessions[i].kind === "fork" && sessions[i].annotation_id === annotationId) {
            fork = sessions[i]; break;
          }
        }
        if (!fork) return;  // 无历史，保留"就此标注提问…"
        loadAndRenderTranscript(fork.id, streamEl, { emphasis: "fork" });
      })
      .catch(function () { /* 静默：渲染失败不影响提问 */ });
  }

  function sendForkQuestion(annotationId, question, streamEl, wrapEl) {
    question = (question || "").trim();
    if (!question) return;
    appendTraceRow("fork-q", "🙋 " + question, streamEl);
    var input = wrapEl ? wrapEl.querySelector("input") : null;
    if (input) input.value = "";
    appendTraceRow("fork-wait", "思考中…", streamEl);
    fetch("/api/ai/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slide: state.slide.name, annotation_id: annotationId, question: question }),
      credentials: "same-origin",
    }).then(function (resp) {
      if (resp.status === 410) {
        appendTraceRow("fork-err", "该标注已删除，对话已归档（只读）", streamEl);
        if (wrapEl) wrapEl.classList.add("fork-readonly");
        throw new Error("gone");
      }
      if (!resp.ok || !resp.body) {
        return resp.text().then(function (t) { throw new Error(t || ("HTTP " + resp.status)); });
      }
      // 流入 fork 对话流
      aiTraceTarget = streamEl;
      return pumpForkSse(resp.body.getReader(), streamEl, wrapEl);
    }).catch(function (e) {
      if (e && e.message === "gone") return;
      appendTraceRow("fork-err", "发送失败: " + (e && e.message ? e.message : e), streamEl);
    });
  }

  function pumpForkSse(reader, streamEl, wrapEl) {
    var decoder = new TextDecoder("utf-8");
    var buffer = "";
    function pump() {
      return reader.read().then(function (result) {
        if (result.done) { aiTraceTarget = null; return; }
        buffer += decoder.decode(result.value, { stream: true });
        var idx;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          var frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          var type = null, dataStr = "";
          frame.split("\n").forEach(function (line) {
            if (line.indexOf(":") === 0) return;
            if (line.indexOf("event:") === 0) type = line.slice(6).trim();
            else if (line.indexOf("data:") === 0) dataStr += line.slice(5).trim();
          });
          if (type === "session_ended") { aiTraceTarget = null; continue; }
          var payload = {};
          if (dataStr) { try { payload = JSON.parse(dataStr); } catch (e) {} }
          handleForkEvent(type, payload, streamEl, wrapEl);
        }
        return pump();
      });
    }
    return pump();
  }

  function handleForkEvent(type, p, streamEl, wrapEl) {
    // 复用主轨迹渲染，但把追加目标切到 fork 流
    var prev = aiTraceTarget;
    aiTraceTarget = streamEl;
    if (type === "agent_thinking") { setThinkingRowFork(streamEl); aiTraceTarget = prev; return; }
    if (type === "text_delta") { appendTextBubbleFork(p.text || "", streamEl); aiTraceTarget = prev; return; }
    handleAiEvent(type, p);
    aiTraceTarget = prev;
    // 收尾清理
    if (type === "agent_paused" || type === "agent_finished" || type === "agent_error") {
      var waits = streamEl.querySelectorAll(".ai-trace-row.fork-wait, .ai-trace-row.thinking");
      waits.forEach(function (w) { if (w.parentNode) w.parentNode.removeChild(w); });
    }
  }

  var forkBubbleEl = null;
  function appendTextBubbleFork(text, streamEl) {
    if (!forkBubbleEl || forkBubbleEl.closed || forkBubbleEl.parentNode !== streamEl) {
      forkBubbleEl = document.createElement("div");
      forkBubbleEl.className = "ai-trace-row bubble fork-ai";
      forkBubbleEl.textContent = "";
      forkBubbleEl.closed = false;
      streamEl.appendChild(forkBubbleEl);
    }
    forkBubbleEl.textContent += text;
    streamEl.scrollTop = streamEl.scrollHeight;
  }

  var forkThinkingEl = null;
  function setThinkingRowFork(streamEl) {
    if (forkThinkingEl && forkThinkingEl.parentNode === streamEl) return;
    forkThinkingEl = document.createElement("div");
    forkThinkingEl.className = "ai-trace-row thinking";
    forkThinkingEl.textContent = "思考中…";
    streamEl.appendChild(forkThinkingEl);
    streamEl.scrollTop = streamEl.scrollHeight;
  }

  function appendTextBubble(text) {
    // 增量 append 到当前气泡（若无则新建）
    if (!aiTextBubbleEl || aiTextBubbleEl.closed) {
      aiTextBubbleEl = document.createElement("div");
      aiTextBubbleEl.className = "ai-trace-row bubble";
      aiTextBubbleEl.textContent = "";
      aiTextBubbleEl.closed = false;
      els.aiTrace.appendChild(aiTextBubbleEl);
    }
    aiTextBubbleEl.textContent += text;
    els.aiTrace.scrollTop = els.aiTrace.scrollHeight;
  }

  var thinkingRowEl = null;
  function setThinkingRow() {
    var target = aiTraceTarget || els.aiTrace;
    if (thinkingRowEl && thinkingRowEl.parentNode === target) return;
    var empty = target.querySelector(".ai-trace-empty");
    if (empty) empty.remove();
    thinkingRowEl = document.createElement("div");
    thinkingRowEl.className = "ai-trace-row thinking";
    thinkingRowEl.textContent = "思考中…";
    target.appendChild(thinkingRowEl);
    target.scrollTop = target.scrollHeight;
  }
  function clearThinkingRow() {
    if (thinkingRowEl && thinkingRowEl.parentNode) {
      thinkingRowEl.parentNode.removeChild(thinkingRowEl);
    }
    thinkingRowEl = null;
    // 关闭当前 text 气泡：下一段 text_delta 会新建一个
    if (aiTextBubbleEl) { aiTextBubbleEl.closed = true; }
  }

  // ---------- 启动 ----------
  function init() {
    initViewer();
    bindEvents();
    setupDragDrop();
    initAuth();
    // 初始折叠区状态（默认展开）
    var unfiledSec = els.unfiledBody.closest(".section");
    var shareSec = els.shareMgrBody.closest(".section");
    if (unfiledSec) unfiledSec.classList.remove("collapsed");
    if (shareSec) shareSec.classList.remove("collapsed");
    loadAll();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
