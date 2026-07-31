/* =========================================================================
   切片分享页 —— 前端逻辑（OpenSeadragon + ROI + 选区保存）
   ========================================================================= */
(function () {
  "use strict";

  // ---------- token 与 API 前缀 ----------
  // token 从 location.pathname（/s/<token>）解析
  var TOKEN = window.__SHARE_TOKEN__ || "";
  if (!TOKEN) {
    var m = location.pathname.match(/\/s\/([^/]+)/);
    if (m) TOKEN = decodeURIComponent(m[1]);
  }
  var API = "/s/" + encodeURIComponent(TOKEN);

  // ---------- 全局状态 ----------
  var state = {
    slides: [],          // 该分享的切片集
    slide: null,         // 当前切片
    mppX: null,
    roiMode: null,
    roi: { x: 0, y: 0, side: 0 },
    rotation: 0,
    flipped: false,      // 是否水平翻转（镜像）
    drawMode: null,      // null | "arrow" | "freehand"（与 roiMode 互斥）
    showAnno: true,      // 默认始终显示（用户需要看到管理员标记）
    roiSizes: [6, 6.5],  // 本次分享允许的矩形标记尺寸（fetch config 后填充）
  };

  var viewer = null;
  var roiBox = null;
  var dragInfo = null;
  // 底图缩略图层：铺在瓦片层后面的模糊预览，慢网下避免瓦片未到区域变白
  var baseThumbEl = null;
  // 当前切片的标注（本 token + 管理员），扁平数组
  var currentRois = [];

  // 编辑模式状态：选中/拖动
  // editItem：当前选中的标注（currentRois 中的引用副本，可改本地几何）
  // editDrag：拖动会话 {handle, pointerId, ...起点快照}
  var editItem = null;
  var editDrag = null;

  // ---------- DOM ----------
  function $(id) { return document.getElementById(id); }
  var els = {
    invalidMask: $("invalid-mask"),
    currentSlide: $("current-slide"),
    slideChips: $("slide-chips"),
    zoomIn: $("zoom-in"),
    zoomOut: $("zoom-out"),
    rotateBtn: $("rotate-btn"),
    flipBtn: $("flip-btn"),
    roi6: $("roi-6"),
    roi65: $("roi-6-5"),
    saveRoiBtn: $("save-roi-btn"),
    exportBtn: $("export-btn"),
    resetBtn: $("reset-btn"),
    mppSetter: $("mpp-setter"),
    mppInput: $("mpp-input"),
    mppSetBtn: $("mpp-set-btn"),
    zoomBadge: $("zoom-badge"),
    roiLabel: $("roi-label"),
    panelToggle: $("roi-panel-toggle"),
    panel: $("roi-panel"),
    panelMask: $("roi-panel-mask"),
    panelClose: $("roi-panel-close"),
    panelList: $("roi-panel-list"),
    annoArrowBtn: $("anno-arrow-btn"),
    annoFreeBtn: $("anno-free-btn"),
    annoAllBtn: $("anno-all-btn"),
    annoCanvas: $("anno-canvas"),
    toastContainer: $("toast-container"),
    roiNote: $("roi-note"),
    panelEdit: $("roi-panel-edit"),
  };

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

  function clamp(v, lo, hi) {
    if (hi < lo) hi = lo;
    return Math.max(lo, Math.min(hi, v));
  }

  // label -> 颜色（哈希着色）
  function labelColor(label) {
    var s = String(label || "");
    var h = 0;
    for (var i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) >>> 0;
    }
    var hue = h % 360;
    return { fill: "hsla(" + hue + ",70%,55%,0.12)", stroke: "hsl(" + hue + ",70%,45%)" };
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
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
    viewer.addHandler("open", function () {
      updateZoomBadge(); syncBaseThumb();
      exitDrawMode();
      resizeAnnoCanvas();
      // 打开后加载标注并重绘
      loadCurrentRois();
    });
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

  function updateZoomBadge() {
    try {
      if (!viewer || !viewer.viewport || !viewer.source) {
        els.zoomBadge.textContent = "100%";
        return;
      }
      var zoom = viewer.viewport.getZoom(true);
      var containerW = viewer.viewport.getContainerSize().x;
      var imgW = viewer.source.dimensions.x;
      // 真实图像缩放 = 视口缩放 × 容器宽 / 图像宽（100% = 1 图像像素对应 1 屏幕像素）
      var imageZoom = (zoom * containerW) / imgW;
      els.zoomBadge.textContent = Math.round(imageZoom * 100) + "%";
    } catch (e) {
      els.zoomBadge.textContent = "100%";
    }
  }

  // ---------- 加载切片集 ----------
  function loadSlides() {
    fetch(API + "/api/slides")
      .then(function (r) {
        if (r.status === 404) { showInvalid(); throw new Error("invalid"); }
        return r.json();
      })
      .then(function (slides) {
        state.slides = slides || [];
        renderChips();
        if (state.slides.length === 0) {
          els.currentSlide.textContent = "无可用切片";
          return;
        }
        openSlide(state.slides[0].name);
      })
      .catch(function (e) {
        if (e.message !== "invalid") toast("加载切片失败: " + e, "error");
      });
  }

  function showInvalid() {
    els.invalidMask.style.display = "flex";
  }

  // 拉取本次分享配置（矩形标记允许尺寸），再据此渲染工具栏按钮可用性
  function loadConfig() {
    return fetch(API + "/api/config")
      .then(function (r) {
        if (!r.ok) throw new Error("config " + r.status);
        return r.json();
      })
      .then(function (cfg) {
        var sizes = cfg && cfg.roi_sizes;
        if (sizes && sizes.length) {
          state.roiSizes = sizes.map(function (s) { return Number(s); });
        }
      })
      .catch(function () {
        // 失败时保持默认（两者皆可）
      })
      .then(function () { applyRoiSizeRestriction(); });
  }

  // 根据允许尺寸禁用/启用 ROI 分段按钮；若当前 roiMode 被禁则退出 ROI
  function applyRoiSizeRestriction() {
    var allowed = {};
    state.roiSizes.forEach(function (s) { allowed[Number(s)] = true; });
    function setBtn(btn, sizeKey) {
      var ok = !!allowed[sizeKey];
      btn.disabled = !ok;
      btn.title = ok ? "" : "本次分享不允许该尺寸";
      btn.classList.toggle("disabled", !ok);
    }
    setBtn(els.roi6, 6);
    setBtn(els.roi65, 6.5);
    // 若当前 roiMode 被禁则退出 ROI 模式
    if (state.roiMode != null && !allowed[state.roiMode]) {
      exitRoi();
    }
  }

  function renderChips() {
    if (state.slides.length <= 1) {
      els.slideChips.style.display = "none";
      return;
    }
    els.slideChips.style.display = "flex";
    els.slideChips.innerHTML = "";
    state.slides.forEach(function (s) {
      var chip = document.createElement("div");
      chip.className = "chip";
      var display = s.alias || s.name;
      chip.textContent = display;
      chip.title = (s.alias ? s.alias + " (" + s.name + ")" : s.name) + (s.error ? "（读取失败）" : "");
      chip.dataset.name = s.name;
      if (state.slide && state.slide.name === s.name) {
        chip.classList.add("active");
      }
      chip.addEventListener("click", function () { openSlide(s.name); });
      els.slideChips.appendChild(chip);
    });
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
    var info = null;
    for (var i = 0; i < state.slides.length; i++) {
      if (state.slides[i].name === name) { info = state.slides[i]; break; }
    }
    if (!info) { toast("切片不在分享中", "error"); return; }
    if (info.error || !info.width) {
      toast("切片无法读取: " + (info.error || "未知错误"), "error");
      return;
    }

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

    // 高亮 chip
    var chips = els.slideChips.querySelectorAll(".chip");
    chips.forEach(function (c) {
      c.classList.toggle("active", c.dataset.name === name);
    });

    // 创建底图缩略图层：铺在瓦片 canvas 之前（下层），慢网下透出模糊预览
    baseThumbEl = document.createElement("img");
    baseThumbEl.className = "osd-base-thumb";
    baseThumbEl.src = API + "/api/slide/" + encodeURIComponent(name) + "/thumbnail";
    baseThumbEl.alt = "";
    viewer.container.insertBefore(baseThumbEl, viewer.canvas);
    applyBaseThumbFlip();

    viewer.open(API + "/api/slide/" + encodeURIComponent(name) + ".dzi");
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
    // 本次分享不允许该尺寸 → 直接拒绝（按钮亦为禁用态）
    var allowed = {};
    state.roiSizes.forEach(function (s) { allowed[Number(s)] = true; });
    if (!allowed[Number(sizeMm)]) {
      toast("本次分享不允许 " + sizeMm + "mm 标记", "info");
      return;
    }
    if (!state.mppX || state.mppX <= 0) {
      toast("缺少 mpp（µm/px），请先在工具栏设置 mpp", "error");
      return;
    }
    if (state.slide.mppSource === "estimated") {
      toast("提示：当前 mpp 为估算值，ROI 尺寸仅供参考", "info");
    }
    // 进入 ROI 模式时退出箭头/描图绘制模式（互斥）
    exitDrawMode();
    if (state.roiMode === sizeMm) { exitRoi(); return; }

    var newSide = roiSide(sizeMm);
    if (newSide <= 0) { toast("ROI 尺寸计算失败", "error"); return; }

    var W0 = state.slide.width, H0 = state.slide.height;
    if (newSide > W0 || newSide > H0) {
      var physW = (W0 * state.mppX / 1000).toFixed(1);
      var physH = (H0 * state.mppX / 1000).toFixed(1);
      toast("注意：整张图像仅约 " + physW + "×" + physH + " mm，" +
            sizeMm + "mm 选区已超出图像范围", "info");
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
    els.saveRoiBtn.disabled = false;
    els.exportBtn.disabled = false;
  }

  function exitRoi() {
    state.roiMode = null;
    if (roiBox && viewer && viewer.currentOverlays) {
      try { viewer.removeOverlay(roiBox); } catch (e) {}
    }
    if (roiBox && roiBox.parentNode) {
      roiBox.parentNode.removeChild(roiBox);
    }
    roiBox = null;
    updateRoiButtons();
    els.saveRoiBtn.disabled = true;
    els.exportBtn.disabled = true;
  }

  function updateRoiButtons() {
    els.roi6.classList.toggle("active", state.roiMode === 6);
    els.roi65.classList.toggle("active", state.roiMode === 6.5);
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
    if (label) label.textContent = state.roiMode + "mm × " + state.roiMode + "mm";

    var rect = viewer.viewport.imageToViewportRectangle(r.x, r.y, r.side, r.side);
    var existing = viewer.getOverlayById(roiBox);
    if (existing) {
      viewer.updateOverlay(roiBox, rect, OpenSeadragon.Placement.TOP_LEFT);
    } else {
      var opts = {
        element: roiBox,
        location: rect,
        placement: OpenSeadragon.Placement.TOP_LEFT,
      };
      if (state.rotation % 360 !== 0 &&
          OpenSeadragon.OverlayRotationMode &&
          OpenSeadragon.OverlayRotationMode.BOUNDING_BOX) {
        opts.rotationMode = OpenSeadragon.OverlayRotationMode.BOUNDING_BOX;
      }
      viewer.addOverlay(opts);
    }
  }

  // 用指定的图像坐标重建 ROI 框（跳转账使用）
  function rebuildRoi(x, y, side, sizeMm) {
    if (!state.slide) return;
    state.roiMode = sizeMm;
    state.roi.x = Math.round(x);
    state.roi.y = Math.round(y);
    state.roi.side = Math.round(side);
    createRoiBox();
    updateRoiOverlay();
    updateRoiButtons();
    els.saveRoiBtn.disabled = false;
    els.exportBtn.disabled = false;
  }

  // ---------- ROI 拖拽 ----------
  function onRoiPointerDown(e) {
    if (!state.slide) return;
    e.preventDefault();
    e.stopPropagation();
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
    e.preventDefault();
    e.stopPropagation();
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
    e.preventDefault();
    e.stopPropagation();
    try { roiBox.releasePointerCapture(dragInfo.pointerId); } catch (err) {}
    roiBox.removeEventListener("pointermove", onRoiPointerMove);
    roiBox.removeEventListener("pointerup", onRoiPointerUp);
    roiBox.removeEventListener("pointercancel", onRoiPointerUp);
    dragInfo = null;
    viewer.setMouseNavEnabled(true);
  }

  function getViewerRect() {
    return viewer.container.getBoundingClientRect();
  }

  // ---------- 保存选区（rect ROI） ----------
  function saveRoi() {
    if (!state.slide || state.roiMode == null) return;
    // label 必填校验
    var label = (els.roiLabel.value || "").trim();
    if (!label) {
      toast("请填写标记人或标签", "error");
      try { els.roiLabel.focus(); } catch (e) {}
      return;
    }
    var r = state.roi;
    fetch(API + "/api/roi", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slide: state.slide.name,
        type: "rect",
        x: Math.round(r.x),
        y: Math.round(r.y),
        size_mm: state.roiMode,
        side_px: Math.round(r.side),
        label: label,
        note: (els.roiNote ? els.roiNote.value : "") || "",
      }),
    })
      .then(function (res) {
        if (!res.ok) {
          return res.json().then(function (j) {
            throw new Error(j.error || ("保存失败 " + res.status));
          });
        }
        return res.json();
      })
      .then(function () {
        toast("选区已保存", "success");
        refreshRoisOnce();
      })
      .catch(function (e) { toast("保存失败: " + e.message, "error"); });
  }

  // ---------- 导出图片（裁剪） ----------
  function exportCrop() {
    if (!state.slide || state.roiMode == null) return;
    var r = state.roi;
    var name = state.slide.name;
    var url = API + "/api/slide/" + encodeURIComponent(name) +
      "/crop?x=" + Math.round(r.x) + "&y=" + Math.round(r.y) +
      "&size=" + Math.round(r.side);

    var originalText = els.exportBtn.textContent;
    els.exportBtn.textContent = "导出中...";
    els.exportBtn.disabled = true;

    fetch(url)
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
        a.href = objUrl;
        a.download = fname;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(objUrl); }, 1000);
        toast("已导出: " + fname, "success");
      })
      .catch(function (e) { toast("导出失败: " + e.message, "error"); })
      .finally(function () {
        els.exportBtn.textContent = originalText;
        els.exportBtn.disabled = state.roiMode == null;
      });
  }

  // ---------- 手动设置 mpp ----------
  function setMpp() {
    var v = parseFloat(els.mppInput.value);
    if (!isFinite(v) || v <= 0) { toast("请输入有效的 mpp 数值", "error"); return; }
    state.mppX = v;
    if (state.slide) {
      state.slide.mppX = v;
      state.slide.mppSource = "manual";
    }
    if (state.roiMode != null) {
      var newSide = roiSide(state.roiMode);
      var W = state.slide.width, H = state.slide.height;
      var cx = state.roi.x + state.roi.side / 2;
      var cy = state.roi.y + state.roi.side / 2;
      var x = clamp(cx - newSide / 2, 0, Math.max(0, W - newSide));
      var y = clamp(cy - newSide / 2, 0, Math.max(0, H - newSide));
      state.roi.x = Math.round(x);
      state.roi.y = Math.round(y);
      state.roi.side = newSide;
      updateRoiOverlay();
    }
    updateMppSetterVisibility();
    toast("mpp 已设为 " + v + " µm/px", "success");
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

  function imgToCanvas(ix, iy) {
    if (!viewer || !viewer.viewport) return { x: 0, y: 0 };
    var p = viewer.viewport.imageToViewerElementCoordinates(
      new OpenSeadragon.Point(ix, iy));
    return { x: p.x, y: p.y };
  }

  function redrawAnnoCanvas() {
    var c = els.annoCanvas;
    if (!c || !annoCtx) { if (c) resizeAnnoCanvas(); }
    if (!annoCtx) return;
    var rect = viewer ? viewer.container.getBoundingClientRect() : { width: c.clientWidth, height: c.clientHeight };
    annoCtx.clearRect(0, 0, rect.width, rect.height);
    if (!state.showAnno && state.drawMode == null) return;
    if (!state.slide) return;
    // 性能：缩放/平移动画期间省略文本（标签/气泡）只画矢量，
    // 动画结束（animation-finish）再补全，避免每帧逐条 measureText/fillText
    var animating = !!(viewer && viewer.viewport &&
      typeof viewer.viewport.isAnimating === "function" && viewer.viewport.isAnimating());
    // 拖动编辑中只保留选中项的气泡，其余气泡暂停（视图静止时减少文本重绘）
    var dragging = !!(editDrag && editItem);
    // 已保存标注
    if (state.showAnno) {
      currentRois.forEach(function (it) {
        var selected = (editItem === it);
        drawAnnoItem(it, labelColor(it.label), selected, !animating);
      });
    }
    // 编辑手柄（选中项且可编辑）
    if (editItem && isEditable(editItem) && state.showAnno) {
      drawEditHandles(editItem);
    }
    // 绘制中预览
    if (state.drawMode === "arrow" && drawPreview && drawPreview.type === "arrow") {
      drawArrow(drawPreview.x1, drawPreview.y1, drawPreview.x2, drawPreview.y2, "#FFD700", "预览");
    }
    if (state.drawMode === "freehand" && drawPreview && drawPreview.type === "freehand" && drawPreview.points.length >= 2) {
      drawFreehand(drawPreview.points, { fill: "rgba(255,215,0,0.12)", stroke: "#FFD700" }, "预览");
    }
    // 备注气泡（在标注与手柄之上；动画/拖动期间按需精简）
    if (state.showAnno && !animating) {
      currentRois.forEach(function (it) {
        if (dragging && it !== editItem) return; // 拖动中只画选中项气泡
        var note = String(it.note || "");
        if (!note) return;
        var selected = (editItem === it);
        drawNoteBubble(it, note, selected);
      });
    }
  }

  // 绘制编辑手柄（方块/圆点）
  function drawEditHandles(it) {
    var typ = it.type || "rect";
    var hs = editHandles(it);
    annoCtx.fillStyle = "#fff";
    annoCtx.strokeStyle = "#007AFF";
    annoCtx.lineWidth = 2;
    hs.forEach(function (h) {
      // mid 类（整体平移）用圆形，其余用方块
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
    if (typ === "rect") {
      var tl = imgToCanvas(it.x, it.y);
      var br = imgToCanvas(it.x + it.side_px, it.y + it.side_px);
      var w = Math.abs(br.x - tl.x), h = Math.abs(br.y - tl.y);
      var x = Math.min(tl.x, br.x), y = Math.min(tl.y, br.y);
      // 选中高亮：先画一层加粗蓝边
      if (hlStroke) {
        annoCtx.lineWidth = 6;
        annoCtx.strokeStyle = hlStroke;
        annoCtx.strokeRect(x, y, w, h);
      }
      annoCtx.lineWidth = 3;
      annoCtx.strokeStyle = "#FFD700";
      annoCtx.strokeRect(x, y, w, h);
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

  function drawLabel(label, x, y, sizeText, strokeColor) {
    var text = String(label || "");
    if (sizeText) text = (text ? text + " · " : "") + sizeText;
    if (!text) return;
    annoCtx.font = "600 11px " + "-apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif";
    var padX = 5;
    var m = annoCtx.measureText(text);
    var w = m.width + padX * 2;
    var h = 16;
    var bx = x, by = y - h - 2;
    annoCtx.fillStyle = (strokeColor && strokeColor !== "#FFD700") ? strokeColor : "#FFD700";
    annoCtx.fillRect(bx, by, w, h);
    annoCtx.fillStyle = (strokeColor && strokeColor !== "#FFD700") ? "#fff" : "#5a3500";
    annoCtx.textBaseline = "middle";
    annoCtx.fillText(text, bx + padX, by + h / 2 + 0.5);
  }

  // ---------- 备注气泡（macOS callout 风格） ----------
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

  // 文本折行：按 maxWidth 切分，支持显式 \n
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

  // 取标注锚点（屏幕坐标）+ 标记 bbox 最短边
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
    // 缩放阈值：标记屏幕 bbox 最短边 < 24px 不画气泡（太挤）
    if (anchor.minSide < 24) return;
    var c = els.annoCanvas;
    var canvasW = c.clientWidth, canvasH = c.clientHeight;

    // 布局走缓存（避免每帧逐字符 measureText）
    var layout = bubbleLayout(note);
    var lines = layout.lines;
    var boxW = layout.boxW, boxH = layout.boxH;
    var padX = 8, padY = 6, lineH = 15;

    // 默认位置：锚点正上方
    var cx = anchor.x;
    var above = true;
    var boxX = cx - boxW / 2;
    var boxY = anchor.y - 8 - boxH;  // 上方，留 8px 给三角

    // 边界处理：上方不够 → 翻到下方
    if (boxY < 4) {
      above = false;
      boxY = anchor.y + 10;
    }
    // 左右溢出 → 平移到内侧
    if (boxX < 4) boxX = 4;
    if (boxX + boxW > canvasW - 4) boxX = canvasW - 4 - boxW;
    // 下方溢出 → 限制
    if (boxY + boxH > canvasH - 4) {
      boxY = Math.max(4, canvasH - 4 - boxH);
    }

    var borderColor = selected ? "#007AFF" : "rgba(0,0,0,0.15)";
    // 三角引线
    var triSize = 6;
    var triTipX = cx;
    annoCtx.fillStyle = "rgba(0,0,0,0.15)";
    annoCtx.strokeStyle = borderColor;
    annoCtx.lineWidth = 1;
    annoCtx.save();
    annoCtx.globalAlpha = 0.85;
    annoCtx.fillStyle = "#ffffff";
    roundRect(annoCtx, boxX, boxY, boxW, boxH, 8);
    annoCtx.fill();
    annoCtx.globalAlpha = 1;
    annoCtx.stroke();
    annoCtx.restore();

    // 三角（指向锚点）：根据 above 决定朝向
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
    // 三角朝锚点的那条边不描边（用白线盖掉）
    annoCtx.stroke();
    annoCtx.restore();

    // 文字
    annoCtx.fillStyle = "#333";
    annoCtx.font = "12px " + "-apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif";
    annoCtx.textBaseline = "top";
    lines.forEach(function (ln, i) {
      annoCtx.fillText(ln, boxX + padX, boxY + padY + i * lineH);
    });
  }

  // ---------- 显示/隐藏标记（默认开） ----------
  function toggleAnnoAll() {
    state.showAnno = !state.showAnno;
    els.annoAllBtn.classList.toggle("active", state.showAnno);
    redrawAnnoCanvas();
  }

  // =========================================================================
  // 编辑模式：非绘制模式下点击标注画布层，命中检测 + 选中 + 拖动手柄
  // =========================================================================
  // 点到线段距离（屏幕坐标）
  function pointSegDist(px, py, x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1;
    var len2 = dx * dx + dy * dy;
    if (len2 <= 0) return Math.hypot(px - x1, py - y1);
    var t = ((px - x1) * dx + (py - y1) * dy) / len2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  // 射线法判断点是否在多边形内（屏幕坐标）
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

  // 命中检测：屏幕坐标 → 命中的 currentRois 项（倒序遍历，取最上层）
  // 返回命中的 item（currentRois 中的原始对象）或 null
  function hitAnno(sx, sy) {
    for (var i = currentRois.length - 1; i >= 0; i--) {
      var it = currentRois[i];
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

  // 判断某 item 是否可编辑（分享端仅 source===me 可编辑）
  function isEditable(it) {
    return it && it.source === "me";
  }

  // 取编辑手柄列表（屏幕坐标）。rect：4角+4边中点；arrow：两端点；freehand：bbox 4角
  // 返回 [{id, x, y}]；仅可编辑项返回手柄，否则空（只读选中无手柄）
  function editHandles(it) {
    if (!isEditable(it)) return [];
    var typ = it.type || "rect";
    var out = [];
    if (typ === "rect") {
      var tl = imgToCanvas(it.x, it.y);
      var br = imgToCanvas(it.x + it.side_px, it.y + it.side_px);
      var x = Math.min(tl.x, br.x), y = Math.min(tl.y, br.y);
      var w = Math.abs(br.x - tl.x), h = Math.abs(br.y - tl.y);
      out = [
        { id: "tl", x: x, y: y },
        { id: "t", x: x + w / 2, y: y },
        { id: "tr", x: x + w, y: y },
        { id: "r", x: x + w, y: y + h / 2 },
        { id: "br", x: x + w, y: y + h },
        { id: "b", x: x + w / 2, y: y + h },
        { id: "bl", x: x, y: y + h },
        { id: "l", x: x, y: y + h / 2 },
      ];
    } else if (typ === "arrow") {
      var a = imgToCanvas(it.x1, it.y1), b = imgToCanvas(it.x2, it.y2);
      out = [
        { id: "p1", x: a.x, y: a.y },
        { id: "p2", x: b.x, y: b.y },
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
        { id: "ftl", x: x2, y: y2 },
        { id: "ftr", x: x2 + w2, y: y2 },
        { id: "fbr", x: x2 + w2, y: y2 + h2 },
        { id: "fbl", x: x2, y: y2 + h2 },
        { id: "fmid", x: x2 + w2 / 2, y: y2 + h2 / 2 },
      ];
    }
    return out;
  }

  // 命中手柄：返回 handle id 或 null（容差 8px）
  function hitHandle(sx, sy, it) {
    var hs = editHandles(it);
    for (var i = 0; i < hs.length; i++) {
      if (Math.hypot(sx - hs[i].x, sy - hs[i].y) <= 8) return hs[i].id;
    }
    return null;
  }

  // 选中标注：设置 editItem，打开编辑卡（可编辑时），重绘
  function selectEditItem(it) {
    editItem = it;
    redrawAnnoCanvas();
    if (isEditable(it)) {
      openEditCard(it);
    } else {
      closeEditCard();
    }
  }

  function clearEditItem() {
    editItem = null;
    closeEditCard();
    redrawAnnoCanvas();
  }

  // 编辑卡：选区面板顶部，备注 textarea + 保存/取消/删除
  function openEditCard(it) {
    // 面板未开时自动打开
    if (els.panel.style.display === "none") {
      els.panel.style.display = "flex";
      if (els.panelMask) els.panelMask.style.display = "block";
      loadRoiPanel();
    }
    if (!els.panelEdit) return;
    var typ = it.type || "rect";
    var titleText = typ === "arrow" ? "编辑箭头" : (typ === "freehand" ? "编辑描图" : "编辑选区");
    els.panelEdit.innerHTML = "";
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
    var saveB = document.createElement("button");
    saveB.className = "aec-btn primary"; saveB.textContent = "保存";
    var cancelB = document.createElement("button");
    cancelB.className = "aec-btn"; cancelB.textContent = "取消";
    var delB = document.createElement("button");
    delB.className = "aec-btn danger"; delB.textContent = "删除";
    ops.appendChild(delB); ops.appendChild(cancelB); ops.appendChild(saveB);
    card.appendChild(ops);
    els.panelEdit.appendChild(card);
    els.panelEdit.style.display = "block";

    saveB.addEventListener("click", function () { commitEdit(it, ta.value); });
    cancelB.addEventListener("click", function () { cancelEdit(it); });
    delB.addEventListener("click", function () {
      delB.disabled = true;
      deleteRoi(it.index);
    });
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitEdit(it, ta.value); }
    });
  }

  function closeEditCard() {
    if (els.panelEdit) { els.panelEdit.innerHTML = ""; els.panelEdit.style.display = "none"; }
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

  // 提交编辑：PATCH geom + note
  function commitEdit(it, noteVal) {
    var geom = buildEditGeom(it);
    var body = { geom: geom, note: noteVal };
    // rect 的 size_mm 前端重算
    if ((it.type || "rect") === "rect" && state.mppX && state.mppX > 0) {
      body.geom.size_mm = Math.round(geom.side_px * state.mppX / 1000 * 100) / 100;
    } else if ((it.type || "rect") === "rect") {
      body.geom.size_mm = it.size_mm != null ? it.size_mm : 0;
    }
    fetch(API + "/api/roi/" + it.index, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || "保存失败"); });
        return r.json();
      })
      .then(function () {
        toast("已保存修改", "success");
        editItem = null;
        closeEditCard();
        refreshRoisOnce();
      })
      .catch(function (e) { toast("保存失败: " + e.message, "error"); });
  }

  // 取消编辑：恢复原几何，清除选中
  function cancelEdit(it) {
    // 从服务端重新拉取以恢复（最稳妥）
    editItem = null;
    closeEditCard();
    loadCurrentRois();
  }

  // ---------- 绘制工具（arrow / freehand） ----------
  var drawPreview = null;
  var drawPointer = null;

  function enterDrawMode(mode) {
    if (!state.slide) { toast("请先打开一个切片", "error"); return; }
    exitRoi();
    state.drawMode = mode;
    els.annoArrowBtn.classList.toggle("active", mode === "arrow");
    els.annoFreeBtn.classList.toggle("active", mode === "freehand");
    els.annoCanvas.classList.add("drawing");
    if (viewer) viewer.setMouseNavEnabled(false);
    state.showAnno = true;
    els.annoAllBtn.classList.add("active");
    redrawAnnoCanvas();
    toast(mode === "arrow" ? "箭头模式：拖动绘制" : "描图模式：沿边缘描绘", "info");
  }

  function exitDrawMode() {
    state.drawMode = null;
    drawPreview = null;
    drawPointer = null;
    if (els.annoArrowBtn) els.annoArrowBtn.classList.remove("active");
    if (els.annoFreeBtn) els.annoFreeBtn.classList.remove("active");
    if (els.annoCanvas) els.annoCanvas.classList.remove("drawing");
    if (viewer) viewer.setMouseNavEnabled(true);
    redrawAnnoCanvas();
  }

  function toggleDrawMode(mode) {
    if (state.drawMode === mode) { exitDrawMode(); return; }
    enterDrawMode(mode);
  }

  function onAnnoPointerDown(e) {
    if (!state.slide) return;
    // 绘制模式优先：走原有绘制逻辑
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
    // 若已选中且点中手柄 → 开始拖动手柄
    if (editItem) {
      var handleId = hitHandle(sp.x, sp.y, editItem);
      if (handleId) {
        startEditDrag(e, editItem, handleId);
        return;
      }
    }
    // 命中检测：点中某标注 → 选中
    var hit = hitAnno(sp.x, sp.y);
    if (hit) {
      selectEditItem(hit);
      // 可编辑且点在标注内部（非手柄）→ 允许整体平移拖动
      if (isEditable(hit)) {
        var innerHandle = hitHandle(sp.x, sp.y, hit);
        if (!innerHandle) {
          startEditDrag(e, hit, moveHandleId(hit));
        }
      }
      return;
    }
    // 点空白 → 取消选中
    clearEditItem();
  }

  // 根据类型返回"整体平移"的手柄 id
  function moveHandleId(it) {
    var typ = it.type || "rect";
    if (typ === "arrow") return "mid";
    if (typ === "freehand") return "fmid";
    return "move"; // rect 无 mid 手柄，用 move
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
    // 编辑拖动
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

  // ---------- 编辑拖动会话 ----------
  function startEditDrag(e, it, handleId) {
    var c = els.annoCanvas;
    try { c.setPointerCapture(e.pointerId); } catch (err) {}
    editDrag = {
      pointerId: e.pointerId,
      handle: handleId,
      // 快照起始几何（图片坐标）+ 起始指针图像坐标
      item: it,
      start: snapshotGeom(it),
      startImg: screenToImg(e),
    };
    if (viewer) viewer.setMouseNavEnabled(false);
  }

  function snapshotGeom(it) {
    var typ = it.type || "rect";
    if (typ === "rect") {
      return { x: it.x, y: it.y, side_px: it.side_px };
    } else if (typ === "arrow") {
      return { x1: it.x1, y1: it.y1, x2: it.x2, y2: it.y2 };
    } else if (typ === "freehand") {
      return {
        points: (it.points || []).map(function (p) { return [p[0], p[1]]; }),
      };
    }
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
        // 角/边手柄：以对角/对边为锚，保持正方形 side = max(spanX, spanY)
        // 锚点 X：handle 在左侧（含 l）→ 锚为右边 s.x+side；在右侧（含 r）→ 锚为左边 s.x；
        //         纯上/下边（t/b）→ 锚为中心，x 围绕中心对称缩放
        var anchorX;
        if (d.handle === "tl" || d.handle === "bl" || d.handle === "l") {
          anchorX = s.x + s.side_px;
        } else if (d.handle === "tr" || d.handle === "br" || d.handle === "r") {
          anchorX = s.x;
        } else {
          anchorX = s.x + s.side_px / 2;  // t / b
        }
        var anchorY;
        if (d.handle === "tl" || d.handle === "t" || d.handle === "tr") {
          anchorY = s.y + s.side_px;
        } else if (d.handle === "bl" || d.handle === "b" || d.handle === "br") {
          anchorY = s.y;
        } else {
          anchorY = s.y + s.side_px / 2;  // l / r
        }
        var spanX = Math.abs(cur.x - anchorX);
        var spanY = Math.abs(cur.y - anchorY);
        var side = clamp(Math.round(Math.max(spanX, spanY)), 1, 40000);
        // 新左上角：指针在锚左侧 → 左上角 = 锚 - side；右侧 → 左上角 = 锚
        var nx = (cur.x <= anchorX) ? (anchorX - side) : anchorX;
        var ny = (cur.y <= anchorY) ? (anchorY - side) : anchorY;
        // 边手柄：保持中心轴不动（仅单轴缩放等效为整体居中）
        if (d.handle === "t" || d.handle === "b") {
          nx = s.x + s.side_px / 2 - side / 2;
        }
        if (d.handle === "l" || d.handle === "r") {
          ny = s.y + s.side_px / 2 - side / 2;
        }
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
        // 整体平移
        var n1x = Math.max(0, Math.round(s.x1 + dx));
        var n1y = Math.max(0, Math.round(s.y1 + dy));
        var n2x = Math.max(0, Math.round(s.x2 + dx));
        var n2y = Math.max(0, Math.round(s.y2 + dy));
        it.x1 = n1x; it.y1 = n1y; it.x2 = n2x; it.y2 = n2y;
      }
    } else if (typ === "freehand") {
      if (d.handle === "fmid") {
        // 整体平移：所有点平移，且 ≥0
        var minPx = Math.min.apply(null, s.points.map(function (p) { return p[0]; }));
        var minPy = Math.min.apply(null, s.points.map(function (p) { return p[1]; }));
        it.points = s.points.map(function (p) {
          return [Math.max(0, Math.round(p[0] + dx)), Math.max(0, Math.round(p[1] + dy))];
        });
      } else {
        // 角手柄：等比缩放（以对角为锚）
        var pts = s.points;
        var xs0 = pts.map(function (p) { return p[0]; });
        var ys0 = pts.map(function (p) { return p[1]; });
        var minx0 = Math.min.apply(null, xs0), maxx0 = Math.max.apply(null, xs0);
        var miny0 = Math.min.apply(null, ys0), maxy0 = Math.max.apply(null, ys0);
        var w0 = Math.max(1, maxx0 - minx0), h0 = Math.max(1, maxy0 - miny0);
        // 锚角（对角）
        var aX = (d.handle === "ftl") ? maxx0 : minx0;
        var aY = (d.handle === "ftl") ? maxy0 : miny0;
        if (d.handle === "ftr") { aX = minx0; aY = maxy0; }
        if (d.handle === "fbr") { aX = minx0; aY = miny0; }
        if (d.handle === "fbl") { aX = maxx0; aY = miny0; }
        // 新尺寸（以指针位置为参考，保持纵横比用统一 scale）
        var newW = Math.max(2, Math.abs(cur.x - aX));
        var newH = Math.max(2, Math.abs(cur.y - aY));
        var scale = Math.max(newW / w0, newH / h0);
        var newPts = pts.map(function (p) {
          return [Math.round(aX + (p[0] - aX) * scale), Math.round(aY + (p[1] - aY) * scale)];
        });
        // clamp 所有点 ≥0
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
    // 拖完不立即保存，等用户点"保存"
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
      var xs = pts.map(function (p) { return p[0]; });
      var ys = pts.map(function (p) { return p[1]; });
      var bb = Math.max(Math.max.apply(null, xs) - Math.min.apply(null, xs),
                        Math.max.apply(null, ys) - Math.min.apply(null, ys));
      if (bb < 10) { toast("描图范围太小，已取消", "info"); exitDrawMode(); return; }
      saveAnnotation({ type: "freehand", points: pts });
    }
  }

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

  // 保存用户标注（arrow/freehand）
  function saveAnnotation(geom) {
    if (!state.slide) return;
    var label = (els.roiLabel.value || "").trim();
    if (!label) {
      toast("请填写标记人或标签", "error");
      try { els.roiLabel.focus(); } catch (e) {}
      exitDrawMode();
      return;
    }
    var body = { slide: state.slide.name, type: geom.type, label: label };
    for (var k in geom) body[k] = geom[k];
    body.note = (els.roiNote ? els.roiNote.value : "") || "";
    fetch(API + "/api/roi", {
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
        refreshRoisOnce();
      })
      .catch(function (e) { toast("保存失败: " + e.message, "error"); exitDrawMode(); });
  }

  // 加载当前切片的标注（本 token + 管理员）供画布层绘制
  function loadCurrentRois() {
    if (!state.slide) { currentRois = []; editItem = null; closeEditCard(); redrawAnnoCanvas(); return; }
    fetch(API + "/api/rois")
      .then(function (r) { return r.json(); })
      .then(function (rois) {
        currentRois = (rois || []).filter(function (r) { return r.slide === state.slide.name; });
        // 若 editItem 已不在新列表，清除选中
        if (editItem && currentRois.indexOf(editItem) < 0) { editItem = null; closeEditCard(); }
        redrawAnnoCanvas();
      })
      .catch(function () { currentRois = []; editItem = null; closeEditCard(); redrawAnnoCanvas(); });
  }

  // ---------- 选区面板 ----------
  function loadRoiPanel() {
    fetch(API + "/api/rois")
      .then(function (r) {
        if (!r.ok) throw new Error("加载选区失败");
        return r.json();
      })
      .then(function (rois) {
        renderRoiPanel(rois || []);
      })
      .catch(function (e) { toast(e.message, "error"); });
  }

  // 一次拉取 /api/rois，同时刷新面板与画布层 currentRois。
  // 合并原先 loadRoiPanel + loadCurrentRois 的两次重复请求为一次拉取、两路渲染
  // （慢网/外网通道下每省一次请求就省一个 RTT）。
  function refreshRoisOnce() {
    return fetch(API + "/api/rois")
      .then(function (r) {
        if (!r.ok) throw new Error("加载选区失败");
        return r.json();
      })
      .then(function (rois) {
        rois = rois || [];
        // 面板渲染（原 loadRoiPanel 逻辑）
        renderRoiPanel(rois);
        // 画布层数据（原 loadCurrentRois 逻辑）
        if (state.slide) {
          currentRois = rois.filter(function (r) { return r.slide === state.slide.name; });
        } else {
          currentRois = [];
        }
        // 若 editItem 已不在新列表，清除选中
        if (editItem && currentRois.indexOf(editItem) < 0) { editItem = null; closeEditCard(); }
        redrawAnnoCanvas();
      })
      .catch(function (e) { toast(e.message, "error"); });
  }

  function renderRoiPanel(rois) {
    els.panelToggle.textContent = "选区(" + rois.length + ")";
    if (rois.length === 0) {
      els.panelList.innerHTML = '<div class="roi-panel-empty">暂无选区</div>';
      return;
    }
    els.panelList.innerHTML = "";
    rois.forEach(function (r, i) {
      var item = document.createElement("div");
      item.className = "roi-panel-item";

      var label = (r.label && String(r.label).trim()) || "未署名";
      var typ = r.type || "rect";
      var isAdmin = (r.source === "admin");
      var isShared = (r.source === "shared");
      var isMe = (r.source === "me");
      var icon = typ === "arrow" ? "↗" : (typ === "freehand" ? "〰" : "▭");

      // 类型图标
      var iconEl = document.createElement("div");
      iconEl.className = "rpi-icon";
      iconEl.textContent = icon;
      item.appendChild(iconEl);

      var info = document.createElement("div");
      info.className = "ri-info";
      var title = document.createElement("div");
      title.className = "ri-title";
      var lblEl = document.createElement("span");
      lblEl.className = "ri-label";
      lblEl.textContent = label;
      title.appendChild(lblEl);
      // 尺寸/坐标摘要
      var szEl = document.createElement("span");
      szEl.className = "rpi-size";
      if (typ === "rect") szEl.textContent = " · " + r.size_mm + "mm";
      else if (typ === "arrow") szEl.textContent = " · (" + r.x1 + "," + r.y1 + ")";
      else szEl.textContent = " · " + (r.points ? r.points.length : 0) + "点";
      title.appendChild(szEl);
      if (isAdmin) {
        var badge = document.createElement("span");
        badge.className = "rpi-badge";
        badge.textContent = "管理员";
        title.appendChild(badge);
      } else if (isShared) {
        var sBadge = document.createElement("span");
        sBadge.className = "rpi-badge shared";
        sBadge.textContent = "公开";
        title.appendChild(sBadge);
      }
      var sub = document.createElement("div");
      sub.className = "ri-sub";
      sub.textContent = fmtTime(r.ts);
      info.appendChild(title);
      info.appendChild(sub);

      // 点击条目 → 跳转
      info.style.cursor = "pointer";
      info.addEventListener("click", function () { jumpToRoi(r); });

      item.appendChild(info);

      // 删除钮：仅本人的可删（admin / shared 不可删）
      if (isMe) {
        // 编辑钮：跳转到该标注并选中进入编辑态
        var editBtn = document.createElement("button");
        editBtn.className = "ri-edit";
        editBtn.textContent = "✎";
        editBtn.title = "编辑";
        editBtn.addEventListener("click", function (ev) {
          ev.stopPropagation();
          jumpAndEdit(r);
        });
        item.appendChild(editBtn);

        var del = document.createElement("button");
        del.className = "ri-del";
        del.textContent = "×";
        del.title = "删除";
        del.addEventListener("click", function (ev) {
          ev.stopPropagation();
          deleteRoi(r.index);
        });
        item.appendChild(del);
      }

      els.panelList.appendChild(item);
    });
  }

  function deleteRoi(index) {
    fetch(API + "/api/roi/" + index, { method: "DELETE" })
      .then(function (r) {
        if (!r.ok) {
          return r.json().then(function (j) {
            throw new Error(j.error || "删除失败");
          });
        }
        return r.json();
      })
      .then(function () {
        // ---- 乐观更新（同步执行，立即反馈）----
        // 从 currentRois 移除该项（仅本人 source==="me" 的可删；
        // 按 source 限定避免与 admin/shared 条目的 index 数值冲突误删）
        for (var i = currentRois.length - 1; i >= 0; i--) {
          var it = currentRois[i];
          if (it.index === index && it.source === "me") {
            if (editItem === it) editItem = null;
            currentRois.splice(i, 1);
          }
        }
        closeEditCard();
        redrawAnnoCanvas();
        toast("已删除选区", "success");
        // ---- 后台异步同步真实状态（一次拉取，面板与画布同时刷新）----
        refreshRoisOnce();
      })
      .catch(function (e) {
        toast(e.message, "error");
        // 失败恢复：重新拉取真实状态
        refreshRoisOnce();
      });
  }

  // 跳转到指定 ROI：切到对应切片，OSD open 后定位
  function jumpToRoi(r) {
    var needSwitch = !(state.slide && state.slide.name === r.slide);
    if (needSwitch) {
      // 一次性监听 open 完成后定位
      var handler = function () {
        viewer.removeHandler("open", handler);
        doJump(r);
      };
      viewer.addHandler("open", handler);
      openSlide(r.slide);
    } else {
      doJump(r);
    }
  }

  // 跳转并在加载完成后选中该标注进入编辑态
  function jumpAndEdit(r) {
    var needSwitch = !(state.slide && state.slide.name === r.slide);
    var doSelect = function () {
      // 在 currentRois 中找到匹配项（按 index+token）并选中
      var match = null;
      for (var i = 0; i < currentRois.length; i++) {
        var it = currentRois[i];
        if (it.index === r.index && it.token === r.token) { match = it; break; }
      }
      if (match) selectEditItem(match);
    };
    if (needSwitch) {
      var handler = function () {
        viewer.removeHandler("open", handler);
        doJump(r);
        // 等标注加载完再选中
        setTimeout(doSelect, 300);
      };
      viewer.addHandler("open", handler);
      openSlide(r.slide);
    } else {
      doJump(r);
      doSelect();
    }
  }

  function doJump(r) {
    var typ = r.type || "rect";
    var x, y, side;
    if (typ === "arrow") {
      x = Math.min(r.x1, r.x2); y = Math.min(r.y1, r.y2);
      side = Math.max(Math.abs(r.x2 - r.x1), Math.abs(r.y2 - r.y1));
    } else if (typ === "freehand") {
      var xs = r.points.map(function (p) { return p[0]; });
      var ys = r.points.map(function (p) { return p[1]; });
      x = Math.min.apply(null, xs); y = Math.min.apply(null, ys);
      side = Math.max(Math.max.apply(null, xs) - x, Math.max.apply(null, ys) - y);
    } else {
      x = r.x; y = r.y; side = r.side_px;
    }
    side = Math.max(side, 1);
    var pad = side * 0.2;
    // rect 用 rebuildRoi 重建选区框；arrow/freehand 仅 fitBounds（画布层已显示）
    if (typ === "rect") {
      rebuildRoi(r.x, r.y, r.side_px, r.size_mm);
    }
    try {
      var rect = viewer.viewport.imageToViewportRectangle(
        x - pad, y - pad, side + pad * 2, side + pad * 2);
      viewer.viewport.fitBounds(rect);
    } catch (e) {}
    // 隐藏面板与遮罩
    els.panel.style.display = "none";
    if (els.panelMask) els.panelMask.style.display = "none";
  }

  function fmtTime(ts) {
    if (!ts) return "";
    var d = new Date(ts * 1000);
    var p = function (n) { return n < 10 ? "0" + n : n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes());
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

    els.saveRoiBtn.addEventListener("click", saveRoi);
    els.exportBtn.addEventListener("click", exportCrop);
    els.mppSetBtn.addEventListener("click", setMpp);
    els.mppInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") setMpp();
    });

    // 标注绘制工具 + 显示切换
    els.annoArrowBtn.addEventListener("click", function () { toggleDrawMode("arrow"); });
    els.annoFreeBtn.addEventListener("click", function () { toggleDrawMode("freehand"); });
    els.annoAllBtn.addEventListener("click", toggleAnnoAll);

    // 标注画布层绘制事件
    var c = els.annoCanvas;
    c.addEventListener("pointerdown", onAnnoPointerDown);
    c.addEventListener("pointermove", onAnnoPointerMove);
    c.addEventListener("pointerup", onAnnoPointerUp);
    c.addEventListener("pointercancel", onAnnoPointerUp);
    window.addEventListener("resize", function () { resizeAnnoCanvas(); redrawAnnoCanvas(); });

    // 选区面板开关（底部抽屉 + 遮罩）
    els.panelToggle.addEventListener("click", function () {
      var showing = els.panel.style.display !== "none";
      if (showing) {
        els.panel.style.display = "none";
        if (els.panelMask) els.panelMask.style.display = "none";
      } else {
        els.panel.style.display = "flex";
        if (els.panelMask) els.panelMask.style.display = "block";
        loadRoiPanel();
      }
    });
    els.panelClose.addEventListener("click", function () {
      els.panel.style.display = "none";
      if (els.panelMask) els.panelMask.style.display = "none";
    });
    if (els.panelMask) {
      els.panelMask.addEventListener("click", function () {
        els.panel.style.display = "none";
        els.panelMask.style.display = "none";
      });
    }
  }

  // ---------- 启动 ----------
  function init() {
    initViewer();
    bindEvents();
    // 先拉取分享配置（允许的 ROI 尺寸）再加载切片，确保工具栏按钮状态正确
    loadConfig().then(function () {
      loadSlides();
    });
    loadRoiPanel();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
