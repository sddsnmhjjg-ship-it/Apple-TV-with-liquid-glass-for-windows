/*
 * Apple TV Liquid Glass — Real-Time Optical Refraction Engine for tv.apple.com
 *
 * Runs directly inside Apple's official web client (https://tv.apple.com) so all
 * catalog browsing, Apple Account authentication (idmsa.apple.com + 2FA), Up Next
 * sync, and Widevine DRM playback are 100% genuine Apple TV.
 *
 * Optical Pipeline (per glass surface):
 *   1. Signed Distance Field (SDF) of the rounded rectangle computes exact distance
 *      to the perimeter and outward 2D surface normal (nx, ny) at every pixel.
 *   2. Inside the curved bezel band, a convex squircle lens profile
 *      h(t) = (1 - (1 - t)^4)^(1/4) defines the local surface slope dh/dt.
 *   3. Snell's Law (n_air = 1.0 -> n_glass = 1.52) computes the refracted ray angle
 *      theta_r = asin(sin(theta_i) / n_glass) and lateral pixel displacement
 *      shift = thickness * tan(theta_i - theta_r).
 *   4. R, G, and B channels are displaced through separate SVG feDisplacementMap
 *      stages with distinct refractive indices (chromatic dispersion) and recombined
 *      with a Fresnel specular rim map.
 */
(function () {
  "use strict";

  var FORCE = window.__ATV_LG_FORCE === true;
  if (!FORCE && location.hostname !== "tv.apple.com") return;
  if (window.top !== window) return;
  if (window.__atvLiquidGlassLoaded) return;
  window.__atvLiquidGlassLoaded = true;

  if (typeof navigator !== "undefined" && typeof navigator.requestMediaKeySystemAccess === "function" && !navigator.__atvEmePatched) {
    try {
      var origRMKSA = navigator.requestMediaKeySystemAccess.bind(navigator);
      Object.defineProperty(navigator, "requestMediaKeySystemAccess", {
        value: function (keySystem, supportedConfigurations) {
          if (typeof keySystem === "string" && keySystem.toLowerCase().indexOf("playready") !== -1) {
            return Promise.reject(new DOMException("PlayReady disabled in favor of Widevine CDM", "NotSupportedError"));
          }
          return origRMKSA(keySystem, supportedConfigurations);
        },
        configurable: true,
        writable: true
      });
      navigator.__atvEmePatched = true;
    } catch (e) {}
  }

  var SVG_NS = "http://www.w3.org/2000/svg";
  var XLINK_NS = "http://www.w3.org/1999/xlink";
  var STORE_KEY = "atv-liquid-glass-settings-v4";
  var MAX_MAP_PIXELS = 360000;
  var IOR = 1.52;

  var FPS_CONFIGS = [
    { label: "Eco (Low CPU)", fps: 15, interval: 66, eco: true },
    { label: "30 FPS", fps: 30, interval: 33.3, eco: false },
    { label: "60 FPS (Default)", fps: 60, interval: 16.6, eco: false },
    { label: "Uncapped", fps: 0, interval: 0, eco: false }
  ];

  var settings = {
    enabled: true,
    sidebarOpen: false,
    refractionScale: 1.35,
    frostScale: 1.0,
    dispersionScale: 1.25,
    specularScale: 0.20,
    fpsMode: 2,
    accountName: ""
  };

  try {
    var saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (!saved) {
      var prev = JSON.parse(localStorage.getItem("atv-liquid-glass-settings-v3") || localStorage.getItem("atv-liquid-glass-settings-v2") || "null");
      if (prev && typeof prev === "object") {
        if (typeof prev.enabled === "boolean") settings.enabled = prev.enabled;
        if (typeof prev.sidebarOpen === "boolean") settings.sidebarOpen = prev.sidebarOpen;
        if (typeof prev.refractionScale === "number") settings.refractionScale = prev.refractionScale;
        if (typeof prev.frostScale === "number") settings.frostScale = prev.frostScale;
        if (typeof prev.dispersionScale === "number") settings.dispersionScale = prev.dispersionScale;
        if (typeof prev.fpsMode === "number") settings.fpsMode = prev.fpsMode;
        if (typeof prev.accountName === "string") settings.accountName = prev.accountName;
      }
      settings.specularScale = 0.20;
      saveSettings();
    } else if (typeof saved === "object") {
      if (typeof saved.enabled === "boolean") settings.enabled = saved.enabled;
      if (typeof saved.sidebarOpen === "boolean") settings.sidebarOpen = saved.sidebarOpen;
      if (typeof saved.refractionScale === "number") settings.refractionScale = saved.refractionScale;
      if (typeof saved.frostScale === "number") settings.frostScale = saved.frostScale;
      if (typeof saved.dispersionScale === "number") settings.dispersionScale = saved.dispersionScale;
      if (typeof saved.specularScale === "number") settings.specularScale = saved.specularScale;
      if (typeof saved.fpsMode === "number") settings.fpsMode = saved.fpsMode;
      if (typeof saved.accountName === "string") settings.accountName = saved.accountName;
    }
  } catch (e) {}

  function saveSettings() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(settings));
    } catch (e) {}
  }

  /* Remove any legacy bottom-left dock from previous versions */
  var legacyDock = document.getElementById("atv-lg-dock");
  if (legacyDock && legacyDock.parentNode) {
    legacyDock.parentNode.removeChild(legacyDock);
  }

  /* ------------------------------------------------------------------------
   * Optical Surface Presets
   * ---------------------------------------------------------------------- */
  var PRESETS = {
    bar: {
      bezel: 22,
      thickness: 38,
      frost: 5.0,
      dispersion: 0.085,
      saturate: 1.8,
      specular: 0.94,
      tint: "rgba(20, 22, 30, 0.28)"
    },
    pill: {
      bezel: 11,
      thickness: 22,
      frost: 3.0,
      dispersion: 0.07,
      saturate: 1.65,
      specular: 0.88,
      tint: "rgba(255, 255, 255, 0.08)"
    },
    accent: {
      bezel: 11,
      thickness: 24,
      frost: 2.5,
      dispersion: 0.075,
      saturate: 1.75,
      specular: 0.95,
      tint: "rgba(10, 132, 255, 0.50)"
    },
    primaryPill: {
      bezel: 11,
      thickness: 20,
      frost: 2.0,
      dispersion: 0.06,
      saturate: 1.5,
      specular: 0.95,
      tint: "rgba(255, 255, 255, 0.94)"
    },
    platter: {
      bezel: 11,
      thickness: 20,
      frost: 3.5,
      dispersion: 0.065,
      saturate: 1.7,
      specular: 0.85,
      tint: "rgba(20, 22, 30, 0.26)"
    },
    panel: {
      bezel: 26,
      thickness: 40,
      frost: 9.0,
      dispersion: 0.075,
      saturate: 1.75,
      specular: 0.90,
      tint: "rgba(18, 20, 28, 0.44)"
    },
    playerLens: {
      bezel: 18,
      thickness: 38,
      frost: 2.0,
      dispersion: 0.085,
      saturate: 1.85,
      specular: 1.0,
      tint: "rgba(18, 24, 38, 0.28)",
      bgImage: "radial-gradient(circle at 50% 28%, rgba(255, 255, 255, 0.28) 0%, rgba(255, 255, 255, 0.06) 52%, rgba(10, 16, 26, 0.40) 100%)"
    },
    playerSkip: {
      bezel: 14,
      thickness: 30,
      frost: 2.0,
      dispersion: 0.08,
      saturate: 1.8,
      specular: 0.96,
      tint: "rgba(18, 24, 38, 0.26)",
      bgImage: "radial-gradient(circle at 50% 28%, rgba(255, 255, 255, 0.24) 0%, rgba(255, 255, 255, 0.05) 52%, rgba(10, 16, 26, 0.38) 100%)"
    },
    playerClose: {
      bezel: 12,
      thickness: 24,
      frost: 2.0,
      dispersion: 0.075,
      saturate: 1.65,
      specular: 0.92,
      tint: "rgba(18, 24, 38, 0.26)",
      bgImage: "radial-gradient(circle at 50% 28%, rgba(255, 255, 255, 0.22) 0%, rgba(255, 255, 255, 0.04) 52%, rgba(10, 16, 26, 0.38) 100%)"
    },
    playerPill: {
      bezel: 12,
      thickness: 26,
      frost: 3.5,
      dispersion: 0.075,
      saturate: 1.7,
      specular: 0.92,
      tint: "rgba(16, 22, 34, 0.28)",
      bgImage: "linear-gradient(180deg, rgba(255, 255, 255, 0.14) 0%, rgba(255, 255, 255, 0.03) 48%, rgba(12, 16, 26, 0.38) 100%)"
    },
    playerScrubber: {
      bezel: 14,
      thickness: 30,
      frost: 3.5,
      dispersion: 0.075,
      saturate: 1.75,
      specular: 0.95,
      tint: "rgba(14, 20, 30, 0.28)",
      bgImage: "linear-gradient(180deg, rgba(255, 255, 255, 0.14) 0%, rgba(255, 255, 255, 0.03) 48%, rgba(10, 14, 24, 0.38) 100%)"
    }
  };

  /* Real tv.apple.com DOM targets verified against Apple's Svelte app */
  var TARGETS = [
    { selector: "[data-testid='header'], .header.header--color, header.landing-page-header, header.header", preset: "bar", kind: "bar", minW: 200, minH: 32 },
    { selector: ".search-input", preset: "pill", kind: "pill", minW: 60, minH: 20 },
    { selector: "button.commerce-button.signin, button.commerce-button", preset: "accent", kind: "pill", minW: 48, minH: 20 },
    { selector: "button.theme-primary", preset: "primaryPill", kind: "pill", minW: 60, minH: 24 },
    { selector: "button.theme-secondary, button.theme-outline", preset: "pill", kind: "pill", minW: 32, minH: 24 },
    { selector: "button.video-control__mute", preset: "pill", kind: "circle", minW: 22, minH: 22 },
    { selector: "nav.pagination-dots, .platter", preset: "platter", kind: "pill", minW: 48, minH: 18 },
    { selector: ".sticky-cta", preset: "bar", kind: "panel", minW: 240, minH: 36 },

    /* Video Player Controls (VisionOS Liquid Glass) */
    { selector: "amp-playback-controls-play", preset: "playerLens", kind: "circle", minW: 36, minH: 36 },
    { selector: ".skip-control.button--back, [data-testid='playback-controls-skip-back']", preset: "playerSkip", kind: "circle", minW: 24, minH: 24 },
    { selector: ".skip-control.button--forward, [data-testid='playback-controls-skip-forward']", preset: "playerSkip", kind: "circle", minW: 24, minH: 24 },
    { selector: "button.close-button.svelte-19l0lnx, button.close-button[data-testid='close-button']", preset: "playerClose", kind: "circle", minW: 16, minH: 16 },
    { selector: ".volume-unified, amp-volume-control-unified", preset: "playerPill", kind: "pill", minW: 60, minH: 20 },
    { selector: ".video-player__progress", preset: "playerScrubber", kind: "pill", minW: 160, minH: 20 },
    { selector: ".video-player__controls", preset: "playerPill", kind: "pill", minW: 60, minH: 20 },
    { selector: "button.player-tab__trigger", preset: "playerPill", kind: "pill", minW: 30, minH: 20 }
  ];

  /* ------------------------------------------------------------------------
   * Snell's Law Convex Squircle Refraction Profile
   * ---------------------------------------------------------------------- */
  var PROFILE_STEPS = 256;

  function surfaceHeight(x) {
    var c = Math.min(1, Math.max(0, x));
    return Math.pow(1 - Math.pow(1 - c, 4), 0.25);
  }

  function buildProfile(thickness) {
    var table = new Float32Array(PROFILE_STEPS + 1);
    var max = 0;
    var eps = 0.5 / PROFILE_STEPS;
    var maxIncidence = 85 * Math.PI / 180;
    for (var i = 0; i <= PROFILE_STEPS; i++) {
      var x = i / PROFILE_STEPS;
      var slope = (surfaceHeight(x + eps) - surfaceHeight(x - eps)) / (2 * eps);
      var incidence = Math.min(maxIncidence, Math.atan(Math.abs(slope)));
      var refracted = Math.asin(Math.sin(incidence) / IOR);
      var shift = thickness * Math.tan(incidence - refracted);
      table[i] = shift;
      if (shift > max) max = shift;
    }
    return { table: table, max: max };
  }

  /* ------------------------------------------------------------------------
   * Displacement Map (RG) + Specular Rim Map (RGBA) Generator
   * ---------------------------------------------------------------------- */
  var mapCache = new Map();

  function generateMaps(width, height, radius, preset) {
    var effThickness = preset.thickness * settings.refractionScale;
    var effSpecular = preset.specular * settings.specularScale;
    var key = [
      Math.round(width),
      Math.round(height),
      Math.round(radius),
      preset.bezel,
      effThickness.toFixed(1),
      effSpecular.toFixed(2)
    ].join("|");

    var hit = mapCache.get(key);
    if (hit) return hit;

    var scale = Math.min(1, Math.sqrt(MAX_MAP_PIXELS / Math.max(1, width * height)));
    var cw = Math.max(4, Math.round(width * scale));
    var ch = Math.max(4, Math.round(height * scale));
    var r = Math.min(radius, width / 2, height / 2) * scale;
    var bezel = Math.max(2, Math.min(preset.bezel, Math.min(width, height) / 2) * scale);
    var profile = buildProfile(effThickness);
    var maxShift = Math.max(0.0001, profile.max);

    var lightX = -0.52, lightY = -0.85;
    var halfW = cw / 2, halfH = ch / 2;

    var dispCanvas = document.createElement("canvas");
    dispCanvas.width = cw;
    dispCanvas.height = ch;
    var specCanvas = document.createElement("canvas");
    specCanvas.width = cw;
    specCanvas.height = ch;

    var dispCtx = dispCanvas.getContext("2d");
    var specCtx = specCanvas.getContext("2d");
    var dispImg = dispCtx.createImageData(cw, ch);
    var specImg = specCtx.createImageData(cw, ch);
    var dd = dispImg.data;
    var sd = specImg.data;

    for (var y = 0; y < ch; y++) {
      var py = y + 0.5 - halfH;
      var ay = Math.abs(py) - (halfH - r);
      var qy = Math.max(ay, 0);

      for (var x = 0; x < cw; x++) {
        var idx = (y * cw + x) * 4;
        var px = x + 0.5 - halfW;
        var ax = Math.abs(px) - (halfW - r);
        var qx = Math.max(ax, 0);
        var outLen = Math.hypot(qx, qy);
        var sdf = outLen + Math.min(Math.max(ax, ay), 0) - r;
        var distFromEdge = -sdf;

        var dr = 128, dg = 128;
        var sr = 0, sg = 0, sb = 0, sa = 0;

        if (distFromEdge > 0) {
          var nx = 0, ny = 0;
          if (outLen > 0.0001) {
            nx = (px < 0 ? -qx : qx) / outLen;
            ny = (py < 0 ? -qy : qy) / outLen;
          } else if (ax > ay) {
            nx = px < 0 ? -1 : 1;
          } else {
            ny = py < 0 ? -1 : 1;
          }

          if (distFromEdge < bezel) {
            var u = distFromEdge / bezel;
            var tIdx = Math.min(PROFILE_STEPS, Math.max(0, Math.round(u * PROFILE_STEPS)));
            var mag = profile.table[tIdx] / maxShift;
            dr = Math.max(0, Math.min(255, Math.round(128 + (-nx * mag) * 127)));
            dg = Math.max(0, Math.min(255, Math.round(128 + (-ny * mag) * 127)));
          }

          var edgeBand = Math.max(0, 1 - distFromEdge / (bezel * 0.68));
          var crest = Math.pow(edgeBand, 2.35);
          var topLight = Math.max(0, nx * lightX + ny * lightY);
          var botLight = Math.max(0, -nx * lightX - ny * lightY);
          var rimIntensity = crest * (0.16 + 0.92 * Math.pow(topLight, 1.45) + 0.36 * Math.pow(botLight, 2.2)) * effSpecular;

          if (rimIntensity > 0.003) {
            sa = Math.max(0, Math.min(255, Math.round(rimIntensity * 255)));
            sr = Math.min(255, Math.round(240 + 15 * topLight));
            sg = Math.min(255, Math.round(246 + 9 * topLight));
            sb = 255;
          }
        }

        dd[idx] = dr;
        dd[idx + 1] = dg;
        dd[idx + 2] = 128;
        dd[idx + 3] = 255;

        sd[idx] = sr;
        sd[idx + 1] = sg;
        sd[idx + 2] = sb;
        sd[idx + 3] = sa;
      }
    }

    dispCtx.putImageData(dispImg, 0, 0);
    specCtx.putImageData(specImg, 0, 0);

    var result = {
      displacement: dispCanvas.toDataURL("image/png"),
      specular: specCanvas.toDataURL("image/png"),
      maxShift: maxShift
    };

    if (mapCache.size > 56) {
      mapCache.delete(mapCache.keys().next().value);
    }
    mapCache.set(key, result);
    return result;
  }

  /* ------------------------------------------------------------------------
   * SVG Filter Graph Construction (Snell Refraction + Chromatic Dispersion)
   * ---------------------------------------------------------------------- */
  var svgDefs = null;
  var filterSeq = 0;

  function ensureSvgDefs() {
    if (svgDefs && svgDefs.isConnected) return svgDefs;
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.id = "atv-lg-svg-defs";
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;overflow:hidden;pointer-events:none;z-index:-1;";
    var defs = document.createElementNS(SVG_NS, "defs");
    svg.appendChild(defs);
    (document.body || document.documentElement).appendChild(svg);
    svgDefs = defs;
    return defs;
  }

  function svgEl(tag, attrs) {
    var el = document.createElementNS(SVG_NS, tag);
    for (var k in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, k)) {
        el.setAttribute(k, String(attrs[k]));
      }
    }
    return el;
  }

  function setHref(el, url) {
    el.setAttribute("href", url);
    el.setAttributeNS(XLINK_NS, "xlink:href", url);
  }

  function buildFilterElement(id, width, height, radius, preset) {
    var maps = generateMaps(width, height, radius, preset);
    var w = Math.max(4, Math.round(width));
    var h = Math.max(4, Math.round(height));
    var baseScale = maps.maxShift * 2;
    var disp = preset.dispersion * settings.dispersionScale;
    var frost = Math.max(0.2, preset.frost * settings.frostScale);

    var f = svgEl("filter", {
      id: id,
      x: "0%",
      y: "0%",
      width: "100%",
      height: "100%",
      filterUnits: "objectBoundingBox",
      primitiveUnits: "userSpaceOnUse",
      "color-interpolation-filters": "sRGB"
    });

    f.appendChild(svgEl("feGaussianBlur", {
      "in": "SourceGraphic",
      stdDeviation: frost.toFixed(2),
      edgeMode: "duplicate",
      result: "frost"
    }));

    var dispImg = svgEl("feImage", {
      x: 0,
      y: 0,
      width: w,
      height: h,
      preserveAspectRatio: "none",
      result: "map"
    });
    setHref(dispImg, maps.displacement);
    f.appendChild(dispImg);

    f.appendChild(svgEl("feDisplacementMap", {
      "in": "frost",
      in2: "map",
      scale: (baseScale * (1 + disp)).toFixed(2),
      xChannelSelector: "R",
      yChannelSelector: "G",
      result: "dispR"
    }));
    f.appendChild(svgEl("feDisplacementMap", {
      "in": "frost",
      in2: "map",
      scale: baseScale.toFixed(2),
      xChannelSelector: "R",
      yChannelSelector: "G",
      result: "dispG"
    }));
    f.appendChild(svgEl("feDisplacementMap", {
      "in": "frost",
      in2: "map",
      scale: (baseScale * Math.max(0.15, 1 - disp)).toFixed(2),
      xChannelSelector: "R",
      yChannelSelector: "G",
      result: "dispB"
    }));

    f.appendChild(svgEl("feColorMatrix", {
      "in": "dispR",
      type: "matrix",
      values: "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0",
      result: "chR"
    }));
    f.appendChild(svgEl("feColorMatrix", {
      "in": "dispG",
      type: "matrix",
      values: "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0",
      result: "chG"
    }));
    f.appendChild(svgEl("feColorMatrix", {
      "in": "dispB",
      type: "matrix",
      values: "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0",
      result: "chB"
    }));

    f.appendChild(svgEl("feBlend", { "in": "chR", in2: "chG", mode: "screen", result: "rg" }));
    f.appendChild(svgEl("feBlend", { "in": "rg", in2: "chB", mode: "screen", result: "rgb" }));
    f.appendChild(svgEl("feColorMatrix", { "in": "rgb", type: "saturate", values: String(preset.saturate), result: "vivid" }));

    var specImg = svgEl("feImage", {
      x: 0,
      y: 0,
      width: w,
      height: h,
      preserveAspectRatio: "none",
      result: "spec"
    });
    setHref(specImg, maps.specular);
    f.appendChild(specImg);
    f.appendChild(svgEl("feComposite", { "in": "spec", in2: "vivid", operator: "over" }));

    return f;
  }

  /* ------------------------------------------------------------------------
   * Surface Attachment & Svelte-Safe Persistence
   * ---------------------------------------------------------------------- */
  var surfaces = new Map();
  var resizeObserver = new ResizeObserver(function (entries) {
    for (var i = 0; i < entries.length; i++) {
      scheduleRebuild(entries[i].target);
    }
  });

  function isNearViewport(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 12 || r.height < 12) return false;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    return r.right >= -160 && r.left <= vw + 160 && r.bottom >= -160 && r.top <= vh + 240;
  }

  function isTopNavBar(el) {
    if (!el || !el.matches) return false;
    if (el.closest(".rich-lockup-shelf-header, .shelf, [data-testid*='shelf'], [class*='shelf'], .section-content")) return false;
    return el.matches("[data-testid='header'], .header--color, header.landing-page-header, header.header") ||
      !!el.querySelector(".header__contents, .navigation-tabs");
  }

  function parseRadius(el, width, height, kind) {
    if (kind === "pill" || kind === "circle") return Math.min(width, height) / 2;
    if (kind === "bar") return 25;
    if (kind === "panel") return 24;
    var cs = getComputedStyle(el);
    var r = parseFloat(cs.borderTopLeftRadius) || 20;
    return Math.min(r, width / 2, height / 2);
  }

  function isTabActive(el) {
    if (!el) return false;
    if (el.classList && (
      el.classList.contains("active") ||
      el.classList.contains("selected") ||
      el.classList.contains("player-tab__trigger--active") ||
      el.classList.contains("player-tab__trigger--selected")
    )) return true;
    var ariaSel = el.getAttribute ? el.getAttribute("aria-selected") : null;
    var ariaExp = el.getAttribute ? el.getAttribute("aria-expanded") : null;
    return ariaSel === "true" || ariaExp === "true";
  }

  function applySurfaceStyles(el, state) {
    if (!settings.enabled) return;
    if (el.getAttribute("data-atv-lg") !== state.kind) {
      el.setAttribute("data-atv-lg", state.kind);
    }

    var isTab = el.tagName === "BUTTON" && (el.classList.contains("player-tab__trigger") || el.classList.contains("btn-tab-pill"));
    if (isTab) {
      if (isTabActive(el)) {
        // Figma Design: When clicked, turn the entire button solid vibrant electric blue (#276bff)
        el.style.setProperty("background-color", "#276bff", "important");
        el.style.setProperty("background-image", "none", "important");
        el.style.setProperty("border-color", "rgba(255, 255, 255, 0.85)", "important");
        el.style.setProperty("box-shadow", "0 0 24px rgba(39, 107, 255, 0.80), 0 4px 14px rgba(39, 107, 255, 0.50)", "important");
        el.style.setProperty("color", "#ffffff", "important");
        el.style.setProperty("position", "relative", "important");
        el.style.setProperty("z-index", "60", "important");
        el.style.setProperty("overflow", "visible", "important");
        el.style.removeProperty("backdrop-filter");
        el.style.removeProperty("-webkit-backdrop-filter");

        // Un-clip all ancestor containers so the glow expands in full 360 degrees without cutting
        var p = el.parentElement;
        while (p && p !== document.body) {
          p.style.setProperty("overflow", "visible", "important");
          p.style.setProperty("contain", "none", "important");
          p.style.setProperty("clip-path", "none", "important");
          p.style.setProperty("-webkit-clip-path", "none", "important");
          p = p.parentElement;
        }
        return;
      } else {
        el.style.removeProperty("border-color");
        el.style.removeProperty("box-shadow");
        el.style.removeProperty("color");
        el.style.removeProperty("z-index");
      }
    }

    var isEco = (FPS_CONFIGS[settings.fpsMode] || {}).eco === true;
    if (isEco) {
      el.style.removeProperty("backdrop-filter");
      el.style.removeProperty("-webkit-backdrop-filter");
    } else {
      var value = "url(#" + state.filterId + ")";
      if (el.style.backdropFilter !== value) {
        el.style.setProperty("backdrop-filter", value, "important");
        el.style.setProperty("-webkit-backdrop-filter", value, "important");
      }
    }
    if (el.style.backgroundColor !== state.preset.tint) {
      el.style.setProperty("background-color", state.preset.tint, "important");
    }
    if (state.preset.bgImage && el.style.backgroundImage !== state.preset.bgImage) {
      el.style.setProperty("background-image", state.preset.bgImage, "important");
    }
  }

  function attach(el, presetName, kind) {
    if (surfaces.has(el)) {
      var existing = surfaces.get(el);
      if (!existing.filter) rebuild(el, true);
      else applySurfaceStyles(el, existing);
      return;
    }
    var state = {
      presetName: presetName,
      preset: PRESETS[presetName],
      kind: kind,
      filterId: "atv-lg-" + (++filterSeq),
      filter: null,
      timer: 0,
      w: 0,
      h: 0,
      r: -1,
      rect: null
    };
    surfaces.set(el, state);
    resizeObserver.observe(el);
    rebuild(el, true);
  }

  function detach(el) {
    var state = surfaces.get(el);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    if (state.filter && state.filter.parentNode) {
      state.filter.parentNode.removeChild(state.filter);
    }
    el.removeAttribute("data-atv-lg");
    el.style.removeProperty("backdrop-filter");
    el.style.removeProperty("-webkit-backdrop-filter");
    el.style.removeProperty("background-color");
    resizeObserver.unobserve(el);
    surfaces.delete(el);
  }

  function scheduleRebuild(el) {
    var state = surfaces.get(el);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(function () {
      state.timer = 0;
      rebuild(el, false);
    }, 60);
  }

  function rebuild(el, force) {
    var state = surfaces.get(el);
    if (!state || !settings.enabled) return;
    var rect = el.getBoundingClientRect();
    state.rect = rect;
    var w = Math.round(el.offsetWidth || rect.width);
    var h = Math.round(el.offsetHeight || rect.height);
    if (w < 12 || h < 12) return;
    var r = Math.round(parseRadius(el, w, h, state.kind));
    if (!force && Math.abs(w - state.w) <= 1 && Math.abs(h - state.h) <= 1 && Math.abs(r - state.r) <= 1) {
      applySurfaceStyles(el, state);
      return;
    }
    state.w = w;
    state.h = h;
    state.r = r;

    var isEco = (FPS_CONFIGS[settings.fpsMode] || {}).eco === true;
    if (isEco) {
      applySurfaceStyles(el, state);
      return;
    }

    var defs = ensureSvgDefs();
    var nextFilter = buildFilterElement(state.filterId, w, h, r, state.preset);
    if (state.filter && state.filter.parentNode) {
      defs.replaceChild(nextFilter, state.filter);
    } else {
      defs.appendChild(nextFilter);
    }
    state.filter = nextFilter;
    applySurfaceStyles(el, state);
  }

  function rebuildAll() {
    mapCache.clear();
    surfaces.forEach(function (state, el) {
      rebuild(el, true);
    });
  }

  /* ------------------------------------------------------------------------
   * Stylesheet for macOS Liquid Glass Bar, Sidebar, and User Profile Settings
   * ---------------------------------------------------------------------- */
  var STYLE_ID = "atv-liquid-glass-style";

  var CSS = [
    /* Text Sharpness & Extinguish Glow / Bloom across all Liquid Glass UI */
    "html.atv-lg-on,",
    "html.atv-lg-on *,",
    "html.atv-lg-on [data-atv-lg],",
    "html.atv-lg-on [data-atv-lg] *,",
    "html.atv-lg-on #atv-lg-mac-sidebar,",
    "html.atv-lg-on #atv-lg-mac-sidebar *,",
    "html.atv-lg-on #atv-lg-popover,",
    "html.atv-lg-on #atv-lg-popover *,",
    "html.atv-lg-on #atv-lg-user-menu,",
    "html.atv-lg-on #atv-lg-user-menu *,",
    "html.atv-lg-on .navigation-tabs a,",
    "html.atv-lg-on .brand-lockup,",
    "html.atv-lg-on .hero-copy h1,",
    "html.atv-lg-on .hero-copy p,",
    "html.atv-lg-on button {",
    "  text-shadow: none !important;",
    "  filter: none;",
    "  -webkit-font-smoothing: antialiased !important;",
    "  -moz-osx-font-smoothing: grayscale !important;",
    "  text-rendering: optimizeLegibility !important;",
    "}",

    /* Eco / Low CPU Mode - Hardware-Accelerated CSS Glass */
    "html.atv-lg-on.atv-lg-eco [data-atv-lg] {",
    "  backdrop-filter: blur(22px) saturate(175%) brightness(1.05) !important;",
    "  -webkit-backdrop-filter: blur(22px) saturate(175%) brightness(1.05) !important;",
    "  background-image: none !important;",
    "}",

    /* Allow hero video/artwork to bleed underneath the floating macOS top bar while keeping headers/titles clear */
    "html.atv-lg-on .app-container {",
    "  grid-template-rows: 0px 0px 1fr auto !important;",
    "}",
    "html.atv-lg-on .scrollable-page {",
    "  height: 100vh !important;",
    "  box-sizing: border-box !important;",
    "  padding-top: 76px !important;",
    "  transition: padding-left 0.32s cubic-bezier(0.22, 1, 0.36, 1) !important;",
    "}",
    "html.atv-lg-on.atv-lg-sidebar-open .scrollable-page {",
    "  padding-left: 244px !important;",
    "}",
    "/* When hero carousel or channel header is present at the top, let the artwork bleed underneath */",
    "html.atv-lg-on .scrollable-page:has(.epic-stage) > main > .content-container > .section:first-child,",
    "html.atv-lg-on .scrollable-page:has(.epic-stage) > main > .content-container > .section:nth-child(2),",
    "html.atv-lg-on .scrollable-page:has(.hero-copy) > main > .content-container > .section:first-child,",
    "html.atv-lg-on .scrollable-page:has(.landing-page-hero) > main > .content-container > .section:first-child {",
    "  margin-top: -76px !important;",
    "}",
    "html.atv-lg-on .video-control__container {",
    "  margin-top: 56px !important;",
    "}",
    /* Hide the Microsoft Store promo link since we are already in the Windows app */
    "html.atv-lg-on a.open-in-tv,",
    "html.atv-lg-on .banner-container,",
    "html.atv-lg-on [data-testid='banner-container'] {",
    "  display: none !important;",
    "}",

    /* Shared Liquid Glass surface properties - subtle specular highlight without text blooming */
    "html.atv-lg-on [data-atv-lg] {",
    "  border: 1px solid rgba(255, 255, 255, 0.28) !important;",
    "  isolation: isolate;",
    "  overflow: hidden;",
    "  background-image: radial-gradient(180px circle at var(--lg-mx, 50%) var(--lg-my, 0%), rgba(255,255,255,0.08), rgba(255,255,255,0.01) 40%, transparent 65%) !important;",
    "}",

    /* Shelf headers must never be fixed or styled as floating bars */
    "html.atv-lg-on .rich-lockup-shelf-header,",
    "html.atv-lg-on .rich-lockup-shelf-header .header,",
    "html.atv-lg-on .shelf .header,",
    "html.atv-lg-on [class*='shelf'] .header,",
    "html.atv-lg-on .section-content .header {",
    "  position: static !important;",
    "  top: auto !important;",
    "  left: auto !important;",
    "  right: auto !important;",
    "  width: auto !important;",
    "  height: auto !important;",
    "  z-index: auto !important;",
    "  box-shadow: none !important;",
    "  border: none !important;",
    "  border-radius: 0 !important;",
    "}",

    /* Top Floating macOS Liquid Glass Navigation Bar (Strictly Main App Header Only) */
    "html.atv-lg-on [data-testid='header'][data-atv-lg='bar'],",
    "html.atv-lg-on .header--color[data-atv-lg='bar'],",
    "html.atv-lg-on header.landing-page-header[data-atv-lg='bar'],",
    "html.atv-lg-on header.header[data-atv-lg='bar'] {",
    "  position: fixed !important;",
    "  top: 10px !important;",
    "  left: 16px !important;",
    "  right: 16px !important;",
    "  width: auto !important;",
    "  height: 50px !important;",
    "  z-index: 950 !important;",
    "  border-radius: 25px !important;",
    "  padding: 0 14px !important;",
    "  display: flex !important;",
    "  align-items: center !important;",
    "  box-shadow:",
    "    0 18px 44px rgba(0, 0, 0, 0.52),",
    "    0 2px 10px rgba(0, 0, 0, 0.30),",
    "    inset 0 1.2px 0.8px rgba(255, 255, 255, 0.58),",
    "    inset 0 -1px 1.5px rgba(0, 0, 0, 0.40) !important;",
    "}",
    "html.atv-lg-on [data-testid='header'] .header__contents,",
    "html.atv-lg-on .header .header__contents {",
    "  max-width: 100% !important;",
    "  width: 100% !important;",
    "  height: 100% !important;",
    "  margin: 0 !important;",
    "  padding: 0 4px !important;",
    "  display: flex !important;",
    "  align-items: center !important;",
    "  justify-content: space-between !important;",
    "  gap: 14px !important;",
    "}",
    "html.atv-lg-on .header__open {",
    "  display: flex !important;",
    "  align-items: center !important;",
    "  gap: 10px !important;",
    "  flex: 1 1 0 !important;",
    "  min-width: 0 !important;",
    "}",
    "html.atv-lg-on .header__tabs {",
    "  display: flex !important;",
    "  align-items: center !important;",
    "  justify-content: center !important;",
    "  flex: 0 0 auto !important;",
    "}",
    "html.atv-lg-on .header__controls {",
    "  display: flex !important;",
    "  align-items: center !important;",
    "  justify-content: flex-end !important;",
    "  gap: 10px !important;",
    "  flex: 1 1 0 !important;",
    "  min-width: 0 !important;",
    "}",
    "html.atv-lg-on .header__controls > * {",
    "  margin: 0 !important;",
    "  flex: 0 0 auto !important;",
    "}",

    /* macOS Window Traffic Lights + Toolbar Controls inside Top Bar */
    "#atv-lg-mac-left {",
    "  display: inline-flex;",
    "  align-items: center;",
    "  gap: 10px;",
    "  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;",
    "}",
    ".atv-lg-traffic {",
    "  display: inline-flex;",
    "  align-items: center;",
    "  gap: 7px;",
    "  padding: 0 4px 0 2px;",
    "}",
    ".atv-lg-dot {",
    "  width: 12px;",
    "  height: 12px;",
    "  border-radius: 50%;",
    "  border: 1px solid rgba(0, 0, 0, 0.25);",
    "  padding: 0;",
    "  cursor: pointer;",
    "  position: relative;",
    "  box-shadow: inset 0 1px 0.5px rgba(255, 255, 255, 0.35);",
    "  transition: transform 0.14s ease, filter 0.14s ease;",
    "}",
    ".atv-lg-dot:hover { transform: scale(1.1); filter: brightness(1.08); }",
    ".atv-lg-dot-close { background: #ff5f57; }",
    ".atv-lg-dot-min { background: #febc2e; }",
    ".atv-lg-dot-max { background: #28c840; }",
    ".atv-lg-mac-cluster {",
    "  display: inline-flex;",
    "  align-items: center;",
    "  gap: 2px;",
    "  padding: 2px;",
    "  border-radius: 999px;",
    "  background: rgba(255, 255, 255, 0.08);",
    "  border: 1px solid rgba(255, 255, 255, 0.16);",
    "  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.28);",
    "}",
    ".atv-lg-mac-btn {",
    "  width: 28px;",
    "  height: 28px;",
    "  border: none;",
    "  border-radius: 999px;",
    "  background: transparent;",
    "  color: rgba(255, 255, 255, 0.88);",
    "  display: inline-flex;",
    "  align-items: center;",
    "  justify-content: center;",
    "  cursor: pointer;",
    "  padding: 0;",
    "  transition: background 0.16s ease, color 0.16s ease, transform 0.14s ease;",
    "}",
    ".atv-lg-mac-btn:hover {",
    "  background: rgba(255, 255, 255, 0.18);",
    "  color: #ffffff;",
    "}",
    ".atv-lg-mac-btn:active { transform: scale(0.92); }",
    ".atv-lg-mac-btn[aria-pressed='true'] {",
    "  background: rgba(255, 255, 255, 0.24);",
    "  color: #ffffff;",
    "}",
    ".atv-lg-mac-btn svg {",
    "  width: 15px;",
    "  height: 15px;",
    "  fill: none;",
    "  stroke: currentColor;",
    "  stroke-width: 1.9;",
    "  stroke-linecap: round;",
    "  stroke-linejoin: round;",
    "}",

    /* macOS Segmented Glass Pill Navigation Tabs */
    "html.atv-lg-on .navigation-tabs ul {",
    "  display: inline-flex !important;",
    "  align-items: center !important;",
    "  gap: 3px !important;",
    "  padding: 3px !important;",
    "  margin: 0 !important;",
    "  list-style: none !important;",
    "  border-radius: 999px !important;",
    "  background: rgba(0, 0, 0, 0.30) !important;",
    "  border: 1px solid rgba(255, 255, 255, 0.15) !important;",
    "  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.38) !important;",
    "}",
    "html.atv-lg-on .navigation-tabs li {",
    "  margin: 0 !important;",
    "  padding: 0 !important;",
    "  border: none !important;",
    "}",
    "html.atv-lg-on .navigation-tabs li::before,",
    "html.atv-lg-on .navigation-tabs li::after,",
    "html.atv-lg-on .navigation-tabs a::before,",
    "html.atv-lg-on .navigation-tabs a::after {",
    "  display: none !important;",
    "  content: none !important;",
    "}",
    "html.atv-lg-on .navigation-tabs a {",
    "  display: inline-flex !important;",
    "  align-items: center !important;",
    "  justify-content: center !important;",
    "  height: 28px !important;",
    "  padding: 0 16px !important;",
    "  border-radius: 999px !important;",
    "  font-size: 13px !important;",
    "  font-weight: 600 !important;",
    "  letter-spacing: -0.01em !important;",
    "  color: rgba(255, 255, 255, 0.72) !important;",
    "  text-decoration: none !important;",
    "  transition: background 0.18s ease, color 0.18s ease, box-shadow 0.18s ease !important;",
    "}",
    "html.atv-lg-on .navigation-tabs a:hover {",
    "  color: #ffffff !important;",
    "  background: rgba(255, 255, 255, 0.10) !important;",
    "}",
    "html.atv-lg-on .navigation-tabs li.current-tab a,",
    "html.atv-lg-on .navigation-tabs li[aria-current='page'] a {",
    "  color: #ffffff !important;",
    "  background: rgba(255, 255, 255, 0.22) !important;",
    "  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.32), inset 0 1px 0.6px rgba(255, 255, 255, 0.62) !important;",
    "}",

    /* macOS User Profile Trigger Button */
    "html.atv-lg-on .account-menu .contextual-menu__trigger,",
    "#atv-lg-profile-btn {",
    "  width: 32px !important;",
    "  height: 32px !important;",
    "  border-radius: 50% !important;",
    "  border: 1.5px solid rgba(255, 255, 255, 0.48) !important;",
    "  background: rgba(255, 255, 255, 0.12) !important;",
    "  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35), inset 0 1px 0.5px rgba(255, 255, 255, 0.6) !important;",
    "  display: inline-flex !important;",
    "  align-items: center !important;",
    "  justify-content: center !important;",
    "  padding: 0 !important;",
    "  cursor: pointer !important;",
    "  overflow: hidden !important;",
    "  transition: transform 0.16s ease, border-color 0.16s ease !important;",
    "}",
    "html.atv-lg-on .account-menu .contextual-menu__trigger:hover,",
    "#atv-lg-profile-btn:hover {",
    "  transform: scale(1.06) !important;",
    "  border-color: rgba(255, 255, 255, 0.85) !important;",
    "}",
    "html.atv-lg-on .account-menu img[data-testid='account-menu-avatar'] {",
    "  width: 100% !important;",
    "  height: 100% !important;",
    "  object-fit: cover !important;",
    "  border-radius: 50% !important;",
    "}",
    "html.atv-lg-on .header__controls:has(.auth-content__is-signed-in) #atv-lg-profile-btn,",
    "html.atv-lg-on .header__controls:has(.account-menu) #atv-lg-profile-btn {",
    "  display: none !important;",
    "}",

    /* Style Apple's native <amp-contextual-menu> in macOS Liquid Glass */
    "amp-contextual-menu {",
    "  z-index: 2147483000 !important;",
    "}",
    "amp-contextual-menu .contextual-menu {",
    "  margin-top: 36px !important;",
    "  background: rgba(24, 26, 36, 0.76) !important;",
    "  backdrop-filter: blur(24px) saturate(185%) !important;",
    "  -webkit-backdrop-filter: blur(24px) saturate(185%) !important;",
    "  border: 1px solid rgba(255, 255, 255, 0.28) !important;",
    "  border-radius: 16px !important;",
    "  padding: 6px !important;",
    "  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.62), inset 0 1px 0.8px rgba(255, 255, 255, 0.5) !important;",
    "}",
    "amp-contextual-menu .contextual-menu-item button {",
    "  border-radius: 10px !important;",
    "  transition: background 0.14s ease !important;",
    "}",
    "amp-contextual-menu .contextual-menu-item button:hover {",
    "  background: rgba(10, 132, 255, 0.82) !important;",
    "  color: #ffffff !important;",
    "}",

    /* Interactive Liquid Glass Pills & Buttons */
    "html.atv-lg-on [data-atv-lg='pill'],",
    "html.atv-lg-on [data-atv-lg='circle'] {",
    "  border-radius: 999px !important;",
    "  box-shadow:",
    "    0 8px 22px rgba(0, 0, 0, 0.34),",
    "    inset 0 1.2px 0.8px rgba(255, 255, 255, 0.62),",
    "    inset 0 -1px 1px rgba(0, 0, 0, 0.35) !important;",
    "  color: #ffffff !important;",
    "  transition: transform 0.2s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.2s ease !important;",
    "}",
    /* Primary top capsule button: white button -> opposite black text and play icon */
    "html.atv-lg-on button.theme-primary,",
    "html.atv-lg-on button.theme-primary *,",
    "html.atv-lg-on [data-testid='capsule-button'].theme-primary,",
    "html.atv-lg-on [data-testid='capsule-button'].theme-primary * {",
    "  color: #000000 !important;",
    "  fill: #000000 !important;",
    "  stroke: #000000 !important;",
    "}",
    "html.atv-lg-on button.theme-primary svg,",
    "html.atv-lg-on [data-testid='capsule-button'].theme-primary svg {",
    "  fill: #000000 !important;",
    "  color: #000000 !important;",
    "}",
    "html.atv-lg-on button.theme-primary .ResourceImagePlayGlyph,",
    "html.atv-lg-on [data-testid='capsule-button'].theme-primary .ResourceImagePlayGlyph {",
    "  background-color: #000000 !important;",
    "}",
    "html.atv-lg-on [data-atv-lg='pill'] .search-input-container,",
    "html.atv-lg-on [data-atv-lg='pill'] form,",
    "html.atv-lg-on [data-atv-lg='pill'] input {",
    "  background: transparent !important;",
    "  border: none !important;",
    "  box-shadow: none !important;",
    "  color: #ffffff !important;",
    "}",
    "html.atv-lg-on [data-atv-lg='pill']:hover,",
    "html.atv-lg-on [data-atv-lg='circle']:hover {",
    "  transform: scale(1.035);",
    "  border-color: rgba(255, 255, 255, 0.52) !important;",
    "}",
    "html.atv-lg-on [data-atv-lg='pill']:active,",
    "html.atv-lg-on [data-atv-lg='circle']:active {",
    "  transform: scale(0.97);",
    "}",

    /* Panels & Popovers */
    "html.atv-lg-on [data-atv-lg='panel'] {",
    "  border-radius: 24px !important;",
    "  box-shadow:",
    "    0 24px 64px rgba(0, 0, 0, 0.58),",
    "    inset 0 1.5px 1px rgba(255, 255, 255, 0.52) !important;",
    "}",

    /* VisionOS Liquid Glass Video Player Controls */
    "html.atv-lg-on amp-playback-controls-unified,",
    "html.atv-lg-on .unified-controls {",
    "  width: auto !important;",
    "  max-width: none !important;",
    "  display: flex !important;",
    "  align-items: center !important;",
    "  justify-content: center !important;",
    "  gap: 40px !important;",
    "  height: 100px !important;",
    "  overflow: visible !important;",
    "}",

    /* Center Play/Pause Liquid Glass Lens */
    "html.atv-lg-on amp-playback-controls-play {",
    "  width: 92px !important;",
    "  height: 92px !important;",
    "  border-radius: 50% !important;",
    "  display: flex !important;",
    "  align-items: center !important;",
    "  justify-content: center !important;",
    "  position: relative !important;",
    "  cursor: pointer !important;",
    "  border: 1.5px solid rgba(255, 255, 255, 0.55) !important;",
    "  box-shadow:",
    "    0 18px 52px rgba(0, 0, 0, 0.70),",
    "    0 2px 12px rgba(0, 0, 0, 0.40),",
    "    inset 0 2.5px 2px rgba(255, 255, 255, 0.95),",
    "    inset 0 -2px 2px rgba(0, 0, 0, 0.45) !important;",
    "  transition: transform 0.22s cubic-bezier(0.2, 0.9, 0.3, 1), box-shadow 0.22s ease, filter 0.22s ease !important;",
    "}",
    "html.atv-lg-on amp-playback-controls-play:hover {",
    "  transform: scale(1.08) !important;",
    "  filter: brightness(1.18) !important;",
    "  box-shadow:",
    "    0 22px 60px rgba(0, 0, 0, 0.80),",
    "    inset 0 3px 2px rgba(255, 255, 255, 1.0),",
    "    inset 0 -2px 2px rgba(0, 0, 0, 0.45) !important;",
    "}",
    "html.atv-lg-on amp-playback-controls-play:active {",
    "  transform: scale(0.96) !important;",
    "}",
    "html.atv-lg-on amp-playback-controls-play > button {",
    "  width: 100% !important;",
    "  height: 100% !important;",
    "  position: absolute !important;",
    "  inset: 0 !important;",
    "  display: flex !important;",
    "  align-items: center !important;",
    "  justify-content: center !important;",
    "  background: transparent !important;",
    "  border: none !important;",
    "  padding: 0 !important;",
    "  cursor: pointer !important;",
    "}",
    "html.atv-lg-on amp-playback-controls-play > button[aria-hidden='true'] {",
    "  display: none !important;",
    "}",
    "html.atv-lg-on amp-playback-controls-play > button:not([aria-hidden='true']) {",
    "  display: flex !important;",
    "  align-items: center !important;",
    "  justify-content: center !important;",
    "}",
    "html.atv-lg-on amp-playback-controls-play amp-icon {",
    "  display: flex !important;",
    "  align-items: center !important;",
    "  justify-content: center !important;",
    "  width: 40px !important;",
    "  height: 40px !important;",
    "  margin: 0 auto !important;",
    "}",
    "html.atv-lg-on amp-playback-controls-play svg {",
    "  width: 40px !important;",
    "  height: 40px !important;",
    "  fill: #ffffff !important;",
    "  color: #ffffff !important;",
    "  margin: 0 !important;",
    "  display: block !important;",
    "  filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.65)) !important;",
    "}",
    "html.atv-lg-on amp-playback-controls-play [name='play'] svg,",
    "html.atv-lg-on amp-playback-controls-play [name='play.fill'] svg {",
    "  transform: translateX(2.5px) !important;",
    "}",
    "html.atv-lg-on amp-playback-controls-play .button__label {",
    "  display: none !important;",
    "}",

    /* 10s Rewind and 10s Forward Circular Glass Buttons */
    "html.atv-lg-on amp-playback-controls-skip {",
    "  width: 68px !important;",
    "  height: 68px !important;",
    "  display: flex !important;",
    "  align-items: center !important;",
    "  justify-content: center !important;",
    "}",
    "html.atv-lg-on .skip-control.button--back,",
    "html.atv-lg-on .skip-control.button--forward {",
    "  width: 68px !important;",
    "  height: 68px !important;",
    "  border-radius: 50% !important;",
    "  display: flex !important;",
    "  align-items: center !important;",
    "  justify-content: center !important;",
    "  position: relative !important;",
    "  cursor: pointer !important;",
    "  padding: 0 !important;",
    "  border: 1.4px solid rgba(255, 255, 255, 0.48) !important;",
    "  box-shadow:",
    "    0 12px 36px rgba(0, 0, 0, 0.58),",
    "    0 2px 8px rgba(0, 0, 0, 0.35),",
    "    inset 0 2px 1.5px rgba(255, 255, 255, 0.85),",
    "    inset 0 -1.5px 1.5px rgba(0, 0, 0, 0.38) !important;",
    "  transition: transform 0.2s cubic-bezier(0.2, 0.9, 0.3, 1), box-shadow 0.2s ease, filter 0.2s ease !important;",
    "}",
    "html.atv-lg-on .skip-control.button--back:hover,",
    "html.atv-lg-on .skip-control.button--forward:hover {",
    "  transform: scale(1.08) !important;",
    "  filter: brightness(1.18) !important;",
    "  box-shadow:",
    "    0 16px 44px rgba(0, 0, 0, 0.68),",
    "    inset 0 2.5px 2px rgba(255, 255, 255, 0.95),",
    "    inset 0 -1.5px 1.5px rgba(0, 0, 0, 0.38) !important;",
    "}",
    "html.atv-lg-on .skip-control.button--back:active,",
    "html.atv-lg-on .skip-control.button--forward:active {",
    "  transform: scale(0.95) !important;",
    "}",
    "html.atv-lg-on .skip-control svg {",
    "  width: 34px !important;",
    "  height: 34px !important;",
    "  fill: #ffffff !important;",
    "  color: #ffffff !important;",
    "  filter: drop-shadow(0 2px 5px rgba(0, 0, 0, 0.55)) !important;",
    "}",
    "html.atv-lg-on .skip-control .skip-control__label {",
    "  display: none !important;",
    "}",

    /* Top-Left Close Button Circular Glass Lens */
    "html.atv-lg-on button.close-button.svelte-19l0lnx,",
    "html.atv-lg-on button.close-button[data-testid='close-button'] {",
    "  width: 44px !important;",
    "  height: 44px !important;",
    "  border-radius: 50% !important;",
    "  display: flex !important;",
    "  align-items: center !important;",
    "  justify-content: center !important;",
    "  cursor: pointer !important;",
    "  padding: 0 !important;",
    "  border: 1.2px solid rgba(255, 255, 255, 0.42) !important;",
    "  box-shadow:",
    "    0 10px 28px rgba(0, 0, 0, 0.50),",
    "    inset 0 1.5px 1px rgba(255, 255, 255, 0.80),",
    "    inset 0 -1px 1px rgba(0, 0, 0, 0.35) !important;",
    "  transition: transform 0.2s ease, filter 0.2s ease !important;",
    "}",
    "html.atv-lg-on button.close-button.svelte-19l0lnx:hover,",
    "html.atv-lg-on button.close-button[data-testid='close-button']:hover {",
    "  transform: scale(1.08) !important;",
    "  filter: brightness(1.20) !important;",
    "}",
    "html.atv-lg-on button.close-button svg {",
    "  width: 18px !important;",
    "  height: 18px !important;",
    "  fill: #ffffff !important;",
    "  color: #ffffff !important;",
    "}",

    /* Top-Right Volume Control Floating Glass Pill */
    "html.atv-lg-on .volume-unified {",
    "  display: inline-grid !important;",
    "  grid-template-columns: 100px 28px !important;",
    "  column-gap: 12px !important;",
    "  align-items: center !important;",
    "  height: 44px !important;",
    "  padding: 0 16px 0 18px !important;",
    "  border-radius: 9999px !important;",
    "  border: 1.2px solid rgba(255, 255, 255, 0.38) !important;",
    "  box-shadow:",
    "    0 10px 30px rgba(0, 0, 0, 0.50),",
    "    inset 0 1.5px 1px rgba(255, 255, 255, 0.75),",
    "    inset 0 -1px 1px rgba(0, 0, 0, 0.35) !important;",
    "  box-sizing: border-box !important;",
    "}",
    "html.atv-lg-on .volume-unified__indicator {",
    "  display: flex !important;",
    "  align-items: center !important;",
    "  justify-content: center !important;",
    "  background: transparent !important;",
    "  border: none !important;",
    "  cursor: pointer !important;",
    "  padding: 0 !important;",
    "}",
    "html.atv-lg-on .volume-unified__icon {",
    "  width: 22px !important;",
    "  height: 22px !important;",
    "  fill: #ffffff !important;",
    "  color: #ffffff !important;",
    "}",
    "html.atv-lg-on .volume-unified__label {",
    "  display: none !important;",
    "}",

    /* Video Player Footer Grid Layout (Prevents Scrubber and Tabs Collision) */
    "html.atv-lg-on .scrim__footer,",
    "html.atv-lg-on .video-player__footer {",
    "  height: auto !important;",
    "  min-height: 165px !important;",
    "  grid-template-rows: auto 14px 48px 18px auto !important;",
    "  overflow: visible !important;",
    "}",

    /* Floating Liquid Glass Pill Scrubber Bar */
    "html.atv-lg-on .video-player__progress {",
    "  height: 48px !important;",
    "  border-radius: 9999px !important;",
    "  padding: 0 22px !important;",
    "  display: flex !important;",
    "  align-items: center !important;",
    "  overflow: visible !important;",
    "  isolation: auto !important;",
    "  border: 1.2px solid rgba(255, 255, 255, 0.38) !important;",
    "  box-shadow:",
    "    0 12px 36px rgba(0, 0, 0, 0.58),",
    "    inset 0 1.5px 1.2px rgba(255, 255, 255, 0.80),",
    "    inset 0 -1px 1px rgba(0, 0, 0, 0.35) !important;",
    "  box-sizing: border-box !important;",
    "  margin: 0 !important;",
    "  z-index: 50 !important;",
    "}",
    "html.atv-lg-on amp-playback-controls-progress {",
    "  width: 100% !important;",
    "  height: 100% !important;",
    "  display: grid !important;",
    "  grid-template-columns: auto 1fr auto !important;",
    "  column-gap: 16px !important;",
    "  align-items: center !important;",
    "  overflow: visible !important;",
    "}",

    /* Bottom-Right Secondary Controls Pill Container */
    "html.atv-lg-on .video-player__controls {",
    "  display: inline-flex !important;",
    "  align-items: center !important;",
    "  justify-content: center !important;",
    "  gap: 18px !important;",
    "  height: 44px !important;",
    "  padding: 0 18px !important;",
    "  border-radius: 9999px !important;",
    "  border: 1.2px solid rgba(255, 255, 255, 0.38) !important;",
    "  box-shadow:",
    "    0 10px 32px rgba(0, 0, 0, 0.50),",
    "    inset 0 1.5px 1.2px rgba(255, 255, 255, 0.75),",
    "    inset 0 -1px 1px rgba(0, 0, 0, 0.35) !important;",
    "  box-sizing: border-box !important;",
    "}",
    "html.atv-lg-on .video-player__control.unsupported,",
    "html.atv-lg-on amp-jump-to-live-control.unsupported {",
    "  display: none !important;",
    "}",
    "html.atv-lg-on .video-player__controls button,",
    "html.atv-lg-on .video-player__controls label,",
    "html.atv-lg-on .video-player__control {",
    "  color: #ffffff !important;",
    "  fill: #ffffff !important;",
    "  cursor: pointer !important;",
    "  transition: transform 0.15s ease, filter 0.15s ease !important;",
    "}",
    "html.atv-lg-on .video-player__controls button:hover,",
    "html.atv-lg-on .video-player__controls label:hover {",
    "  transform: scale(1.12) !important;",
    "  filter: brightness(1.20) !important;",
    "}",
    "html.atv-lg-on .atv-lg-player-gear {",
    "  display: inline-flex !important;",
    "  align-items: center !important;",
    "  justify-content: center !important;",
    "  width: 24px !important;",
    "  height: 24px !important;",
    "  border: none !important;",
    "  background: transparent !important;",
    "  cursor: pointer !important;",
    "  padding: 0 !important;",
    "  margin: 0 !important;",
    "  color: #ffffff !important;",
    "  fill: #ffffff !important;",
    "  opacity: 0.88 !important;",
    "  transition: transform 0.2s cubic-bezier(0.2, 0.9, 0.3, 1), opacity 0.2s ease, color 0.2s ease !important;",
    "}",
    "html.atv-lg-on .atv-lg-player-gear:hover {",
    "  transform: scale(1.18) !important;",
    "  opacity: 1 !important;",
    "  color: #2997ff !important;",
    "  fill: #2997ff !important;",
    "}",
    "html.atv-lg-on .atv-lg-player-gear svg {",
    "  width: 17px !important;",
    "  height: 17px !important;",
    "  display: block !important;",
    "  pointer-events: none !important;",
    "}",

    /* Un-clip Tab Containers so the blue glow expands 360° without being cut */
    "html.atv-lg-on .player-tabs,",
    "html.atv-lg-on .player-tab,",
    "html.atv-lg-on .tabs,",
    "html.atv-lg-on .tabs__nav,",
    "html.atv-lg-on .tab-list,",
    "html.atv-lg-on amp-tabs,",
    "html.atv-lg-on amp-playback-controls-footer,",
    "html.atv-lg-on .scrim__footer,",
    "html.atv-lg-on .video-player__footer,",
    "html.atv-lg-on .video-player__bottom-bar,",
    "html.atv-lg-on .video-player__tabs,",
    "html.atv-lg-on .playback-controls__tabs,",
    "html.atv-lg-on [data-testid=\"playback-controls-footer\"],",
    "html.atv-lg-on .scrim__tabs {",
    "  overflow: visible !important;",
    "  contain: none !important;",
    "  clip-path: none !important;",
    "  -webkit-clip-path: none !important;",
    "}",

    /* Bottom-Left Tabs: Info & Continue Watching Liquid Glass Pills */
    "html.atv-lg-on button.player-tab__trigger {",
    "  height: 38px !important;",
    "  padding: 0 20px !important;",
    "  border-radius: 9999px !important;",
    "  display: inline-flex !important;",
    "  align-items: center !important;",
    "  justify-content: center !important;",
    "  border: 1.2px solid rgba(255, 255, 255, 0.38) !important;",
    "  box-shadow:",
    "    0 8px 24px rgba(0, 0, 0, 0.45),",
    "    inset 0 1.2px 1px rgba(255, 255, 255, 0.70),",
    "    inset 0 -1px 1px rgba(0, 0, 0, 0.30) !important;",
    "  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif !important;",
    "  font-size: 13px !important;",
    "  font-weight: 600 !important;",
    "  color: #ffffff !important;",
    "  cursor: pointer !important;",
    "  position: relative !important;",
    "  z-index: 50 !important;",
    "  overflow: visible !important;",
    "  transition: transform 0.15s ease, filter 0.15s ease, background-color 0.15s ease !important;",
    "}",
    "html.atv-lg-on button.player-tab__trigger:hover {",
    "  transform: scale(1.06) !important;",
    "  filter: brightness(1.15) !important;",
    "}",
    "html.atv-lg-on button.player-tab__trigger:active {",
    "  transform: scale(0.96) !important;",
    "}",
    "html.atv-lg-on button.player-tab__trigger[aria-selected=\"true\"],",
    "html.atv-lg-on button.player-tab__trigger[aria-expanded=\"true\"],",
    "html.atv-lg-on button.player-tab__trigger.active,",
    "html.atv-lg-on button.player-tab__trigger.selected,",
    "html.atv-lg-on button.player-tab__trigger--active,",
    "html.atv-lg-on button.player-tab__trigger--selected {",
    "  background-color: #276bff !important;",
    "  background-image: none !important;",
    "  border-color: rgba(255, 255, 255, 0.85) !important;",
    "  color: #ffffff !important;",
    "  font-weight: 700 !important;",
    "  box-shadow: 0 0 24px rgba(39, 107, 255, 0.80), 0 4px 14px rgba(39, 107, 255, 0.50) !important;",
    "  backdrop-filter: none !important;",
    "  -webkit-backdrop-filter: none !important;",
    "  position: relative !important;",
    "  z-index: 60 !important;",
    "  overflow: visible !important;",
    "}",

    /* Floating macOS Liquid Glass Sidebar (Modern GPU-accelerated CSS Liquid Glass) */
    "#atv-lg-mac-sidebar {",
    "  position: fixed;",
    "  top: 70px;",
    "  left: 16px;",
    "  bottom: 16px;",
    "  width: 220px;",
    "  z-index: 945;",
    "  border-radius: 22px;",
    "  padding: 14px 12px;",
    "  display: flex;",
    "  flex-direction: column;",
    "  justify-content: space-between;",
    "  color: #ffffff;",
    "  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif;",
    "  background: radial-gradient(130% 100% at 50% 0%, rgba(255, 255, 255, 0.22) 0%, rgba(255, 255, 255, 0.05) 50%, rgba(0, 0, 0, 0.20) 100%), rgba(18, 22, 34, 0.35) !important;",
    "  backdrop-filter: blur(48px) saturate(210%) brightness(1.12);",
    "  -webkit-backdrop-filter: blur(48px) saturate(210%) brightness(1.12);",
    "  border: 1.2px solid rgba(255, 255, 255, 0.35) !important;",
    "  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55), inset 0 1.5px 1.5px rgba(255, 255, 255, 0.65), inset 0 -1.5px 2px rgba(0, 0, 0, 0.35) !important;",
    "  box-sizing: border-box;",
    "  transition: opacity 0.26s ease, transform 0.28s cubic-bezier(0.22, 1, 0.36, 1);",
    "}",
    "#atv-lg-mac-sidebar.atv-lg-closed {",
    "  opacity: 0;",
    "  visibility: hidden !important;",
    "  pointer-events: none !important;",
    "  backdrop-filter: none !important;",
    "  -webkit-backdrop-filter: none !important;",
    "  transform: translateX(-248px);",
    "}",
    "#atv-lg-mac-sidebar .lg-sb-nav,",
    "#atv-lg-mac-sidebar .lg-sb-footer {",
    "  position: relative;",
    "  z-index: 2;",
    "  isolation: isolate;",
    "}",
    "#atv-lg-mac-sidebar .lg-sb-nav {",
    "  display: flex;",
    "  flex-direction: column;",
    "  gap: 3px;",
    "  overflow-y: auto;",
    "}",
    "#atv-lg-mac-sidebar .lg-sb-section {",
    "  font-size: 11px;",
    "  font-weight: 700;",
    "  letter-spacing: 0.02em;",
    "  color: rgba(255, 255, 255, 0.46);",
    "  padding: 12px 10px 4px;",
    "  text-shadow: none !important;",
    "}",
    "#atv-lg-mac-sidebar .lg-sb-item {",
    "  position: relative;",
    "  z-index: 2;",
    "  isolation: isolate;",
    "  display: flex;",
    "  align-items: center;",
    "  gap: 10px;",
    "  width: 100%;",
    "  height: 34px;",
    "  padding: 0 11px;",
    "  border: none;",
    "  border-radius: 10px;",
    "  background: transparent;",
    "  color: rgba(255, 255, 255, 0.88);",
    "  font-family: inherit;",
    "  font-size: 13px;",
    "  font-weight: 500;",
    "  text-align: left;",
    "  cursor: pointer;",
    "  backdrop-filter: none !important;",
    "  -webkit-backdrop-filter: none !important;",
    "  text-shadow: none !important;",
    "  transition: background 0.16s ease, color 0.16s ease;",
    "}",
    "#atv-lg-mac-sidebar .lg-sb-item:hover {",
    "  background: rgba(255, 255, 255, 0.14);",
    "  color: #ffffff;",
    "}",
    "#atv-lg-mac-sidebar .lg-sb-item.lg-sb-search {",
    "  background: rgba(255, 255, 255, 0.08);",
    "  color: rgba(255, 255, 255, 0.88);",
    "  font-weight: 500;",
    "  margin-bottom: 6px;",
    "  border: 1px solid rgba(255, 255, 255, 0.16);",
    "  box-shadow: none !important;",
    "}",
    "#atv-lg-mac-sidebar .lg-sb-item.lg-sb-search:hover {",
    "  background: rgba(255, 255, 255, 0.16);",
    "  border-color: rgba(255, 255, 255, 0.30);",
    "  color: #ffffff;",
    "}",
    "#atv-lg-mac-sidebar .lg-sb-item.lg-sb-active {",
    "  background: #0a84ff !important;",
    "  color: #ffffff !important;",
    "  font-weight: 600 !important;",
    "  border: 1px solid rgba(255, 255, 255, 0.28) !important;",
    "  box-shadow: 0 4px 14px rgba(10, 132, 255, 0.40) !important;",
    "}",
    "#atv-lg-mac-sidebar .lg-sb-item.lg-sb-active:hover {",
    "  background: #2090ff !important;",
    "  color: #ffffff !important;",
    "}",
    "#atv-lg-mac-sidebar .lg-sb-item svg {",
    "  width: 16px;",
    "  height: 16px;",
    "  flex: 0 0 16px;",
    "  fill: none;",
    "  stroke: currentColor;",
    "  stroke-width: 1.9;",
    "  stroke-linecap: round;",
    "  stroke-linejoin: round;",
    "}",
    "#atv-lg-mac-sidebar .lg-sb-footer {",
    "  padding-top: 10px;",
    "  border-top: 1px solid rgba(255, 255, 255, 0.14);",
    "}",
    "#atv-lg-mac-sidebar .lg-sb-profile {",
    "  position: relative;",
    "  z-index: 2;",
    "  isolation: isolate;",
    "  display: flex;",
    "  align-items: center;",
    "  justify-content: space-between;",
    "  width: 100%;",
    "  padding: 6px 10px;",
    "  border-radius: 14px;",
    "  border: 1px solid rgba(255, 255, 255, 0.18);",
    "  background: rgba(255, 255, 255, 0.08);",
    "  color: #ffffff;",
    "  font-family: inherit;",
    "  cursor: pointer;",
    "  backdrop-filter: blur(16px);",
    "  -webkit-backdrop-filter: blur(16px);",
    "  box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.20);",
    "  text-shadow: none !important;",
    "  transition: background 0.16s ease, border-color 0.16s ease;",
    "}",
    "#atv-lg-mac-sidebar .lg-sb-profile:hover {",
    "  background: rgba(255, 255, 255, 0.16);",
    "  border-color: rgba(255, 255, 255, 0.32);",
    "}",
    "#atv-lg-mac-sidebar .lg-sb-profile-info {",
    "  display: flex;",
    "  align-items: center;",
    "  gap: 9px;",
    "  min-width: 0;",
    "  flex: 1;",
    "  overflow: hidden;",
    "}",
    "#atv-lg-mac-sidebar .lg-sb-avatar {",
    "  width: 28px;",
    "  height: 28px;",
    "  border-radius: 50%;",
    "  background: rgba(255, 255, 255, 0.18);",
    "  border: 1px solid rgba(255, 255, 255, 0.45);",
    "  display: inline-flex;",
    "  align-items: center;",
    "  justify-content: center;",
    "  overflow: hidden;",
    "  flex: 0 0 28px;",
    "}",
    "#atv-lg-mac-sidebar .lg-sb-avatar img {",
    "  width: 100%;",
    "  height: 100%;",
    "  object-fit: cover;",
    "}",
    "#atv-lg-mac-sidebar .lg-sb-name {",
    "  font-size: 12.5px;",
    "  font-weight: 600;",
    "  white-space: nowrap;",
    "  overflow: hidden;",
    "  text-overflow: ellipsis;",
    "  max-width: 116px;",
    "  display: inline-block;",
    "  text-shadow: none !important;",
    "}",
    "#atv-lg-mac-sidebar .lg-sb-gear {",
    "  display: flex;",
    "  align-items: center;",
    "  justify-content: center;",
    "  width: 16px;",
    "  height: 16px;",
    "  flex: 0 0 16px;",
    "  color: rgba(255, 255, 255, 0.78);",
    "  margin-left: 6px;",
    "  transition: color 0.16s ease, transform 0.24s cubic-bezier(0.22, 1, 0.36, 1);",
    "}",
    "#atv-lg-mac-sidebar .lg-sb-gear svg {",
    "  width: 16px;",
    "  height: 16px;",
    "  fill: currentColor !important;",
    "  color: inherit !important;",
    "  stroke: none !important;",
    "}",
    "#atv-lg-mac-sidebar .lg-sb-profile:hover .lg-sb-gear {",
    "  color: #ffffff;",
    "  transform: rotate(30deg);",
    "}",

    /* Fallback User Profile Dropdown Menu (Crisp GPU CSS Glass) */
    "#atv-lg-user-menu {",
    "  position: fixed;",
    "  top: 66px;",
    "  right: 18px;",
    "  width: 220px;",
    "  z-index: 2147483000;",
    "  border-radius: 16px;",
    "  padding: 6px;",
    "  color: #ffffff;",
    "  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif;",
    "  background: rgba(22, 25, 36, 0.78) !important;",
    "  backdrop-filter: blur(28px) saturate(185%);",
    "  -webkit-backdrop-filter: blur(28px) saturate(185%);",
    "  border: 1px solid rgba(255, 255, 255, 0.20) !important;",
    "  box-shadow: 0 20px 50px rgba(0,0,0,0.62), inset 0 1px 0.8px rgba(255,255,255,0.45);",
    "  box-sizing: border-box;",
    "  transition: opacity 0.18s ease, transform 0.2s cubic-bezier(0.22, 1, 0.36, 1);",
    "}",
    "#atv-lg-user-menu.atv-lg-closed {",
    "  opacity: 0;",
    "  visibility: hidden !important;",
    "  pointer-events: none !important;",
    "  backdrop-filter: none !important;",
    "  -webkit-backdrop-filter: none !important;",
    "  transform: translateY(-6px) scale(0.97);",
    "}",
    "#atv-lg-user-menu .lg-um-item {",
    "  width: 100%;",
    "  height: 34px;",
    "  padding: 0 11px;",
    "  border: none;",
    "  border-radius: 10px;",
    "  background: transparent;",
    "  color: #ffffff;",
    "  font-family: inherit;",
    "  font-size: 13px;",
    "  font-weight: 500;",
    "  display: flex;",
    "  align-items: center;",
    "  justify-content: space-between;",
    "  cursor: pointer;",
    "  text-shadow: none !important;",
    "  transition: background 0.14s ease;",
    "}",
    "#atv-lg-user-menu .lg-um-item:hover {",
    "  background: rgba(10, 132, 255, 0.86);",
    "}",
    "#atv-lg-user-menu .lg-um-item svg {",
    "  width: 15px;",
    "  height: 15px;",
    "  fill: none;",
    "  stroke: currentColor;",
    "  stroke-width: 1.9;",
    "  stroke-linecap: round;",
    "  stroke-linejoin: round;",
    "}",
    "#atv-lg-user-menu .lg-um-sep {",
    "  height: 1px;",
    "  margin: 4px 8px;",
    "  background: rgba(255, 255, 255, 0.16);",
    "}",

    /* Account & Liquid Glass Settings Pop-up Modal (Crisp Unclipped Symmetrical Glass) */
    "#atv-lg-modal-backdrop {",
    "  position: fixed !important;",
    "  inset: 0 !important;",
    "  top: 0 !important;",
    "  left: 0 !important;",
    "  right: 0 !important;",
    "  bottom: 0 !important;",
    "  width: 100vw !important;",
    "  height: 100vh !important;",
    "  z-index: 2147483647 !important;",
    "  background: rgba(0, 0, 0, 0.65) !important;",
    "  backdrop-filter: blur(8px) !important;",
    "  -webkit-backdrop-filter: blur(8px) !important;",
    "  display: flex !important;",
    "  align-items: center !important;",
    "  justify-content: center !important;",
    "  padding: 20px !important;",
    "  box-sizing: border-box !important;",
    "  overflow-y: auto !important;",
    "  visibility: visible !important;",
    "  pointer-events: auto !important;",
    "  transition: opacity 0.22s ease !important;",
    "}",
    "#atv-lg-modal-backdrop.atv-lg-closed {",
    "  opacity: 0 !important;",
    "  visibility: hidden !important;",
    "  pointer-events: none !important;",
    "  backdrop-filter: none !important;",
    "  -webkit-backdrop-filter: none !important;",
    "}",
    "#atv-lg-popover {",
    "  position: relative !important;",
    "  z-index: 2147483647 !important;",
    "  pointer-events: auto !important;",
    "  width: 440px;",
    "  max-width: calc(100vw - 32px);",
    "  max-height: calc(100vh - 40px);",
    "  overflow-y: auto;",
    "  overflow-x: hidden;",
    "  padding: 22px 24px;",
    "  border-radius: 26px;",
    "  color: #ffffff;",
    "  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif;",
    "  background: radial-gradient(130% 130% at 50% 0%, rgba(255, 255, 255, 0.20) 0%, rgba(255, 255, 255, 0.05) 50%, rgba(0, 0, 0, 0.35) 100%), rgba(18, 22, 32, 0.55) !important;",
    "  backdrop-filter: blur(48px) saturate(210%) brightness(1.10);",
    "  -webkit-backdrop-filter: blur(48px) saturate(210%) brightness(1.10);",
    "  border: 1.2px solid rgba(255, 255, 255, 0.38) !important;",
    "  box-shadow: 0 32px 84px rgba(0, 0, 0, 0.72), 0 8px 24px rgba(0, 0, 0, 0.40), inset 0 1.5px 1.5px rgba(255, 255, 255, 0.75), inset 0 -1.5px 2px rgba(0, 0, 0, 0.45) !important;",
    "  box-sizing: border-box;",
    "  transition: transform 0.25s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.22s ease;",
    "}",
    "#atv-lg-modal-backdrop.atv-lg-closed #atv-lg-popover {",
    "  transform: scale(0.96) translateY(8px);",
    "}",
    "#atv-lg-popover * {",
    "  box-sizing: border-box;",
    "}",
    "#atv-lg-popover .lg-modal-header {",
    "  display: flex;",
    "  align-items: center;",
    "  justify-content: space-between;",
    "  padding-bottom: 14px;",
    "  margin-bottom: 14px;",
    "  border-bottom: 1px solid rgba(255, 255, 255, 0.16);",
    "}",
    "#atv-lg-popover .lg-modal-title {",
    "  font-size: 15px;",
    "  font-weight: 700;",
    "  letter-spacing: -0.01em;",
    "  text-shadow: none !important;",
    "}",
    "#atv-lg-popover .lg-close-btn {",
    "  height: 28px;",
    "  padding: 0 12px;",
    "  border-radius: 999px;",
    "  border: 1px solid rgba(255, 255, 255, 0.22);",
    "  background: rgba(255, 255, 255, 0.12);",
    "  color: #ffffff;",
    "  font-family: inherit;",
    "  font-size: 12px;",
    "  font-weight: 600;",
    "  cursor: pointer;",
    "  text-shadow: none !important;",
    "  transition: background 0.15s ease;",
    "}",
    "#atv-lg-popover .lg-close-btn:hover { background: rgba(255, 255, 255, 0.24); }",
    "#atv-lg-popover .lg-account-card {",
    "  display: flex;",
    "  align-items: center;",
    "  justify-content: space-between;",
    "  gap: 12px;",
    "  padding: 12px 14px;",
    "  border-radius: 18px;",
    "  background: rgba(255, 255, 255, 0.08);",
    "  border: 1px solid rgba(255, 255, 255, 0.18);",
    "  backdrop-filter: blur(20px);",
    "  -webkit-backdrop-filter: blur(20px);",
    "  box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.25);",
    "  margin-bottom: 14px;",
    "}",
    "#atv-lg-popover .lg-account-left {",
    "  display: flex;",
    "  align-items: center;",
    "  gap: 12px;",
    "  min-width: 0;",
    "}",
    "#atv-lg-popover .lg-account-avatar {",
    "  width: 42px;",
    "  height: 42px;",
    "  border-radius: 50%;",
    "  background: rgba(255, 255, 255, 0.16);",
    "  border: 1.5px solid rgba(255, 255, 255, 0.5);",
    "  display: flex;",
    "  align-items: center;",
    "  justify-content: center;",
    "  overflow: hidden;",
    "  flex: 0 0 42px;",
    "}",
    "#atv-lg-popover .lg-account-avatar img {",
    "  width: 100%;",
    "  height: 100%;",
    "  object-fit: cover;",
    "}",
    "#atv-lg-popover .lg-account-meta h4 {",
    "  margin: 0 0 2px;",
    "  font-size: 13.5px;",
    "  font-weight: 700;",
    "  color: #ffffff;",
    "  text-shadow: none !important;",
    "}",
    "#atv-lg-popover .lg-account-meta p {",
    "  margin: 0;",
    "  font-size: 11.5px;",
    "  color: rgba(255, 255, 255, 0.68);",
    "  text-shadow: none !important;",
    "}",
    "#atv-lg-popover .lg-account-actions {",
    "  display: flex;",
    "  gap: 6px;",
    "}",
    "#atv-lg-popover .lg-btn-pill {",
    "  height: 28px;",
    "  padding: 0 11px;",
    "  border-radius: 999px;",
    "  border: 1px solid rgba(255, 255, 255, 0.22);",
    "  background: rgba(255, 255, 255, 0.12);",
    "  color: #ffffff;",
    "  font-family: inherit;",
    "  font-size: 11.5px;",
    "  font-weight: 600;",
    "  cursor: pointer;",
    "  text-shadow: none !important;",
    "  transition: background 0.15s ease;",
    "}",
    "#atv-lg-popover .lg-btn-pill:hover { background: rgba(255, 255, 255, 0.24); }",
    "#atv-lg-popover .lg-btn-pill.lg-btn-primary {",
    "  background: #0a84ff;",
    "  border-color: rgba(255, 255, 255, 0.35);",
    "}",
    "#atv-lg-popover .lg-btn-pill.lg-btn-primary:hover { background: #2090ff; }",
    "#atv-lg-popover .lg-section-label {",
    "  font-size: 11px;",
    "  font-weight: 700;",
    "  text-transform: uppercase;",
    "  letter-spacing: 0.04em;",
    "  color: rgba(255, 255, 255, 0.55);",
    "  margin: 4px 0 10px;",
    "  display: flex;",
    "  justify-content: space-between;",
    "  text-shadow: none !important;",
    "}",
    "#atv-lg-popover .lg-switches-card {",
    "  border-radius: 18px;",
    "  background: rgba(255, 255, 255, 0.08);",
    "  border: 1px solid rgba(255, 255, 255, 0.18);",
    "  backdrop-filter: blur(20px);",
    "  -webkit-backdrop-filter: blur(20px);",
    "  box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.25);",
    "  margin-bottom: 14px;",
    "  padding: 10px 14px;",
    "}",
    "#atv-lg-popover .lg-switch-row {",
    "  display: flex;",
    "  align-items: center;",
    "  justify-content: space-between;",
    "  gap: 12px;",
    "  padding: 4px 0;",
    "  cursor: pointer;",
    "  user-select: none;",
    "}",
    "#atv-lg-popover .lg-switch-info {",
    "  display: flex;",
    "  flex-direction: column;",
    "  gap: 2px;",
    "}",
    "#atv-lg-popover .lg-switch-title {",
    "  font-size: 13px;",
    "  font-weight: 600;",
    "  color: #ffffff;",
    "  text-shadow: none !important;",
    "}",
    "#atv-lg-popover .lg-switch-desc {",
    "  font-size: 11px;",
    "  color: rgba(255, 255, 255, 0.65);",
    "  text-shadow: none !important;",
    "}",
    "#atv-lg-popover .lg-switch-divider {",
    "  height: 1px;",
    "  background: rgba(255, 255, 255, 0.12);",
    "  margin: 8px 0;",
    "}",
    "#atv-lg-popover .lg-macos-switch {",
    "  position: relative;",
    "  width: 52px;",
    "  height: 28px;",
    "  flex: 0 0 52px;",
    "  border-radius: 999px;",
    "  background: rgba(255, 255, 255, 0.18);",
    "  border: 1px solid rgba(255, 255, 255, 0.22);",
    "  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.45);",
    "  cursor: pointer;",
    "  padding: 0;",
    "  outline: none;",
    "  transition: background 0.22s ease, border-color 0.22s ease, box-shadow 0.22s ease;",
    "}",
    "#atv-lg-popover .lg-macos-switch.active {",
    "  background: #0a84ff;",
    "  border-color: rgba(255, 255, 255, 0.35);",
    "  box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.35);",
    "}",
    "#atv-lg-popover .lg-macos-switch .lg-switch-thumb {",
    "  position: absolute;",
    "  top: 2px;",
    "  left: 2px;",
    "  width: 26px;",
    "  height: 22px;",
    "  border-radius: 999px;",
    "  background: #ffffff;",
    "  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35), inset 0 1px 1px #ffffff;",
    "  transition: transform 0.22s cubic-bezier(0.22, 1, 0.36, 1);",
    "}",
    "#atv-lg-popover .lg-macos-switch.active .lg-switch-thumb {",
    "  transform: translateX(20px);",
    "}",
    "#atv-lg-popover .lg-row { margin-bottom: 10px; }",
    "#atv-lg-popover .lg-row label {",
    "  display: flex;",
    "  justify-content: space-between;",
    "  font-size: 12px;",
    "  font-weight: 600;",
    "  color: rgba(255, 255, 255, 0.88);",
    "  margin-bottom: 5px;",
    "  text-shadow: none !important;",
    "}",
    /* Liquid Glass Slider Controls (winaviation liquid glass capsule slider) */
    "#atv-lg-popover input[type='range'] {",
    "  -webkit-appearance: none;",
    "  appearance: none;",
    "  width: 100%;",
    "  height: 12px;",
    "  border-radius: 999px;",
    "  background: linear-gradient(to right, #0071e3 0%, #0071e3 var(--slider-pct, 0%), rgba(255, 255, 255, 0.15) var(--slider-pct, 0%), rgba(255, 255, 255, 0.15) 100%);",
    "  outline: none;",
    "  cursor: pointer;",
    "  box-shadow: inset 0 1.5px 3.5px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.12);",
    "  transition: background 0.08s ease;",
    "  margin: 6px 0 10px;",
    "}",
    "#atv-lg-popover input[type='range']:hover {",
    "  box-shadow: inset 0 1.5px 3.5px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.25);",
    "}",
    "#atv-lg-popover input[type='range']::-webkit-slider-thumb {",
    "  -webkit-appearance: none;",
    "  appearance: none;",
    "  width: 38px;",
    "  height: 22px;",
    "  margin-top: -5px;",
    "  border-radius: 999px;",
    "  background: linear-gradient(180deg, rgba(255, 255, 255, 0.98) 0%, rgba(235, 244, 255, 0.88) 100%);",
    "  border: 1px solid rgba(255, 255, 255, 0.95);",
    "  box-shadow: 0 3px 8px rgba(0, 0, 0, 0.30), inset 0 1.5px 2px #ffffff;",
    "  cursor: pointer;",
    "  transition: transform 0.12s ease;",
    "}",
    "#atv-lg-popover input[type='range']::-webkit-slider-thumb:hover {",
    "  transform: scale(1.04);",
    "  box-shadow: 0 3px 8px rgba(0, 0, 0, 0.35), inset 0 1.5px 2px #ffffff;",
    "}",
    "#atv-lg-popover input[type='range']:active::-webkit-slider-thumb {",
    "  transform: scale(1.06);",
    "  box-shadow: 0 3px 8px rgba(0, 0, 0, 0.40), inset 0 1.5px 2px #ffffff;",
    "}",
    "#atv-lg-popover input[type='range']::-moz-range-thumb {",
    "  width: 38px;",
    "  height: 22px;",
    "  border-radius: 999px;",
    "  border: 1px solid rgba(255, 255, 255, 0.95);",
    "  background: linear-gradient(180deg, rgba(255, 255, 255, 0.98) 0%, rgba(235, 244, 255, 0.88) 100%);",
    "  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.35), inset 0 1.5px 2px #ffffff;",
    "  cursor: pointer;",
    "}",
    "#atv-lg-popover .lg-presets-row {",
    "  display: flex;",
    "  justify-content: space-between;",
    "  gap: 6px;",
    "  padding-top: 10px;",
    "  margin-top: 6px;",
    "  border-top: 1px solid rgba(255, 255, 255, 0.14);",
    "}",
    "#atv-lg-popover .lg-preset-btn {",
    "  flex: 1;",
    "  height: 28px;",
    "  border-radius: 8px;",
    "  border: 1px solid rgba(255, 255, 255, 0.18);",
    "  background: rgba(255, 255, 255, 0.08);",
    "  color: rgba(255, 255, 255, 0.88);",
    "  font-family: inherit;",
    "  font-size: 11px;",
    "  font-weight: 600;",
    "  cursor: pointer;",
    "  text-shadow: none !important;",
    "  transition: background 0.15s ease;",
    "}",
    "#atv-lg-popover .lg-preset-btn:hover { background: rgba(255, 255, 255, 0.20); }"
  ].join("\n");

  function ensureStyle() {
    var existing = document.getElementById(STYLE_ID);
    if (existing) {
      if (existing.textContent !== CSS) existing.textContent = CSS;
      return;
    }
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  /* ------------------------------------------------------------------------
   * Pure Vector SVG Icons (Zero Emojis)
   * ---------------------------------------------------------------------- */
  var ICONS = {
    sidebar: "<svg viewBox='0 0 24 24'><rect x='3' y='4' width='18' height='16' rx='3'/><line x1='9' y1='4' x2='9' y2='20'/></svg>",
    back: "<svg viewBox='0 0 24 24'><path d='M15 18l-6-6 6-6'/></svg>",
    forward: "<svg viewBox='0 0 24 24'><path d='M9 18l6-6-6-6'/></svg>",
    reload: "<svg viewBox='0 0 24 24'><path d='M20 11a8 8 0 1 0-2.3 5.7'/><path d='M20 4v7h-7'/></svg>",
    search: "<svg viewBox='0 0 24 24'><circle cx='11' cy='11' r='7'/><line x1='20' y1='20' x2='16.2' y2='16.2'/></svg>",
    home: "<svg viewBox='0 0 24 24'><path d='M3 10.5L12 3l9 7.5'/><path d='M5 9.5V20h14V9.5'/></svg>",
    tv: "<svg viewBox='0 0 24 24'><rect x='2.5' y='5' width='19' height='13' rx='2.5'/><line x1='8' y1='21' x2='16' y2='21'/></svg>",
    mls: "<svg viewBox='0 0 24 24'><path d='M12 3l8 3.5v6c0 5-3.4 7.9-8 9.5-4.6-1.6-8-4.5-8-9.5v-6L12 3z'/></svg>",
    store: "<svg viewBox='0 0 24 24'><path d='M6 7h12l1 13H5L6 7z'/><path d='M9 7V5a3 3 0 0 1 6 0v2'/></svg>",
    clock: "<svg viewBox='0 0 24 24'><circle cx='12' cy='12' r='9'/><polyline points='12 7 12 12 15.5 14'/></svg>",
    film: "<svg viewBox='0 0 24 24'><rect x='3' y='4' width='18' height='16' rx='2'/><line x1='7' y1='4' x2='7' y2='20'/><line x1='17' y1='4' x2='17' y2='20'/><line x1='3' y1='12' x2='21' y2='12'/></svg>",
    users: "<svg viewBox='0 0 24 24'><circle cx='9' cy='8' r='3.5'/><path d='M3 19c0-3.2 2.7-5.5 6-5.5s6 2.3 6 5.5'/><circle cx='17' cy='9' r='2.5'/><path d='M15.5 19c.4-2.1 2-3.7 4.5-3.7'/></svg>",
    user: "<svg viewBox='0 0 24 24'><circle cx='12' cy='8.5' r='3.8'/><path d='M5 19.5c1.4-3.4 4.1-5.2 7-5.2s5.6 1.8 7 5.2'/></svg>",
    settings: "<svg viewBox='0 0 16 16' width='16' height='16'><path fill='currentColor' fill-rule='nonzero' d='M31.475,57.622C32.114,57.622 32.702,57.571 33.34,57.52L34.77,60.228C35.077,60.891 35.766,61.249 36.558,61.12C37.298,60.994 37.809,60.43 37.912,59.665L38.346,56.651C39.546,56.32 40.696,55.885 41.845,55.4L44.066,57.392C44.629,57.928 45.369,58.031 46.085,57.648C46.749,57.263 47.005,56.575 46.877,55.809L46.238,52.82C47.26,52.115 48.218,51.321 49.098,50.445L51.883,51.62C52.597,51.928 53.313,51.748 53.849,51.11C54.334,50.548 54.411,49.806 53.977,49.143L52.367,46.537C53.079,45.524 53.695,44.446 54.207,43.318L57.247,43.472C58.012,43.498 58.677,43.089 58.907,42.349C59.163,41.658 58.933,40.876 58.345,40.432L55.945,38.543C56.249,37.393 56.505,36.143 56.606,34.866L59.468,33.946C60.234,33.716 60.694,33.128 60.694,32.362C60.694,31.571 60.234,31.008 59.468,30.752L56.606,29.834C56.505,28.557 56.249,27.357 55.945,26.157L58.318,24.265C58.932,23.806 59.162,23.091 58.906,22.375C58.676,21.66 58.012,21.226 57.245,21.252L54.206,21.38C53.645,20.23 53.083,19.183 52.368,18.135L53.977,15.555C54.387,14.965 54.334,14.17 53.849,13.64C53.312,12.977 52.597,12.825 51.883,13.105L49.098,14.254C48.198,13.4 47.242,12.606 46.237,11.878L46.877,8.915C47.005,8.149 46.723,7.434 46.085,7.077C45.369,6.692 44.629,6.769 44.066,7.332L41.846,9.298C40.702,8.821 39.535,8.404 38.348,8.048L37.914,5.058C37.834,4.32 37.267,3.722 36.534,3.603C35.768,3.5 35.078,3.833 34.772,4.471L33.342,7.178C32.703,7.154 32.115,7.102 31.477,7.102C30.838,7.102 30.251,7.154 29.612,7.178L28.182,4.471C27.849,3.832 27.186,3.501 26.394,3.603C25.654,3.731 25.144,4.293 25.04,5.058L24.606,8.048C23.406,8.405 22.231,8.814 21.108,9.298L18.885,7.332C18.298,6.769 17.583,6.694 16.842,7.077C16.203,7.434 15.949,8.149 16.075,8.942L16.714,11.878C15.709,12.606 14.753,13.4 13.852,14.254L11.069,13.104C10.329,12.824 9.639,12.977 9.077,13.64C8.618,14.179 8.566,14.96 8.949,15.555L10.559,18.135C9.875,19.17 9.269,20.255 8.746,21.38L5.68,21.252C4.941,21.219 4.264,21.677 4.02,22.375C3.79,23.091 3.995,23.806 4.608,24.266L6.982,26.154C6.7,27.354 6.445,28.554 6.343,29.831L3.457,30.751C2.717,30.981 2.282,31.569 2.282,32.36C2.282,33.126 2.717,33.714 3.457,33.945L6.343,34.889C6.445,36.14 6.675,37.392 6.982,38.542L4.606,40.43C4.022,40.877 3.785,41.65 4.018,42.347C4.253,43.052 4.938,43.515 5.68,43.47L8.745,43.316C9.28,44.466 9.868,45.539 10.557,46.534L8.947,49.141C8.551,49.751 8.604,50.554 9.077,51.107C9.64,51.745 10.329,51.924 11.069,51.617L13.828,50.442C14.722,51.312 15.688,52.107 16.714,52.817L16.075,55.807C15.948,56.573 16.203,57.262 16.868,57.645C17.583,58.028 18.298,57.925 18.86,57.415L21.106,55.397C22.231,55.882 23.406,56.317 24.606,56.648L25.04,59.664C25.143,60.428 25.654,60.991 26.394,61.144C27.186,61.247 27.849,60.888 28.182,60.225L29.612,57.517C30.251,57.568 30.838,57.619 31.477,57.619L31.475,57.621L31.475,57.622ZM38.168,30.345C36.891,27.049 34.337,25.262 31.322,25.262C30.762,25.261 30.205,25.33 29.662,25.466L22.766,13.64C25.492,12.368 28.466,11.714 31.474,11.724C42.254,11.724 50.732,19.822 51.729,30.344L38.168,30.344L38.168,30.345ZM11.145,32.362C11.145,25.543 14.286,19.515 19.242,15.762L26.188,27.637C24.834,29.145 24.222,30.752 24.222,32.438C24.222,34.074 24.809,35.58 26.188,37.138L19.063,48.835C14.209,45.055 11.145,39.105 11.145,32.362ZM28.283,32.412C28.283,30.702 29.738,29.374 31.373,29.374C33.085,29.374 34.489,30.702 34.489,32.412C34.481,34.114 33.076,35.509 31.374,35.505C29.738,35.505 28.282,34.125 28.282,32.412L28.283,32.412ZM31.475,53.025C28.257,53.025 25.218,52.285 22.562,50.982L29.637,39.386C30.377,39.565 30.887,39.616 31.322,39.616C34.362,39.616 36.915,37.776 38.168,34.405L51.729,34.405C50.732,44.903 42.252,53.025 31.475,53.025Z' transform='matrix(.27119 0 0 .27119 -.54 -.78)'></path></svg>"
  };

  /* ------------------------------------------------------------------------
   * macOS Top Bar, Sidebar, User Profile Menu & Settings Pop-up Modal
   * ---------------------------------------------------------------------- */
  var sidebar = null;
  var userMenu = null;
  var modalBackdrop = null;
  var popover = null;
  var sidebarToggleBtn = null;

  function getStorefrontRoot() {
    var m = location.pathname.match(/^\/([a-z]{2})(\/|$)/i);
    if (m) {
      try { localStorage.setItem("atv-lg-country", m[1].toLowerCase()); } catch (e) {}
      return "/" + m[1].toLowerCase();
    }
    try {
      var saved = localStorage.getItem("atv-lg-country");
      if (saved) return "/" + saved;
    } catch (e) {}
    return "/";
  }

  /* Auto-confirm regional country/storefront banner so the user is never prompted */
  function handleCountryBanner() {
    var banner = document.querySelector("[data-testid='banner-container'], .banner-container");
    if (!banner) return;
    var continueBtn = banner.querySelector("button[data-testid='select-button'], button.select-button");
    if (continueBtn && !continueBtn.__atvLgHandled) {
      continueBtn.__atvLgHandled = true;
      try {
        continueBtn.click();
      } catch (e) {}
    }
  }

  function getAvatarSrc() {
    var img = document.querySelector("img[data-testid='account-menu-avatar']");
    return img && img.src ? img.src : null;
  }

  function isUserSignedIn() {
    return !!document.querySelector(".auth-content__is-signed-in, .account-menu, [data-testid='account-menu']");
  }

  function getAccountName() {
    if (settings.accountName && settings.accountName.trim()) {
      return settings.accountName.trim();
    }
    var trigger = document.querySelector(".account-menu .contextual-menu__trigger");
    if (trigger) {
      var t = trigger.getAttribute("title") || trigger.getAttribute("aria-label") || "";
      if (t && t !== "My Account" && t !== "Account") return t.trim();
    }
    var img = document.querySelector("img[data-testid='account-menu-avatar']");
    if (img && img.alt && img.alt !== "User Profile" && img.alt !== "Account") {
      return img.alt.trim();
    }
    return isUserSignedIn() ? "Apple Account" : "Sign In";
  }

  function syncAvatarDisplays() {
    var src = getAvatarSrc();
    var signedIn = isUserSignedIn();
    var acctName = getAccountName();
    var avatarContainers = document.querySelectorAll(".lg-sync-avatar");
    for (var i = 0; i < avatarContainers.length; i++) {
      var box = avatarContainers[i];
      if (src) {
        if (!box.querySelector("img") || box.querySelector("img").src !== src) {
          box.innerHTML = "<img src='" + src + "' alt='User Profile' />";
        }
      } else if (!box.querySelector("svg")) {
        box.innerHTML = ICONS.user;
      }
    }

    var sbNameEl = document.querySelector("#atv-lg-mac-sidebar .lg-sb-name, #lg-sb-name-label");
    if (sbNameEl) {
      sbNameEl.textContent = acctName;
      sbNameEl.title = acctName;
    }

    var statusEl = document.getElementById("lg-account-status-title");
    var subEl = document.getElementById("lg-account-status-sub");
    if (statusEl) {
      statusEl.textContent = acctName;
    }
    if (subEl) {
      subEl.textContent = signedIn
        ? "Connected to Apple TV (" + location.pathname.split("/")[1].toUpperCase() + " Storefront)"
        : "Sign in on Apple TV to sync Up Next & Library";
    }

    /* Hide fallback profile button if Apple's native account-menu is visible */
    var fallbackBtn = document.getElementById("atv-lg-profile-btn");
    if (fallbackBtn) {
      fallbackBtn.style.setProperty("display", signedIn ? "none" : "inline-flex", "important");
    }
  }

  function applySidebarState() {
    document.documentElement.classList.toggle("atv-lg-sidebar-open", settings.sidebarOpen);
    if (sidebar) {
      sidebar.classList.toggle("atv-lg-closed", !settings.sidebarOpen);
    }
    if (sidebarToggleBtn) {
      sidebarToggleBtn.setAttribute("aria-pressed", String(settings.sidebarOpen));
    }
    var sbSwitch = document.getElementById("lg-toggle-sidebar");
    if (sbSwitch) {
      sbSwitch.setAttribute("aria-checked", String(settings.sidebarOpen));
      sbSwitch.classList.toggle("active", !!settings.sidebarOpen);
    }
  }

  function toggleSidebar() {
    settings.sidebarOpen = !settings.sidebarOpen;
    saveSettings();
    applySidebarState();
  }

  function getActiveTopHost() {
    if (document.fullscreenElement && document.fullscreenElement.tagName !== "VIDEO") {
      return document.fullscreenElement;
    }
    if (document.webkitFullscreenElement && document.webkitFullscreenElement.tagName !== "VIDEO") {
      return document.webkitFullscreenElement;
    }
    return document.body || document.documentElement;
  }

  function syncModalHost() {
    if (!modalBackdrop) return;
    var host = getActiveTopHost();
    if (modalBackdrop.parentElement !== host) {
      try { host.appendChild(modalBackdrop); } catch (e) { document.body.appendChild(modalBackdrop); }
    }
  }

  document.addEventListener("fullscreenchange", syncModalHost);
  document.addEventListener("webkitfullscreenchange", syncModalHost);

  function openSettingsModal() {
    if (!modalBackdrop || !popover) buildSettingsUI();
    closeUserMenu();
    syncAvatarDisplays();
    syncAllSliderProgress();
    applySidebarState();
    applyEnabledState();
    syncModalHost();
    if (modalBackdrop) {
      modalBackdrop.classList.remove("atv-lg-closed");
      modalBackdrop.style.setProperty("display", "flex", "important");
      modalBackdrop.style.setProperty("visibility", "visible", "important");
      modalBackdrop.style.setProperty("opacity", "1", "important");
      modalBackdrop.style.setProperty("pointer-events", "auto", "important");
      modalBackdrop.style.setProperty("z-index", "2147483647", "important");
    }
    if (popover) {
      popover.style.setProperty("display", "block", "important");
      popover.style.setProperty("visibility", "visible", "important");
      popover.style.setProperty("opacity", "1", "important");
      popover.style.setProperty("z-index", "2147483647", "important");
      popover.style.setProperty("pointer-events", "auto", "important");
    }
  }

  function closeSettingsModal() {
    if (modalBackdrop) {
      modalBackdrop.classList.add("atv-lg-closed");
      modalBackdrop.style.setProperty("display", "none", "important");
      modalBackdrop.style.setProperty("visibility", "hidden", "important");
      modalBackdrop.style.setProperty("opacity", "0", "important");
      modalBackdrop.style.setProperty("pointer-events", "none", "important");
    }
  }

  function toggleUserMenu(anchorEl) {
    if (!userMenu) buildSettingsUI();
    var isClosed = userMenu.classList.contains("atv-lg-closed");
    if (!isClosed) {
      closeUserMenu();
      return;
    }
    if (anchorEl && anchorEl.getBoundingClientRect) {
      var r = anchorEl.getBoundingClientRect();
      if (r.top > window.innerHeight / 2) {
        userMenu.style.top = "auto";
        userMenu.style.bottom = (window.innerHeight - r.top + 8) + "px";
        userMenu.style.left = Math.max(16, r.left) + "px";
        userMenu.style.right = "auto";
      } else {
        userMenu.style.bottom = "auto";
        userMenu.style.top = Math.round(r.bottom + 8) + "px";
        userMenu.style.right = Math.max(16, Math.round(window.innerWidth - r.right)) + "px";
        userMenu.style.left = "auto";
      }
    }
    userMenu.classList.remove("atv-lg-closed");
  }

  function closeUserMenu() {
    if (userMenu) userMenu.classList.add("atv-lg-closed");
  }

  function dismissAppleContextualMenu() {
    var scrim = document.querySelector("amp-contextual-menu-scrim, .contextual-menu__overlay");
    if (scrim) {
      try { scrim.click(); } catch (e) {}
    }
    var menu = document.querySelector("amp-contextual-menu");
    if (menu) {
      menu.style.visibility = "hidden";
    }
  }

  function enhanceMacHeader() {
    var header = document.querySelector("[data-testid='header'], .header.header--color, header.landing-page-header, header.header");
    if (!header || !isTopNavBar(header)) return;

    var openContainer = header.querySelector(".header__open") || header.querySelector(".header__contents") || header;
    if (openContainer && !document.getElementById("atv-lg-mac-left")) {
      var macLeft = document.createElement("div");
      macLeft.id = "atv-lg-mac-left";

      /* macOS Traffic Lights */
      var traffic = document.createElement("div");
      traffic.className = "atv-lg-traffic";

      var btnClose = document.createElement("button");
      btnClose.type = "button";
      btnClose.className = "atv-lg-dot atv-lg-dot-close";
      btnClose.title = "Close Pop-ups";
      btnClose.setAttribute("aria-label", "Close Pop-ups");
      btnClose.addEventListener("click", function () {
        closeSettingsModal();
        closeUserMenu();
      });

      var btnMin = document.createElement("button");
      btnMin.type = "button";
      btnMin.className = "atv-lg-dot atv-lg-dot-min";
      btnMin.title = "Toggle macOS Sidebar";
      btnMin.setAttribute("aria-label", "Toggle macOS Sidebar");
      btnMin.addEventListener("click", toggleSidebar);

      var btnMax = document.createElement("button");
      btnMax.type = "button";
      btnMax.className = "atv-lg-dot atv-lg-dot-max";
      btnMax.title = "Toggle Fullscreen";
      btnMax.setAttribute("aria-label", "Toggle Fullscreen");
      btnMax.addEventListener("click", function () {
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen().catch(function () {});
        } else {
          document.exitFullscreen().catch(function () {});
        }
      });

      traffic.appendChild(btnClose);
      traffic.appendChild(btnMin);
      traffic.appendChild(btnMax);
      macLeft.appendChild(traffic);

      /* macOS Sidebar + Back / Forward / Reload Cluster */
      var cluster = document.createElement("div");
      cluster.className = "atv-lg-mac-cluster";

      function makeNavBtn(icon, title, onClick) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "atv-lg-mac-btn";
        b.title = title;
        b.setAttribute("aria-label", title);
        b.innerHTML = ICONS[icon];
        b.addEventListener("click", onClick);
        cluster.appendChild(b);
        return b;
      }

      sidebarToggleBtn = makeNavBtn("sidebar", "Toggle macOS Sidebar", toggleSidebar);
      sidebarToggleBtn.setAttribute("aria-pressed", String(settings.sidebarOpen));
      makeNavBtn("back", "Back", function () { history.back(); });
      makeNavBtn("forward", "Forward", function () { history.forward(); });
      makeNavBtn("reload", "Reload", function () { location.reload(); });

      macLeft.appendChild(cluster);
      openContainer.insertBefore(macLeft, openContainer.firstChild);
    }

    /* Make Apple TV logo navigate to Home instead of launching Microsoft Store */
    var storeLink = header.querySelector("a.open-in-tv");
    if (storeLink && !storeLink.__atvLgPatched) {
      storeLink.__atvLgPatched = true;
      storeLink.href = getStorefrontRoot();
      storeLink.title = "Apple TV Home";
      storeLink.addEventListener("click", function (e) {
        e.preventDefault();
        location.href = getStorefrontRoot();
      });
    }

    /* Ensure User Profile button is always available in .header__controls */
    var controls = header.querySelector(".header__controls");
    if (controls && !document.getElementById("atv-lg-profile-btn")) {
      var profBtn = document.createElement("button");
      profBtn.id = "atv-lg-profile-btn";
      profBtn.type = "button";
      profBtn.title = "User Profile & Liquid Glass Settings";
      profBtn.setAttribute("aria-label", "User Profile & Liquid Glass Settings");
      profBtn.innerHTML = "<span class='lg-sync-avatar' style='display:flex;width:18px;height:18px;'>" + ICONS.user + "</span>";
      profBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        toggleUserMenu(profBtn);
      });
      controls.appendChild(profBtn);
    }

    syncAvatarDisplays();
  }

  function setActiveSidebarItem(actionName) {
    if (!sidebar) return;
    var items = sidebar.querySelectorAll(".lg-sb-item");
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var act = item.getAttribute("data-action");
      if (act === actionName) {
        item.classList.add("lg-sb-active");
      } else {
        item.classList.remove("lg-sb-active");
      }
    }
  }

  function scrollToShelfHeading(keywords) {
    var scroller = document.querySelector(".scrollable-page") || window;
    var headers = document.querySelectorAll("h2, .title, .title__button, .rich-lockup-shelf-header, [class*='shelf-header']");
    for (var i = 0; i < headers.length; i++) {
      var el = headers[i];
      var txt = (el.textContent || "").replace(/\s+/g, " ").toLowerCase();
      for (var k = 0; k < keywords.length; k++) {
        if (txt.indexOf(keywords[k].toLowerCase()) !== -1) {
          try {
            el.scrollIntoView({ behavior: "smooth", block: "start" });
          } catch (e) {}
          if (scroller && scroller !== window) {
            var elRect = el.getBoundingClientRect();
            var scRect = scroller.getBoundingClientRect ? scroller.getBoundingClientRect() : { top: 0 };
            var targetY = (scroller.scrollTop || 0) + (elRect.top - scRect.top) - 80;
            if (targetY > 0) {
              try { scroller.scrollTo({ top: targetY, behavior: "smooth" }); } catch (e) {}
              scroller.scrollTop = targetY;
            }
          }
          return true;
        }
      }
    }
    return false;
  }

  var lastSidebarPath = "";
  function syncSidebarActiveState(force) {
    if (!sidebar) return;
    var p = location.pathname.toLowerCase();
    if (!force && p === lastSidebarPath) return;
    lastSidebarPath = p;

    if (p.indexOf("/search") !== -1) {
      setActiveSidebarItem("search");
    } else if (p.indexOf("7000") !== -1) {
      setActiveSidebarItem("mls");
    } else if (p.indexOf("4000") !== -1) {
      setActiveSidebarItem("atv");
    } else {
      setActiveSidebarItem("home");
    }
  }

  function buildSettingsUI() {
    if (!document.body) return;

    /* 1. Floating macOS Liquid Glass Sidebar (matches Reference Image 1) */
    if (!sidebar || !sidebar.isConnected) {
      var oldSidebar = document.getElementById("atv-lg-mac-sidebar");
      if (oldSidebar && oldSidebar.parentNode) oldSidebar.parentNode.removeChild(oldSidebar);
      sidebar = document.createElement("aside");
      sidebar.id = "atv-lg-mac-sidebar";
      sidebar.className = settings.sidebarOpen ? "" : "atv-lg-closed";
      sidebar.setAttribute("aria-label", "macOS Apple TV Sidebar");

      sidebar.innerHTML = [
        "<div class='lg-sb-nav'>",
        "  <button type='button' class='lg-sb-item lg-sb-search' data-action='search'>" + ICONS.search + "<span>Search</span></button>",
        "  <button type='button' class='lg-sb-item' data-action='home'>" + ICONS.home + "<span>Home</span></button>",
        "  <button type='button' class='lg-sb-item' data-action='atv'>" + ICONS.tv + "<span>Apple TV</span></button>",
        "  <button type='button' class='lg-sb-item' data-action='mls'>" + ICONS.mls + "<span>MLS</span></button>",
        "  <button type='button' class='lg-sb-item' data-action='store'>" + ICONS.store + "<span>Store</span></button>",
        "  <div class='lg-sb-section'>Library</div>",
        "  <button type='button' class='lg-sb-item' data-action='upnext'>" + ICONS.clock + "<span>Recently Added</span></button>",
        "  <button type='button' class='lg-sb-item' data-action='movies'>" + ICONS.film + "<span>Movies</span></button>",
        "  <button type='button' class='lg-sb-item' data-action='shows'>" + ICONS.tv + "<span>TV Shows</span></button>",
        "  <button type='button' class='lg-sb-item' data-action='family'>" + ICONS.users + "<span>Family Sharing</span></button>",
        "</div>",
        "<div class='lg-sb-footer'>",
        "  <button type='button' class='lg-sb-profile' id='atv-lg-sb-profile-btn' title='User Profile & Settings'>",
        "    <span class='lg-sb-profile-info'>",
        "      <span class='lg-sb-avatar lg-sync-avatar'>" + ICONS.user + "</span>",
        "      <span class='lg-sb-name' id='lg-sb-name-label'>" + getAccountName() + "</span>",
        "    </span>",
        "    <span class='lg-sb-gear'>" + ICONS.settings + "</span>",
        "  </button>",
        "</div>"
      ].join("");

      document.body.appendChild(sidebar);
      syncSidebarActiveState(true);

      var pendingShelf = null;
      try { pendingShelf = sessionStorage.getItem("atv-lg-target-shelf"); } catch (e) {}
      if (pendingShelf) {
        try { sessionStorage.removeItem("atv-lg-target-shelf"); } catch (e) {}
        setTimeout(function () {
          setActiveSidebarItem(pendingShelf);
          if (pendingShelf === "movies") {
            if (!scrollToShelfHeading(["Top 10 Movies", "All Movies", "Action Blockbusters"])) {
              var sc = document.querySelector(".scrollable-page") || window;
              if (sc !== window) sc.scrollTop = 1100; else window.scrollTo(0, 1100);
            }
          } else if (pendingShelf === "shows") {
            if (!scrollToShelfHeading(["Top 10 TV Shows", "All Drama Series", "All Sci-Fi Series", "All Comedy Series"])) {
              var sc = document.querySelector(".scrollable-page") || window;
              if (sc !== window) sc.scrollTop = 600; else window.scrollTo(0, 600);
            }
          } else if (pendingShelf === "upnext") {
            if (!scrollToShelfHeading(["Continue Watching", "Recently Added", "Up Next"])) {
              var sc = document.querySelector(".scrollable-page") || window;
              if (sc !== window) sc.scrollTop = 380; else window.scrollTo(0, 380);
            }
          } else if (pendingShelf === "store") {
            if (!scrollToShelfHeading(["Browse All", "New Releases", "All Movies", "For You"])) {
              var sc = document.querySelector(".scrollable-page") || window;
              if (sc !== window) sc.scrollTop = 800; else window.scrollTo(0, 800);
            }
          }
        }, 400);
      }

      sidebar.addEventListener("click", function (e) {
        var btn = e.target.closest("button[data-action]");
        if (btn) {
          var act = btn.getAttribute("data-action");
          var root = getStorefrontRoot();
          setActiveSidebarItem(act);

          if (act === "search") {
            var sContainer = document.querySelector(".search-input");
            var sInput = document.querySelector("#search-input__text-field, .search-input input");
            if (sContainer) sContainer.click();
            if (sInput) {
              sInput.focus();
              sInput.click();
            } else {
              location.href = root + "/search";
            }
          } else if (act === "home") {
            var isHome = location.pathname === root || location.pathname === root + "/" || location.pathname === "/";
            if (isHome) {
              var scr = document.querySelector(".scrollable-page") || window;
              try { scr.scrollTo({ top: 0, behavior: "smooth" }); } catch (err) {}
              if (scr !== window) scr.scrollTop = 0;
              var cancelBtn = document.querySelector(".search-input__cancel-button-container button, button[data-testid='search-input__cancel-button']");
              if (cancelBtn) try { cancelBtn.click(); } catch (err) {}
            } else {
              var atvLogo = document.querySelector("a.brand-lockup, a[data-testid='brand-lockup'], a[href='" + root + "'], a[href='" + root + "/']");
              if (atvLogo) {
                try { atvLogo.click(); } catch (err) { location.href = root; }
              } else {
                location.href = root;
              }
            }
          } else if (act === "atv") {
            var atvTab = document.querySelector(".navigation-tabs a[href*='4000'], a[href*='4000']");
            if (atvTab) {
              try { atvTab.click(); } catch (err) { location.href = atvTab.href; }
            } else {
              location.href = root + "/channel/apple-tv/tvs.sbd.4000";
            }
          } else if (act === "mls") {
            var mlsTab = document.querySelector(".navigation-tabs a[href*='7000'], a[href*='7000']");
            if (mlsTab) {
              try { mlsTab.click(); } catch (err) { location.href = mlsTab.href; }
            } else {
              location.href = root + "/channel/mls/tvs.sbd.7000";
            }
          } else if (act === "store" || act === "upnext" || act === "movies" || act === "shows") {
            var isHomeRoute = location.pathname === root || location.pathname === root + "/" || location.pathname === "/";
            if (!isHomeRoute) {
              try { sessionStorage.setItem("atv-lg-target-shelf", act); } catch (e) {}
              location.href = root;
              return;
            }

            var scr = document.querySelector(".scrollable-page") || window;
            if (act === "store") {
              if (!scrollToShelfHeading(["Browse All", "New Releases", "All Movies", "Must-See", "For You"])) {
                if (scr !== window) scr.scrollTop = 800; else window.scrollTo(0, 800);
              }
            } else if (act === "upnext") {
              if (!scrollToShelfHeading(["Continue Watching", "Recently Added", "Up Next"])) {
                if (scr !== window) scr.scrollTop = 380; else window.scrollTo(0, 380);
              }
            } else if (act === "movies") {
              if (!scrollToShelfHeading(["Top 10 Movies", "All Movies", "Action Blockbusters"])) {
                if (scr !== window) scr.scrollTop = 1100; else window.scrollTo(0, 1100);
              }
            } else if (act === "shows") {
              if (!scrollToShelfHeading(["Top 10 TV Shows", "All Drama Series", "All Sci-Fi Series", "All Comedy Series"])) {
                if (scr !== window) scr.scrollTop = 600; else window.scrollTo(0, 600);
              }
            }
          } else if (act === "family") {
            openSettingsModal();
          }
          return;
        }

        var prof = e.target.closest("#atv-lg-sb-profile-btn");
        if (prof) {
          e.stopPropagation();
          var gear = e.target.closest(".lg-sb-gear");
          if (gear) {
            openSettingsModal();
          } else {
            toggleUserMenu(prof);
          }
        }
      });
    }

    /* 2. Fallback User Profile Contextual Menu (#atv-lg-user-menu) */
    if (!userMenu || !userMenu.isConnected) {
      var oldUserMenu = document.getElementById("atv-lg-user-menu");
      if (oldUserMenu && oldUserMenu.parentNode) oldUserMenu.parentNode.removeChild(oldUserMenu);
      userMenu = document.createElement("div");
      userMenu.id = "atv-lg-user-menu";
      userMenu.className = "atv-lg-closed";
      userMenu.setAttribute("role", "menu");
      userMenu.innerHTML = [
        "<button type='button' class='lg-um-item' data-um='settings'>",
        "  <span>Settings</span>",
        "  " + ICONS.settings,
        "</button>",
        "<div class='lg-um-sep'></div>",
        "<button type='button' class='lg-um-item' data-um='account'>",
        "  <span>Apple Account</span>",
        "  " + ICONS.user,
        "</button>"
      ].join("");

      document.body.appendChild(userMenu);
      // User menu uses crisp GPU CSS Liquid Glass

      userMenu.addEventListener("click", function (e) {
        var item = e.target.closest("button[data-um]");
        if (!item) return;
        var kind = item.getAttribute("data-um");
        closeUserMenu();
        if (kind === "settings") {
          openSettingsModal();
        } else if (kind === "account") {
          var signInBtn = document.querySelector("button.commerce-button.signin");
          if (signInBtn) signInBtn.click();
          else openSettingsModal();
        }
      });
    }

    /* 3. Account & Liquid Glass Settings Pop-up Modal */
    if (!modalBackdrop || !modalBackdrop.isConnected) {
      var oldBackdrop = document.getElementById("atv-lg-modal-backdrop");
      if (oldBackdrop && oldBackdrop.parentNode) oldBackdrop.parentNode.removeChild(oldBackdrop);
      modalBackdrop = document.createElement("div");
      modalBackdrop.id = "atv-lg-modal-backdrop";
      modalBackdrop.className = "atv-lg-closed";

      popover = document.createElement("div");
      popover.id = "atv-lg-popover";
      popover.setAttribute("role", "dialog");
      popover.setAttribute("aria-modal", "true");
      popover.setAttribute("aria-label", "Account and Liquid Glass Settings");

      popover.innerHTML = [
        "<div class='lg-modal-header'>",
        "  <div style='display:flex;align-items:center;gap:10px;'>",
        "    <button type='button' class='atv-lg-dot atv-lg-dot-close' id='lg-modal-dot-close' title='Close'></button>",
        "    <span class='lg-modal-title'>Account &amp; Liquid Glass Settings</span>",
        "  </div>",
        "  <button type='button' class='lg-close-btn' id='lg-modal-done-btn'>Done</button>",
        "</div>",

        "<div class='lg-section-label'><span>Apple Account</span><span>tv.apple.com</span></div>",
        "<div class='lg-account-card'>",
        "  <div class='lg-account-left'>",
        "    <div class='lg-account-avatar lg-sync-avatar'>" + ICONS.user + "</div>",
        "    <div class='lg-account-meta'>",
        "      <h4 id='lg-account-status-title'>Apple Account</h4>",
        "      <p id='lg-account-status-sub'>Connected to Apple TV</p>",
        "    </div>",
        "  </div>",
        "  <div class='lg-account-actions'>",
        "    <button type='button' class='lg-btn-pill' id='lg-btn-rename' title='Change Account Display Name'>Name</button>",
        "    <button type='button' class='lg-btn-pill' id='lg-btn-region' title='Select Country or Region'>Region</button>",
        "    <button type='button' class='lg-btn-pill lg-btn-primary' id='lg-btn-apple-acct'>Account</button>",
        "  </div>",
        "</div>",

        "<div class='lg-section-label'><span>Liquid Glass Optics</span><span>Snell IOR n = 1.52</span></div>",
        "<div class='lg-switches-card'>",
        "  <div class='lg-switch-row' id='lg-row-enabled'>",
        "    <div class='lg-switch-info'>",
        "      <span class='lg-switch-title'>Liquid Glass Optics</span>",
        "      <span class='lg-switch-desc'>Real-time Snell's Law refraction and dispersion</span>",
        "    </div>",
        "    <button type='button' class='lg-macos-switch" + (settings.enabled ? " active" : "") + "' id='lg-toggle-enabled' role='switch' aria-checked='" + String(settings.enabled) + "' title='Toggle Liquid Glass'>",
        "      <span class='lg-switch-thumb'></span>",
        "    </button>",
        "  </div>",
        "  <div class='lg-switch-divider'></div>",
        "  <div class='lg-switch-row' id='lg-row-sidebar'>",
        "    <div class='lg-switch-info'>",
        "      <span class='lg-switch-title'>macOS Sidebar</span>",
        "      <span class='lg-switch-desc'>Floating macOS Apple TV navigation panel</span>",
        "    </div>",
        "    <button type='button' class='lg-macos-switch" + (settings.sidebarOpen ? " active" : "") + "' id='lg-toggle-sidebar' role='switch' aria-checked='" + String(settings.sidebarOpen) + "' title='Toggle macOS Sidebar'>",
        "      <span class='lg-switch-thumb'></span>",
        "    </button>",
        "  </div>",
        "</div>",

        "<div class='lg-row'>",
        "  <label><span>Performance &amp; FPS Lock</span><span id='lg-val-fps'>" + (FPS_CONFIGS[settings.fpsMode] ? FPS_CONFIGS[settings.fpsMode].label : "60 FPS (Default)") + "</span></label>",
        "  <input type='range' id='lg-in-fps' min='0' max='3' step='1' value='" + settings.fpsMode + "' />",
        "</div>",
        "<div class='lg-row'>",
        "  <label><span>Specular Rim</span><span id='lg-val-spec'>" + Math.round(settings.specularScale * 100) + "%</span></label>",
        "  <input type='range' id='lg-in-spec' min='0.05' max='1.8' step='0.05' value='" + settings.specularScale + "' />",
        "</div>",
        "<div class='lg-row'>",
        "  <label><span>Refraction Depth</span><span id='lg-val-ref'>" + Math.round(settings.refractionScale * 100) + "%</span></label>",
        "  <input type='range' id='lg-in-ref' min='0.2' max='2.4' step='0.05' value='" + settings.refractionScale + "' />",
        "</div>",
        "<div class='lg-row'>",
        "  <label><span>Frost Blur</span><span id='lg-val-frost'>" + Math.round(settings.frostScale * 100) + "%</span></label>",
        "  <input type='range' id='lg-in-frost' min='0.1' max='2.5' step='0.05' value='" + settings.frostScale + "' />",
        "</div>",
        "<div class='lg-row' style='margin-bottom:4px;'>",
        "  <label><span>Chromatic Dispersion</span><span id='lg-val-disp'>" + Math.round(settings.dispersionScale * 100) + "%</span></label>",
        "  <input type='range' id='lg-in-disp' min='0' max='3.0' step='0.1' value='" + settings.dispersionScale + "' />",
        "</div>",

        "<div class='lg-presets-row'>",
        "  <button type='button' class='lg-preset-btn' data-preset='macos'>macOS Default</button>",
        "  <button type='button' class='lg-preset-btn' data-preset='crystal'>Crystal Lens</button>",
        "  <button type='button' class='lg-preset-btn' data-preset='prism'>Deep Prism</button>",
        "</div>"
      ].join("");

      modalBackdrop.appendChild(popover);
      try {
        getActiveTopHost().appendChild(modalBackdrop);
      } catch (e) {
        document.body.appendChild(modalBackdrop);
      }
      // Popover modal uses pristine unclipped symmetrical GPU CSS Liquid Glass

      modalBackdrop.addEventListener("click", function (e) {
        if (e.target === modalBackdrop) closeSettingsModal();
      });
      popover.addEventListener("click", function (e) {
        e.stopPropagation();
      });
      popover.querySelector("#lg-modal-dot-close").addEventListener("click", closeSettingsModal);
      popover.querySelector("#lg-modal-done-btn").addEventListener("click", closeSettingsModal);

      var renameBtn = popover.querySelector("#lg-btn-rename");
      if (renameBtn) {
        renameBtn.addEventListener("click", function () {
          var current = getAccountName();
          var entered = prompt("Enter account name to display:", current);
          if (entered !== null) {
            settings.accountName = entered.trim();
            saveSettings();
            syncAvatarDisplays();
          }
        });
      }

      popover.querySelector("#lg-btn-region").addEventListener("click", function () {
        closeSettingsModal();
        var regionBtn = document.querySelector("[data-testid='locale-switcher-button']");
        if (regionBtn) regionBtn.click();
      });

      popover.querySelector("#lg-btn-apple-acct").addEventListener("click", function () {
        closeSettingsModal();
        var signInBtn = document.querySelector("button.commerce-button.signin");
        if (signInBtn) {
          signInBtn.click();
        } else {
          location.href = getStorefrontRoot().replace(/\/apple-tv$/, "") + "/account/settings";
        }
      });

      var toggleEnabledBtn = popover.querySelector("#lg-toggle-enabled");
      var rowEnabled = popover.querySelector("#lg-row-enabled");
      function onToggleEnabled(e) {
        if (e && e.stopPropagation) e.stopPropagation();
        settings.enabled = !settings.enabled;
        saveSettings();
        if (toggleEnabledBtn) {
          toggleEnabledBtn.setAttribute("aria-checked", String(settings.enabled));
          toggleEnabledBtn.classList.toggle("active", !!settings.enabled);
        }
        applyEnabledState();
      }
      if (toggleEnabledBtn) toggleEnabledBtn.addEventListener("click", onToggleEnabled);
      if (rowEnabled) rowEnabled.addEventListener("click", function (e) {
        if (!e.target.closest("#lg-toggle-enabled")) onToggleEnabled(e);
      });

      var toggleSidebarBtn = popover.querySelector("#lg-toggle-sidebar");
      var rowSidebar = popover.querySelector("#lg-row-sidebar");
      function onToggleSidebar(e) {
        if (e && e.stopPropagation) e.stopPropagation();
        toggleSidebar();
      }
      if (toggleSidebarBtn) toggleSidebarBtn.addEventListener("click", onToggleSidebar);
      if (rowSidebar) rowSidebar.addEventListener("click", function (e) {
        if (!e.target.closest("#lg-toggle-sidebar")) onToggleSidebar(e);
      });

      var fpsInput = popover.querySelector("#lg-in-fps");
      var fpsLabel = popover.querySelector("#lg-val-fps");
      if (fpsInput && fpsLabel) {
        updateSliderProgress(fpsInput);
        fpsInput.addEventListener("input", function () {
          var mode = parseInt(fpsInput.value, 10) || 0;
          settings.fpsMode = mode;
          var cfg = FPS_CONFIGS[mode] || FPS_CONFIGS[2];
          fpsLabel.textContent = cfg.label;
          updateSliderProgress(fpsInput);
          saveSettings();
          applyEnabledState();
        });
      }

      function bindSlider(inputId, valId, key) {
        var input = popover.querySelector("#" + inputId);
        var label = popover.querySelector("#" + valId);
        if (!input || !label) return;
        updateSliderProgress(input);
        input.addEventListener("input", function () {
          settings[key] = parseFloat(input.value);
          label.textContent = Math.round(settings[key] * 100) + "%";
          updateSliderProgress(input);
          saveSettings();
          rebuildAll();
        });
      }

      bindSlider("lg-in-spec", "lg-val-spec", "specularScale");
      bindSlider("lg-in-ref", "lg-val-ref", "refractionScale");
      bindSlider("lg-in-frost", "lg-val-frost", "frostScale");
      bindSlider("lg-in-disp", "lg-val-disp", "dispersionScale");

      function applyPresetValues(ref, frost, disp, spec) {
        settings.refractionScale = ref;
        settings.frostScale = frost;
        settings.dispersionScale = disp;
        settings.specularScale = spec;
        saveSettings();
        var inRef = popover.querySelector("#lg-in-ref");
        var inFrost = popover.querySelector("#lg-in-frost");
        var inDisp = popover.querySelector("#lg-in-disp");
        var inSpec = popover.querySelector("#lg-in-spec");
        if (inRef) { inRef.value = String(ref); updateSliderProgress(inRef); }
        if (inFrost) { inFrost.value = String(frost); updateSliderProgress(inFrost); }
        if (inDisp) { inDisp.value = String(disp); updateSliderProgress(inDisp); }
        if (inSpec) { inSpec.value = String(spec); updateSliderProgress(inSpec); }
        popover.querySelector("#lg-val-ref").textContent = Math.round(ref * 100) + "%";
        popover.querySelector("#lg-val-frost").textContent = Math.round(frost * 100) + "%";
        popover.querySelector("#lg-val-disp").textContent = Math.round(disp * 100) + "%";
        popover.querySelector("#lg-val-spec").textContent = Math.round(spec * 100) + "%";
        rebuildAll();
      }

      var presetBtns = popover.querySelectorAll("button[data-preset]");
      for (var i = 0; i < presetBtns.length; i++) {
        presetBtns[i].addEventListener("click", function (e) {
          var p = e.currentTarget.getAttribute("data-preset");
          if (p === "macos") applyPresetValues(1.35, 1.0, 1.25, 0.20);
          else if (p === "crystal") applyPresetValues(1.65, 0.45, 1.55, 0.25);
          else if (p === "prism") applyPresetValues(2.15, 1.15, 2.4, 0.30);
        });
      }
    }

    applySidebarState();
    syncAvatarDisplays();
    syncAllSliderProgress();
  }

  function updateSliderProgress(s) {
    if (!s) return;
    var min = parseFloat(s.min) || 0;
    var max = parseFloat(s.max) || 100;
    var val = parseFloat(s.value) || 0;
    var pct = Math.max(0, Math.min(100, ((val - min) / (max - min)) * 100));
    s.style.setProperty("--slider-pct", pct + "%");
  }

  function syncAllSliderProgress() {
    if (!popover) return;
    var sliders = popover.querySelectorAll("input[type='range']");
    for (var i = 0; i < sliders.length; i++) {
      updateSliderProgress(sliders[i]);
    }
  }

  /* Intercept clicks on "Settings" inside Apple's User Profile <amp-contextual-menu> */
  document.addEventListener("click", function (e) {
    var target = e.target;
    if (!target || !target.closest) return;

    /* Close our fallback user menu if clicking outside */
    if (userMenu && !userMenu.classList.contains("atv-lg-closed")) {
      if (!target.closest("#atv-lg-user-menu") && !target.closest("#atv-lg-profile-btn") && !target.closest("#atv-lg-sb-profile-btn")) {
        closeUserMenu();
      }
    }

    /* Intercept Setting Gear Click Anywhere (Player Controls Capsule, Top Bar, Sidebar) */
    var gearBtn = target.closest(".atv-lg-player-gear, .btn-glass-setting, #atv-lg-profile-btn .lg-sb-gear, [data-action='settings']");
    if (gearBtn) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      openSettingsModal();
      return;
    }

    var ctxItem = target.closest("amp-contextual-menu button, amp-contextual-menu .contextual-menu-item");
    if (ctxItem) {
      var titleAttr = (ctxItem.getAttribute("title") || "").toLowerCase();
      var itemText = (ctxItem.innerText || ctxItem.textContent || "").trim().toLowerCase();
      var hasGearIcon = !!ctxItem.querySelector(".context-menu__option-icon, svg");
      if (titleAttr === "settings" || itemText.indexOf("setting") !== -1 || itemText.indexOf("การตั้งค่า") !== -1 || hasGearIcon) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        dismissAppleContextualMenu();
        openSettingsModal();
      }
    }

    /* Player Tabs Active Toggle (Info & Continue Watching turn vibrant electric blue #276bff) */
    var tabBtn = target.closest("button.player-tab__trigger");
    if (tabBtn) {
      var wasActive = isTabActive(tabBtn);
      var allTabs = document.querySelectorAll("button.player-tab__trigger");
      for (var k = 0; k < allTabs.length; k++) {
        allTabs[k].classList.remove("active");
        allTabs[k].removeAttribute("aria-selected");
        allTabs[k].removeAttribute("aria-expanded");
        var st = surfaces.get(allTabs[k]);
        if (st) applySurfaceStyles(allTabs[k], st);
      }
      if (!wasActive) {
        tabBtn.classList.add("active");
        tabBtn.setAttribute("aria-selected", "true");
        tabBtn.setAttribute("aria-expanded", "true");
      }
      var stActive = surfaces.get(tabBtn);
      if (stActive) applySurfaceStyles(tabBtn, stActive);
    }
  }, true);

  window.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      closeSettingsModal();
      closeUserMenu();
    }
  });

  /* ------------------------------------------------------------------------
   * DOM Scanner (Handles Svelte Reactive Re-renders Without Losing Glass)
   * ---------------------------------------------------------------------- */
  var scanQueued = false;

  function enhancePlayerShadowDom() {
    try {
      var prog = document.querySelector("amp-playback-controls-progress");
      if (!prog || !prog.shadowRoot) return;
      var pst = prog.shadowRoot.getElementById("atv-lg-prog-style");
      if (!pst) {
        pst = document.createElement("style");
        pst.id = "atv-lg-prog-style";
        prog.shadowRoot.appendChild(pst);
      }
      var shadowCss =
        ":host { display: grid !important; grid-template-areas: 'elapsed scrubber remaining' !important; grid-template-rows: 1fr !important; grid-template-columns: auto 1fr auto !important; column-gap: 16px !important; align-items: center !important; width: 100% !important; height: 100% !important; box-sizing: border-box !important; overflow: visible !important; }" +
        ".elapsed { grid-area: elapsed !important; grid-row: 1 !important; grid-column: 1 !important; align-self: center !important; }" +
        ".scrubber { grid-area: scrubber !important; grid-row: 1 !important; grid-column: 2 !important; align-self: center !important; cursor: pointer !important; display: flex !important; align-items: center !important; height: 100% !important; margin: 0 !important; overflow: visible !important; }" +
        ".remaining { grid-area: remaining !important; grid-row: 1 !important; grid-column: 3 !important; align-self: center !important; }" +
        "time.time { font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif !important; font-size: 13px !important; font-weight: 600 !important; color: rgba(255, 255, 255, 0.95) !important; font-variant-numeric: tabular-nums !important; letter-spacing: -0.01em !important; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6) !important; line-height: 1 !important; margin: 0 !important; display: flex !important; align-items: center !important; }" +
        ".progress-range { width: 100% !important; height: auto !important; position: relative !important; overflow: visible !important; }" +
        "input[type=range] { margin: 0 !important; }" +
        ".progress-range__preview-image, .preview-image { overflow: visible !important; z-index: 9999 !important; pointer-events: none !important; }" +
        ".preview-image__thumbnail { border-radius: 12px !important; overflow: hidden !important; border: 1.2px solid rgba(255, 255, 255, 0.45) !important; box-shadow: 0 16px 44px rgba(0, 0, 0, 0.85), 0 2px 8px rgba(0, 0, 0, 0.5) !important; }" +
        ".preview-image__time { background: linear-gradient(180deg, transparent 40%, rgba(0, 0, 0, 0.75) 100%) !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; border: none !important; border-radius: 0 0 12px 12px !important; box-shadow: none !important; color: #ffffff !important; font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif !important; font-size: 12px !important; font-weight: 600 !important; font-variant-numeric: tabular-nums !important; letter-spacing: -0.01em !important; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9) !important; padding-bottom: 5px !important; }";
      if (pst.textContent !== shadowCss) {
        pst.textContent = shadowCss;
      }
    } catch (e) {}
  }

  function enhancePlayerControls() {
    try {
      var controlsBars = document.querySelectorAll(
        ".video-player__controls, amp-playback-controls .controls-right, .video-player__footer .controls-secondary, .playback-controls__secondary"
      );
      for (var i = 0; i < controlsBars.length; i++) {
        var bar = controlsBars[i];
        if (bar.querySelector(".atv-lg-player-gear")) continue;

        var gearBtn = document.createElement("button");
        gearBtn.type = "button";
        gearBtn.className = "video-player__control atv-lg-player-gear";
        gearBtn.title = "Liquid Glass Settings";
        gearBtn.setAttribute("aria-label", "Liquid Glass Settings");
        gearBtn.innerHTML = ICONS.settings;
        gearBtn.addEventListener("click", function (e) {
          e.preventDefault();
          e.stopPropagation();
          openSettingsModal();
        });
        bar.appendChild(gearBtn);
      }
    } catch (e) {}
  }

  function scan() {
    scanQueued = false;
    if (!document.body) return;
    ensureStyle();
    buildSettingsUI();
    syncSidebarActiveState();
    enhanceMacHeader();
    handleCountryBanner();
    enhancePlayerShadowDom();
    enhancePlayerControls();

    var strayBars = document.querySelectorAll("[data-atv-lg='bar']");
    for (var b = 0; b < strayBars.length; b++) {
      var bar = strayBars[b];
      if (!isTopNavBar(bar)) {
        detach(bar);
        bar.removeAttribute("data-atv-lg");
      }
    }

    surfaces.forEach(function (state, el) {
      if (!el.isConnected) {
        detach(el);
      } else if (state.kind === "bar" && !isTopNavBar(el)) {
        detach(el);
      } else if (el !== popover && el !== sidebar && el !== userMenu && !isNearViewport(el)) {
        detach(el);
      } else {
        applySurfaceStyles(el, state);
      }
    });

    if (!settings.enabled) return;

    for (var i = 0; i < TARGETS.length; i++) {
      var target = TARGETS[i];
      var nodes = document.querySelectorAll(target.selector);
      for (var j = 0; j < nodes.length; j++) {
        var el = nodes[j];
        if (el.closest("#atv-lg-popover") || el.closest("#atv-lg-mac-sidebar") || el.closest("#atv-lg-user-menu")) continue;
        if (target.kind === "bar" && !isTopNavBar(el)) continue;
        if (el.parentElement && el.parentElement.closest("[data-atv-lg='pill'], [data-atv-lg='circle']")) continue;
        if (!isNearViewport(el)) continue;
        var w = el.offsetWidth || el.getBoundingClientRect().width;
        var h = el.offsetHeight || el.getBoundingClientRect().height;
        if (w < (target.minW || 16) || h < (target.minH || 16)) continue;
        attach(el, target.preset, target.kind);
      }
    }
  }

  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(scan, 160);
  }

  function applyEnabledState() {
    var isEco = (FPS_CONFIGS[settings.fpsMode] || {}).eco === true;
    document.documentElement.classList.toggle("atv-lg-on", settings.enabled);
    document.documentElement.classList.toggle("atv-lg-eco", settings.enabled && isEco);
    var toggleEnabledBtn = document.getElementById("lg-toggle-enabled");
    if (toggleEnabledBtn) {
      toggleEnabledBtn.setAttribute("aria-checked", String(settings.enabled));
      toggleEnabledBtn.classList.toggle("active", !!settings.enabled);
    }
    if (settings.enabled) {
      scan();
      rebuildAll();
    } else {
      surfaces.forEach(function (state, el) {
        if (el !== popover && el !== sidebar && el !== userMenu) detach(el);
      });
    }
  }

  /* Real-time pointer tracking for Fresnel specular highlight across glass surfaces (RAF throttled by FPS mode) */
  var lastPointerX = -9999;
  var lastPointerY = -9999;
  var pointerRafPending = false;
  var lastFrameTime = 0;

  function invalidateRects() {
    surfaces.forEach(function (state) {
      state.rect = null;
    });
  }

  function processPointerMove(timestamp) {
    pointerRafPending = false;
    if (!settings.enabled) return;

    var fpsCfg = FPS_CONFIGS[settings.fpsMode] || FPS_CONFIGS[2];
    if (fpsCfg.eco) return;

    var interval = fpsCfg.interval || 0;
    if (interval > 0 && lastFrameTime && (timestamp - lastFrameTime < interval)) {
      return;
    }
    lastFrameTime = timestamp;

    var px = lastPointerX;
    var py = lastPointerY;

    surfaces.forEach(function (state, el) {
      var r = state.rect;
      if (!r) {
        r = el.getBoundingClientRect();
        state.rect = r;
      }
      if (py >= r.top - 120 && py <= r.bottom + 120 && px >= r.left - 120 && px <= r.right + 120) {
        el.style.setProperty("--lg-mx", Math.round(px - r.left) + "px");
        el.style.setProperty("--lg-my", Math.round(py - r.top) + "px");
      }
    });
  }

  function onPointerMove(e) {
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;
    if (!pointerRafPending) {
      pointerRafPending = true;
      requestAnimationFrame(processPointerMove);
    }
  }

  window.__atvOpenSettings = openSettingsModal;

  function start() {
    var isEco = (FPS_CONFIGS[settings.fpsMode] || {}).eco === true;
    document.documentElement.classList.toggle("atv-lg-on", settings.enabled);
    document.documentElement.classList.toggle("atv-lg-eco", settings.enabled && isEco);
    scan();

    var mo = new MutationObserver(queueScan);
    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"]
    });

    window.addEventListener("scroll", function () {
      invalidateRects();
      queueScan();
    }, { passive: true });

    window.addEventListener("resize", function () {
      invalidateRects();
      queueScan();
      rebuildAll();
    }, { passive: true });

    window.addEventListener("pointermove", onPointerMove, { passive: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
