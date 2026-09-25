# LamaniSync / Lamanify Attio Architectural Design System Standard

This specification defines the authoritative design tokens, layout hierarchy, grid systems, and component patterns extracted and standardized from Attio's production UI. Every new marketing page, integration lander, and feature view in `lamanisync.com` must strictly adhere to these rules.

---

## 1. Core Principles & Philosophy
1. **Architectural Grounding**: Never float content inside unstructured voids. Every block is framed with crisp structural hairlines (`1px solid #e2e8f0` / `border-subtle`).
2. **Hairline 1px Grids**: Use `gap: 1px` over a subtle border background (`#e2e8f0`) rather than individual card borders to create seamless dividers without border doubling.
3. **Alternating Section Rhythm**: Alternate between pure white canvas (`#ffffff`) and shaded canvas (`#fafafa`) flanked by diagonal hatch gutters (`repeating-linear-gradient(125deg...)`).
4. **Two-Tone Typography**: Pair deep black titles (`#1c1d1f`, 500/600 weight) with immediately following muted slate continuation text (`#6f7988`, 400 weight).
5. **No Visual Noise**: Zero arbitrary crimson/pink badges, zero heavy drop shadows, zero cartoon illustrations. Use monospace bracketed indicators (`[01]`, `[02]`, `[LEGACY]`) and micro-pinstripes.

---

## 2. Design Tokens

### Color Palette
```css
:root {
  /* Surfaces */
  --bg-primary: #ffffff;
  --bg-shaded: #fafafa;
  --bg-dark: #0b0c0e;
  --bg-dark-footer: #08090a;
  
  /* Borders & Hairlines */
  --border-subtle: #e2e8f0;
  --border-dark-subtle: rgba(255, 255, 255, 0.08);
  --border-dark-button: rgba(255, 255, 255, 0.16);
  
  /* Text */
  --text-dark-primary: #1c1d1f;   /* Title lead */
  --text-dark-muted: #6f7988;     /* Inline continuation & body */
  --text-light-primary: #ffffff;  /* Dark section heading */
  --text-light-muted: #94a3b8;    /* Dark section subtext */
  
  /* Status / Accents */
  --chip-green-bg: #dcfce7;
  --chip-green-text: #15803d;
  --chip-blue-bg: #dbeafe;
  --chip-blue-text: #1d4ed8;
  --chip-purple-bg: #f3e8ff;
  --chip-purple-text: #7e22ce;
}
```

### Typography Specs
* **Section Heading H2**: `clamp(2rem, 3.8vw, 3rem)`, `font-weight: 500`, `letter-spacing: -0.03em`, `line-height: 1.15`.
* **Dark CTA Headline**: `clamp(2.5rem, 5.2vw, 4rem)`, `font-weight: 600`, `letter-spacing: -0.035em`, `line-height: 1.1`.
* **Card Title**: `1.125rem`–`1.18rem`, `font-weight: 500`, `letter-spacing: -0.015em`, `line-height: 1.35`.
* **Lead Subtitle / Description**: `1.0625rem`, `color: #6f7988`, `line-height: 1.6`.
* **Monospace Indices (`[01]`, `[02]`)**: `0.75rem`, `font-weight: 600`, `letter-spacing: 0.08em`, `font-family: ui-monospace, SFMono-Regular, monospace`, `color: #94a3b8`.

---

## 3. Structural Layout & Section Templates

### A. Section Framing Wrapper
Every section MUST be wrapped in a centered container with left/right borders:
```html
<section class="attio-section [shaded-bg] border-t border-subtle">
  <div class="attio-container border-x border-subtle">
    <!-- Header, dividers, and grid content -->
  </div>
</section>
```
```css
.border-t { border-top: 1px solid #e2e8f0; }
.border-x { border-left: 1px solid #e2e8f0; border-right: 1px solid #e2e8f0; }
.border-subtle { border-color: #e2e8f0; }

.attio-section { background: #ffffff; position: relative; }
.attio-section.shaded-bg { background: #fafafa; }
.attio-container {
  max-width: 1200px;
  margin: 0 auto;
  position: relative;
  background: #ffffff;
}
```

### B. Two-Tone Inline Header
Do NOT put badges or centered floating blocks above the heading. Left-align and flow primary into muted subtext:
```html
<header class="attio-section-head">
  <div class="attio-head-inner">
    <h2 class="attio-h2-inline">
      <span class="text-primary">Primary statement goes here.</span>
      <span class="text-muted font-normal"> Inline secondary continuation describing the value.</span>
    </h2>
    <p class="attio-lead-desc">
      Two-sentence descriptive paragraph explaining mechanism and clinical outcome.
    </p>
  </div>
</header>
```
```css
.attio-section-head { padding: 6rem 3.5rem 3rem 3.5rem; background: #ffffff; }
.attio-head-inner { max-width: 860px; }
.attio-h2-inline {
  font-size: clamp(2rem, 3.8vw, 3rem);
  font-weight: 500;
  letter-spacing: -0.03em;
  line-height: 1.15;
  margin: 0 0 1.25rem 0;
  text-wrap: balance;
}
.text-primary { color: #1c1d1f; }
.text-muted { color: #6f7988; }
.attio-lead-desc { font-size: 1.0625rem; color: #6f7988; line-height: 1.6; margin: 0; max-width: 680px; }
```

### C. Dashed Hairline Divider
Always place between header and card grid:
```html
<div class="attio-separator-wrap">
  <div class="attio-dashed-line"></div>
</div>
```
```css
.attio-separator-wrap { position: relative; width: 100%; height: 1px; background: #e2e8f0; }
.attio-dashed-line {
  width: 100%;
  height: 1px;
  background-image: linear-gradient(to right, #cbd5e1 50%, transparent 50%);
  background-size: 8px 1px;
}
```

### D. Diagonal Hatch Gutters & Inset 1px Grid
Used for shaded showcase sections:
```html
<div class="attio-hatch-container">
  <div class="attio-hatch-bg" aria-hidden="true"></div>

  <div class="attio-grid-wrap">
    <div class="attio-3col-grid">
      <!-- Cards rendered with 1px gap background -->
      <div class="attio-card">...</div>
      <div class="attio-card">...</div>
      <div class="attio-card">...</div>
    </div>
  </div>
</div>
```
```css
.attio-hatch-container {
  position: relative;
  background-color: #fafafa;
  overflow: hidden;
  padding: 0 2rem;
}
.attio-hatch-bg {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image: repeating-linear-gradient(
    125deg,
    transparent,
    transparent 6px,
    rgba(15, 23, 42, 0.035) 6px,
    rgba(15, 23, 42, 0.035) 7px
  );
}
.attio-grid-wrap {
  position: relative;
  z-index: 1;
  border-left: 1px solid #e2e8f0;
  border-right: 1px solid #e2e8f0;
}
.attio-3col-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1px;
  background: #e2e8f0;
}
```

### E. Shaded Card with Dot Matrix Viewport
```html
<div class="attio-feature-card">
  <div class="card-visual-box">
    <div class="dot-matrix-canvas"></div>
    <!-- Clean UI Mockup (Field Mapper, Timeline, or Workflow Node) -->
    <div class="ui-mockup-panel">...</div>
  </div>
  <div class="card-text-box">
    <h3 class="card-title">Card Heading.</h3>
    <p class="card-desc">Description of the capability.</p>
  </div>
</div>
```
```css
.card-visual-box {
  position: relative;
  height: 290px;
  background-color: #fafafa;
  border-bottom: 1px solid #e2e8f0;
  padding: 1.75rem 1.25rem;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.dot-matrix-canvas {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image: radial-gradient(#cbd5e1 1px, transparent 1px);
  background-size: 16px 16px;
  opacity: 0.65;
}
.card-text-box {
  background: #ffffff;
  padding: 2.25rem 2rem;
  flex: 1;
}
```

---

## 4. Dark CTA Standard (`#0b0c0e`)

The final page CTA must follow the minimalist Attio dark standard:
1. **Top White Architectural Strip**: 44px white bar with faint vertical grid tick markers (`#f1f5f9`).
2. **Near-Black Canvas**: `#0b0c0e` with 1200px container bounded by `rgba(255, 255, 255, 0.08)` borders.
3. **Dense Vertical Micro-Pinstripes**: 4px repeat pitch at 3%–4% white opacity, masked with a radial fade.
4. **Bold 2-Line Headline**: Centered white text (`2.5rem`–`4rem`, weight 600).
5. **Button Pair**:
   * Primary: `#25272c`, 1px border `rgba(255, 255, 255, 0.16)`, 6px border-radius.
   * Secondary: Transparent, 1px border `rgba(255, 255, 255, 0.16)`, 6px border-radius.

```html
<section class="dark-cta-section" id="cta">
  <div class="top-strip">
    <div class="top-strip-inner">
      <div class="tick"></div><div class="tick"></div><div class="tick"></div><div class="tick"></div>
    </div>
  </div>
  <div class="dark-canvas-container">
    <div class="dark-box">
      <div class="dark-pinstripes" aria-hidden="true"></div>
      <div class="dark-cta-content">
        <h2 class="dark-cta-title">Clinic synchronization<br />runs on LamaniSync.</h2>
        <div class="dark-cta-actions">
          <a href="https://lamanihub.com" class="btn-dark-primary">Start for free</a>
          <a href="/contact" class="btn-dark-secondary">Talk to sales</a>
        </div>
      </div>
    </div>
  </div>
</section>
```

---

## 5. Dark Footer Standard (`#08090a`)

* Background: `#08090a`
* Top border: `1px solid rgba(255, 255, 255, 0.08)`
* Typography: Links in `#64748b` transitioning to `#ffffff` on hover. Titles in `#f1f5f9` uppercase.
* Logo: Official white LamaniSync mark with transparent alpha channel (`https://res.cloudinary.com/lamanify/image/upload/v1790326618/Lamanify_Logo_21_caribk.png`). Zero CSS invert filter.

---

## 6. Replication Checklist for New Pages
When creating or refactoring pages (e.g. `/integrate/*`, `/features`, `/docs`):
- [ ] Section bounded by `.attio-container.border-x.border-subtle` (max-width: 1200px).
- [ ] Section heading uses inline two-tone pattern (`.text-primary` + `.text-muted`).
- [ ] Header followed by `.attio-separator-wrap` with `.attio-dashed-line`.
- [ ] Multi-card grids rendered with `gap: 1px` over `#e2e8f0` background.
- [ ] Numbered cards indexed with monospace brackets: `[01]`, `[02]`, `[03]`.
- [ ] Shaded sections framed by `.attio-hatch-container` with diagonal hatch gutters.
- [ ] UI viewports styled with `.dot-matrix-canvas` (16px–20px radial gradient).
- [ ] Bottom CTA adheres to dark micro-pinstripes canvas.
- [ ] Footer uses dark theme with white logo.
