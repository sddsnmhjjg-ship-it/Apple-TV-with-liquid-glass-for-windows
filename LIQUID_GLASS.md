# Liquid Glass Engine — Integration Guide

A portable, real-time optical refraction and caustics engine for modern web applications.

---

## 1. Quick Start

Copy `liquid-glass.standalone.js` and `liquid-glass.css` into your project directory, then include them in your HTML:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <link rel="stylesheet" href="liquid-glass.css">
  <script src="liquid-glass.standalone.js"></script>
</head>
<body style="background: #0d0e15; min-height: 100vh; padding: 40px;">

  <!-- Liquid Glass Panel -->
  <div data-liquid-glass="panel" style="max-width: 600px; padding: 30px; margin: auto;">
    <h1 style="color: white; margin-bottom: 16px;">Liquid Glass Window</h1>
    <p style="color: rgba(255, 255, 255, 0.7); margin-bottom: 24px;">
      Real-time Snell's law refraction with chromatic dispersion and specular rim caustics.
    </p>

    <!-- Interactive Buttons -->
    <button data-liquid-glass="button" class="lg-glass-btn">Standard Action</button>
    <button data-liquid-glass="button" class="lg-glass-btn active">Selected Blue</button>
  </div>

</body>
</html>
```

---

## 2. Available Presets

Add `data-liquid-glass="<preset>"` to any HTML element:

* `panel`: Large windows, modals, main viewports (24px bezel, deep refraction).
* `card`: Floating cards, info widgets (16px bezel, balanced caustics).
* `button`: Interactive controls, action buttons (12px bezel, tactile depth).
* `pill`: Navigation capsules, status tags, badges (rounded pill).
* `dock`: Floating docks, taskbars (18px bezel, smooth refraction).
* `slider`: Progress tracks, volume scrubbers.

---

## 3. JavaScript API Reference

The global `LiquidGlass` object provides full programmatic control:

```javascript
// Attach to any DOM element with custom settings
const el = document.getElementById("my-element");
LiquidGlass.attach(el, {
  preset: "card",
  thickness: 30,     // Glass volume thickness
  bezel: 16,         // Bezel curvature width in pixels
  specular: 0.95,    // Specular rim intensity (0.0 to 1.5)
  dispersion: 0.05   // Chromatic dispersion strength (0.0 to 0.1)
});

// Remove optical glass from an element
LiquidGlass.detach(el);

// Configure global engine behavior
LiquidGlass.init({
  fps: "60fps",       // "30fps" | "60fps" | "unlimited" | "eco"
  specular: 1.0,      // Master specular multiplier
  refraction: 1.0     // Master refraction scale
});

// Manually trigger a rescan after dynamic DOM updates
LiquidGlass.update();
```

---

## 4. Hardware-Accelerated Pure CSS Fallback

If you prefer pure CSS without JavaScript SVG filters, use the utility classes provided in `liquid-glass.css`:

```html
<div class="lg-glass lg-glass-card">
  <h2>Pure CSS Glass</h2>
  <button class="lg-glass-btn active">Active Tab</button>
</div>
```

Class names available:
* `.lg-glass` (Base container)
* `.lg-glass-panel` (Window/panel)
* `.lg-glass-card` (Card)
* `.lg-glass-btn` (Button)
* `.lg-glass-btn.active` (macOS Blue button)
* `.lg-glass-pill` (Pill capsule)
* `.lg-glass-slider` (Range slider)
