/**
 * LiquidGlass Standalone Optical Engine
 * 
 * Direct port of the official Apple TV liquid-glass.js optical pipeline.
 * Implements:
 *   1. Signed Distance Field (SDF) 2D outward surface normals
 *   2. Snell's Law convex squircle lens profile: h(x) = (1 - (1 - x)^4)^(1/4)
 *   3. Triple-channel chromatic dispersion (feDisplacementMap R, G, B)
 *   4. Fresnel specular rim & inner caustics (feComposite over)
 *   5. Hardware-accelerated backdrop-filter with userSpaceOnUse mapping
 */
(function (root, factory) {
  if (typeof define === "function" && define.amd) {
    define([], factory);
  } else if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.LiquidGlass = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SVG_NS = "http://www.w3.org/2000/svg";
  var XLINK_NS = "http://www.w3.org/1999/xlink";
  var SVG_ROOT_ID = "liquid-glass-svg-defs";
  var STYLE_ID = "liquid-glass-engine-styles";
  var MAX_MAP_PIXELS = 64000;
  var IOR = 1.52;
  var PROFILE_STEPS = 256;

  var PRESETS = {
    panel: {
      bezel: 24,
      thickness: 36,
      frost: 0,
      dispersion: 0.08,
      saturate: 1.10,
      specular: 1.05,
      tint: "rgba(255, 255, 255, 0.02)",
      bgImage: "none",
      radius: 26
    },
    card: {
      bezel: 18,
      thickness: 30,
      frost: 0,
      dispersion: 0.075,
      saturate: 1.10,
      specular: 1.00,
      tint: "rgba(255, 255, 255, 0.02)",
      bgImage: "none",
      radius: 20
    },
    button: {
      bezel: 14,
      thickness: 22,
      frost: 0,
      dispersion: 0.065,
      saturate: 1.08,
      specular: 1.10,
      tint: "rgba(255, 255, 255, 0.03)",
      bgImage: "none",
      radius: 14
    },
    pill: {
      bezel: 14,
      thickness: 24,
      frost: 0,
      dispersion: 0.07,
      saturate: 1.08,
      specular: 1.05,
      tint: "rgba(255, 255, 255, 0.03)",
      bgImage: "none",
      radius: 999
    },
    dock: {
      bezel: 20,
      thickness: 32,
      frost: 0,
      dispersion: 0.08,
      saturate: 1.10,
      specular: 1.05,
      tint: "rgba(255, 255, 255, 0.03)",
      bgImage: "none",
      radius: 20
    },
    circle: {
      bezel: 22,
      thickness: 34,
      frost: 0,
      dispersion: 0.08,
      saturate: 1.10,
      specular: 1.05,
      tint: "rgba(255, 255, 255, 0.02)",
      bgImage: "none",
      radius: 999
    },
    square: {
      bezel: 18,
      thickness: 30,
      frost: 0,
      dispersion: 0.075,
      saturate: 1.10,
      specular: 1.00,
      tint: "rgba(255, 255, 255, 0.02)",
      bgImage: "none",
      radius: 28
    }
  };

  var settings = {
    enabled: true,
    refractionScale: 1.35,
    frostScale: 1.0,
    dispersionScale: 1.25,
    specularScale: 1.00,
    lightX: -0.52,
    lightY: -0.85
  };

  var surfaces = new Map();
  var mapCache = new Map();
  var filterSeq = 0;
  var svgDefs = null;
  var isObserving = false;

  /* Optical Physics Functions */
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

  function generateMaps(width, height, radius, preset) {
    var effThickness = preset.thickness * settings.refractionScale;
    var effSpecular = preset.specular * settings.specularScale;
    var qw = Math.max(16, Math.round(width / 2) * 2);
    var qh = Math.max(16, Math.round(height / 2) * 2);
    var qr = Math.round(radius);

    var key = [
      qw,
      qh,
      qr,
      preset.bezel,
      effThickness.toFixed(1),
      effSpecular.toFixed(2)
    ].join("|");

    var hit = mapCache.get(key);
    if (hit) return hit;

    var scale = Math.min(1, Math.sqrt(MAX_MAP_PIXELS / Math.max(1, qw * qh)));
    var cw = Math.max(4, Math.round(qw * scale));
    var ch = Math.max(4, Math.round(qh * scale));
    var r = Math.min(qr, qw / 2, qh / 2) * scale;
    var bezel = Math.max(2, Math.min(preset.bezel, Math.min(qw, qh) / 2) * scale);
    var profile = buildProfile(effThickness);
    var maxShift = Math.max(0.0001, profile.max);

    var lx = settings.lightX;
    var ly = settings.lightY;
    var halfW = cw / 2;
    var halfH = ch / 2;

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

          var edgeBand = Math.max(0, 1 - distFromEdge / Math.max(2, bezel * 0.22));
          var crest = Math.pow(edgeBand, 3.0);
          var topLight = Math.max(0, nx * lx + ny * ly);
          var botLight = Math.max(0, -nx * lx - ny * ly);
          var rimIntensity = crest * (0.85 * Math.pow(topLight, 1.45) + 0.25 * Math.pow(botLight, 2.2)) * effSpecular;

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

    if (mapCache.size > 60) mapCache.clear();
    mapCache.set(key, result);
    return result;
  }

  function ensureSvgDefs() {
    if (svgDefs && svgDefs.isConnected) return svgDefs;
    var root = document.getElementById(SVG_ROOT_ID);
    if (!root) {
      root = document.createElementNS(SVG_NS, "svg");
      root.id = SVG_ROOT_ID;
      root.setAttribute("aria-hidden", "true");
      root.setAttribute("width", "0");
      root.setAttribute("height", "0");
      root.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;overflow:hidden;pointer-events:none;z-index:-1;";
      var defs = document.createElementNS(SVG_NS, "defs");
      root.appendChild(defs);
      (document.body || document.documentElement).appendChild(root);
      svgDefs = defs;
    } else {
      svgDefs = root.querySelector("defs") || root;
    }
    return svgDefs;
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
    /* Authentic 2.2x optical displacement magnitude matching liquid-glass.js */
    var baseScale = maps.maxShift * 2.2 * settings.refractionScale;
    var disp = preset.dispersion * settings.dispersionScale;
    var frost = Math.max(0, (preset.frost !== undefined ? preset.frost : 0) * settings.frostScale);

    var f = svgEl("filter", {
      id: id,
      x: "-10%",
      y: "-10%",
      width: "120%",
      height: "120%",
      filterUnits: "objectBoundingBox",
      primitiveUnits: "userSpaceOnUse",
      "color-interpolation-filters": "sRGB"
    });

    var sourceInput = "SourceGraphic";
    if (frost > 0.05) {
      f.appendChild(svgEl("feGaussianBlur", {
        "in": "SourceGraphic",
        stdDeviation: frost.toFixed(2),
        edgeMode: "duplicate",
        result: "frost"
      }));
      sourceInput = "frost";
    }

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
      "in": sourceInput,
      in2: "map",
      scale: (baseScale * (1 + disp)).toFixed(2),
      xChannelSelector: "R",
      yChannelSelector: "G",
      result: "dispR"
    }));
    f.appendChild(svgEl("feDisplacementMap", {
      "in": sourceInput,
      in2: "map",
      scale: baseScale.toFixed(2),
      xChannelSelector: "R",
      yChannelSelector: "G",
      result: "dispG"
    }));
    f.appendChild(svgEl("feDisplacementMap", {
      "in": sourceInput,
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

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent = [
      ".lg-surface {",
      "  isolation: isolate;",
      "  border: 1px solid rgba(255, 255, 255, 0.25) !important;",
      "  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.35), inset 0 1px 1px rgba(255, 255, 255, 0.35) !important;",
      "  transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.2s ease;",
      "}"
    ].join("\n");
    (document.head || document.documentElement).appendChild(st);
  }

  function attach(el, options) {
    if (!el || !(el instanceof HTMLElement)) return;
    ensureStyles();
    var defs = ensureSvgDefs();

    var opt = options || {};
    var presetName = typeof opt === "string" ? opt : (opt.preset || el.getAttribute("data-liquid-glass") || "card");
    var basePreset = PRESETS[presetName] || PRESETS.card;
    var preset = Object.assign({}, basePreset, typeof opt === "object" ? opt : {});

    var state = surfaces.get(el);
    if (!state) {
      state = {
        filterId: "atv-lg-filter-" + (++filterSeq),
        filter: null,
        sig: "",
        w: 0,
        h: 0,
        r: 0
      };
      surfaces.set(el, state);
    }

    var w = Math.round(el.offsetWidth || 120);
    var h = Math.round(el.offsetHeight || 40);
    var r = preset.radius || 16;
    if (presetName === "pill" || presetName === "circle") r = Math.min(w, h) / 2;

    var sig = [
      w,
      h,
      r,
      preset.bezel,
      (preset.thickness * settings.refractionScale).toFixed(1),
      (preset.specular * settings.specularScale).toFixed(2),
      (preset.dispersion * settings.dispersionScale).toFixed(3)
    ].join("|");

    if (state.sig === sig && state.filter && state.filter.isConnected) {
      return;
    }
    state.sig = sig;
    state.w = w;
    state.h = h;
    state.r = r;

    var newFilter = buildFilterElement(state.filterId, w, h, r, preset);
    if (state.filter && state.filter.parentNode) {
      defs.replaceChild(newFilter, state.filter);
    } else {
      defs.appendChild(newFilter);
    }
    state.filter = newFilter;

    if (!el.classList.contains("lg-surface")) {
      el.classList.add("lg-surface");
    }

    var filterVal = "url(#" + state.filterId + ")";
    el.style.setProperty("backdrop-filter", filterVal, "important");
    el.style.setProperty("-webkit-backdrop-filter", filterVal, "important");
    el.style.setProperty("background-color", preset.tint || "transparent", "important");
    if (preset.bgImage && preset.bgImage !== "none") {
      el.style.setProperty("background-image", preset.bgImage, "important");
    } else {
      el.style.removeProperty("background-image");
    }
    el.setAttribute("data-lg-attached", "true");
  }

  function detach(el) {
    if (!el || !surfaces.has(el)) return;
    var state = surfaces.get(el);
    surfaces.delete(el);
    el.classList.remove("lg-surface");
    el.removeAttribute("data-lg-attached");
    el.style.removeProperty("--lg-bg");
    el.style.removeProperty("--lg-filter");
    el.style.removeProperty("backdrop-filter");
    el.style.removeProperty("-webkit-backdrop-filter");
    el.style.removeProperty("background");
    if (state.filter && state.filter.parentNode) {
      state.filter.parentNode.removeChild(state.filter);
    }
  }

  function autoScan() {
    var targets = document.querySelectorAll("[data-liquid-glass], .liquid-glass");
    for (var i = 0; i < targets.length; i++) {
      attach(targets[i]);
    }
  }

  function init(options) {
    if (options) {
      if (options.refraction !== undefined) settings.refractionScale = options.refraction;
      if (options.dispersion !== undefined) settings.dispersionScale = options.dispersion;
      if (options.specular !== undefined) settings.specularScale = options.specular;
      if (options.frost !== undefined) settings.frostScale = options.frost;
      if (options.presets) {
        for (var k in options.presets) {
          if (Object.prototype.hasOwnProperty.call(options.presets, k)) {
            PRESETS[k] = Object.assign({}, PRESETS[k] || {}, options.presets[k]);
          }
        }
      }
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () {
        autoScan();
      }, { once: true });
    } else {
      autoScan();
    }

    if (!isObserving) {
      isObserving = true;
      var mo = new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var m = mutations[i];
          if (m.target && (m.target.id === SVG_ROOT_ID || (m.target.closest && m.target.closest("#" + SVG_ROOT_ID)))) {
            continue;
          }
          if (m.addedNodes && m.addedNodes.length > 0) {
            for (var j = 0; j < m.addedNodes.length; j++) {
              var n = m.addedNodes[j];
              if (n.nodeType === 1 && (n.hasAttribute("data-liquid-glass") || (n.querySelector && n.querySelector("[data-liquid-glass]")))) {
                autoScan();
                return;
              }
            }
          }
        }
      });

      mo.observe(document.documentElement, {
        childList: true,
        subtree: true
      });

      window.addEventListener("resize", function () {
        mapCache.clear();
        surfaces.forEach(function (state, el) {
          attach(el);
        });
      }, { passive: true });
    }
  }

  if (typeof window !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () {
        init();
      }, { once: true });
    } else {
      init();
    }
  }

  return {
    init: init,
    attach: attach,
    detach: detach,
    update: autoScan,
    presets: PRESETS,
    settings: settings
  };
});
