import { useState, useRef, useEffect, useCallback } from "react";

const BG_DARK = "#131313";
const BG_LIGHT = "#F2F2F2";

// Color mode configs
const COLOR_MODES = [
  { id: "black", label: "Black", bg: BG_LIGHT, fg: BG_DARK },
  { id: "white", label: "White", bg: BG_DARK,  fg: BG_LIGHT },
  { id: "green", label: "Green", bg: BG_DARK,  fg: "#20DFB9" },
  { id: "blue",  label: "Blue",  bg: BG_DARK,  fg: "#5C9AFF" },
];

// Dim color depends only on background
const getDim = (bg) => bg === BG_DARK ? "#4F5257" : "#D0D1D4";

export default function PixelTool() {
  const [gridSize, setGridSize] = useState(40);
  const [threshold, setThreshold] = useState(128);
  const [squareRatio, setSquareRatio] = useState(0.85);
  const [colorMode, setColorMode] = useState("black");
  const [activeRatio, setActiveRatio] = useState(100); // % of cells shown in fg color
  const [pixelInvert, setPixelInvert] = useState(false);
  const [activeSizes, setActiveSizes] = useState(new Set(["large"]));
  const [sizeBreaks, setSizeBreaks] = useState([40, 70]);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageName, setImageName] = useState("");
  const [isDragging, setIsDragging] = useState(false);

  const fileInputRef = useRef(null);
  const displayCanvasRef = useRef(null);
  const imageRef = useRef(null);
  const activeSetRef = useRef(new Set()); // keys of "active" (bright) cells
  const trackRef = useRef(null);

  const currentMode = COLOR_MODES.find(m => m.id === colorMode);

  const getFilledCells = useCallback((W, H, img) => {
    const cellSize = Math.min(W, H) / gridSize;
    const cols = Math.floor(W / cellSize);
    const rows = Math.floor(H / cellSize);
    const offscreen = document.createElement("canvas");
    offscreen.width = W; offscreen.height = H;
    const octx = offscreen.getContext("2d");
    octx.drawImage(img, 0, 0, W, H);
    const cells = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const sx = Math.floor((col + 0.5) * cellSize);
        const sy = Math.floor((row + 0.5) * cellSize);
        const px = octx.getImageData(sx, sy, 1, 1).data;
        if (px[3] < 10) continue;
        const br = 0.299 * px[0] + 0.587 * px[1] + 0.114 * px[2];
        const isDark = br < threshold;
        if (pixelInvert ? !isDark : isDark) {
          cells.push({ row, col, brightness: pixelInvert ? br : 255 - br });
        }
      }
    }
    return { cells, cellSize };
  }, [gridSize, threshold, pixelInvert]);

  const getSqRatio = useCallback((brightness) => {
    const t = (brightness / 255) * 100;
    const active = ["large", "medium", "small"].filter(s => activeSizes.has(s));
    if (active.length === 0) return squareRatio;
    if (active.length === 1) {
      return active[0] === "large" ? squareRatio : active[0] === "medium" ? squareRatio * 0.6 : squareRatio * 0.28;
    }
    const [b1, b2] = sizeBreaks;
    let size;
    if (active.length === 3) {
      size = t >= b2 ? "large" : t >= b1 ? "medium" : "small";
    } else {
      const mid = b1 + (b2 - b1) / 2;
      size = t >= mid ? active[0] : active[1];
    }
    return size === "large" ? squareRatio : size === "medium" ? squareRatio * 0.6 : squareRatio * 0.28;
  }, [squareRatio, activeSizes, sizeBreaks]);

  // Stratified sampling: divide grid into zones, pick proportionally from each
  const buildActiveSet = useCallback((cells, ratio) => {
    if (ratio >= 100) { activeSetRef.current = new Set(); return; }
    if (ratio <= 0) { activeSetRef.current = new Set(cells.map(({ row, col }) => `${row},${col}`).map(() => null)).constructor(); return; }

    const countActive = Math.round(cells.length * ratio / 100);
    if (countActive === 0) { activeSetRef.current = new Set(); return; }

    // Find grid bounds
    const rows = cells.map(c => c.row);
    const cols = cells.map(c => c.col);
    const minR = Math.min(...rows), maxR = Math.max(...rows);
    const minC = Math.min(...cols), maxC = Math.max(...cols);

    // Number of zones — sqrt of countActive gives good granularity
    const zones = Math.max(2, Math.round(Math.sqrt(countActive)));
    const zoneH = (maxR - minR + 1) / zones;
    const zoneW = (maxC - minC + 1) / zones;

    // Bucket cells into zones
    const buckets = {};
    for (const cell of cells) {
      const zr = Math.min(zones - 1, Math.floor((cell.row - minR) / zoneH));
      const zc = Math.min(zones - 1, Math.floor((cell.col - minC) / zoneW));
      const k = `${zr},${zc}`;
      if (!buckets[k]) buckets[k] = [];
      buckets[k].push(`${cell.row},${cell.col}`);
    }

    // Shuffle each bucket
    const bucketKeys = Object.keys(buckets);
    for (const k of bucketKeys) {
      const arr = buckets[k];
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
    }

    // Pick proportionally from each zone
    const result = new Set();
    let remaining = countActive;
    const totalBuckets = bucketKeys.length;

    // First pass: give each bucket its fair share
    const perBucket = Math.floor(countActive / totalBuckets);
    const extras = countActive - perBucket * totalBuckets;

    const shuffledBuckets = [...bucketKeys].sort(() => Math.random() - 0.5);
    for (let i = 0; i < shuffledBuckets.length; i++) {
      const arr = buckets[shuffledBuckets[i]];
      const take = Math.min(arr.length, perBucket + (i < extras ? 1 : 0));
      for (let j = 0; j < take; j++) result.add(arr[j]);
    }

    // Second pass: fill remaining if some buckets were too small
    if (result.size < countActive) {
      const allKeys = cells.map(({ row, col }) => `${row},${col}`).filter(k => !result.has(k));
      for (let i = allKeys.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [allKeys[i], allKeys[j]] = [allKeys[j], allKeys[i]];
      }
      let i = 0;
      while (result.size < countActive && i < allKeys.length) result.add(allKeys[i++]);
    }

    activeSetRef.current = result;
  }, []);

  const draw = useCallback(() => {
    const cvs = displayCanvasRef.current;
    if (!imageRef.current || !cvs) return;
    const W = cvs.width, H = cvs.height;
    const ctx = cvs.getContext("2d");
    const { cells, cellSize } = getFilledCells(W, H, imageRef.current);
    const { bg, fg } = currentMode;
    const dim = getDim(bg);

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Rebuild active set only if ratio < 100 and set is empty or size mismatch
    if (activeRatio < 100 && activeSetRef.current.size === 0) {
      buildActiveSet(cells, activeRatio);
    }

    for (const { row, col, brightness } of cells) {
      const key = `${row},${col}`;
      const sqRatio = getSqRatio(brightness);
      const isActive = activeRatio >= 100 || activeSetRef.current.has(key);
      const sq = cellSize * sqRatio;
      const p = (cellSize - sq) / 2;
      ctx.fillStyle = isActive ? fg : dim;
      ctx.fillRect(col * cellSize + p, row * cellSize + p, sq, sq);
    }
  }, [getFilledCells, getSqRatio, currentMode, activeRatio, buildActiveSet]);

  useEffect(() => { if (imageLoaded) draw(); }, [draw, imageLoaded]);

  const handleActiveRatio = (val) => {
    if (!imageRef.current || !displayCanvasRef.current) { setActiveRatio(val); return; }
    const { cells } = getFilledCells(displayCanvasRef.current.width, displayCanvasRef.current.height, imageRef.current);
    buildActiveSet(cells, val);
    setActiveRatio(val);
  };

  const handleColorMode = (mode) => {
    activeSetRef.current = new Set();
    setColorMode(mode);
  };

  const loadImageFromSource = (source) => {
    setImageLoaded(false);
    activeSetRef.current = new Set();
    const img = new Image();
    img.onload = () => {
      imageRef.current = img;
      const maxSize = 600;
      let w = img.width, h = img.height;
      if (w > h) { h = Math.round(h * maxSize / w); w = maxSize; }
      else { w = Math.round(w * maxSize / h); h = maxSize; }
      displayCanvasRef.current.width = w;
      displayCanvasRef.current.height = h;
      setImageLoaded(true);
    };
    img.src = source;
  };

  const loadImage = (file) => {
    if (!file || !file.type.startsWith("image/")) return;
    setImageName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => loadImageFromSource(e.target.result);
    reader.readAsDataURL(file);
  };

  const handleFile = (e) => loadImage(e.target.files[0]);
  const handleDrop = (e) => { e.preventDefault(); setIsDragging(false); loadImage(e.dataTransfer.files[0]); };

  // Paste from clipboard
  useEffect(() => {
    const onPaste = async (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) { setImageName("pasted image"); loadImage(file); }
          break;
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  const exportPNG = () => {
    if (!imageRef.current || !displayCanvasRef.current || !imageLoaded) return;
    const srcW = displayCanvasRef.current.width;
    const srcH = displayCanvasRef.current.height;
    const EXPORT_W = 2000;
    const EXPORT_H = Math.round(srcH * EXPORT_W / srcW);
    const scale = EXPORT_W / srcW;

    const { cells, cellSize } = getFilledCells(srcW, srcH, imageRef.current);
    const { fg } = currentMode;
    const bg = currentMode.bg; // used for dim only
    const dim = getDim(bg);

    const exp = document.createElement("canvas");
    exp.width = EXPORT_W; exp.height = EXPORT_H;
    const ctx = exp.getContext("2d");
    // transparent background — no fillRect

    for (const { row, col, brightness } of cells) {
      const key = `${row},${col}`;
      const sqRatio = getSqRatio(brightness);
      const isActive = activeRatio >= 100 || activeSetRef.current.has(key);
      const sq = cellSize * sqRatio * scale;
      const p = (cellSize * scale - sq) / 2;
      ctx.fillStyle = isActive ? fg : dim;
      ctx.fillRect(col * cellSize * scale + p, row * cellSize * scale + p, sq, sq);
    }

    const a = document.createElement("a");
    a.href = exp.toDataURL("image/png");
    a.download = "pixel-export.png";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };

  const exportSVG = () => {
    if (!imageRef.current || !displayCanvasRef.current || !imageLoaded) return;
    const W = displayCanvasRef.current.width, H = displayCanvasRef.current.height;
    const { cells, cellSize } = getFilledCells(W, H, imageRef.current);
    const { bg, fg } = currentMode;
    const dim = getDim(bg);

    const toSvgRect = ({ row, col, brightness }) => {
      const sq = cellSize * getSqRatio(brightness);
      const p = (cellSize - sq) / 2;
      return `<rect x="${(col * cellSize + p).toFixed(1)}" y="${(row * cellSize + p).toFixed(1)}" width="${sq.toFixed(1)}" height="${sq.toFixed(1)}"/>`;
    };
    const activeCells = cells.filter((c) => activeRatio >= 100 || activeSetRef.current.has(`${c.row},${c.col}`));
    const dimCells = cells.filter((c) => activeRatio < 100 && !activeSetRef.current.has(`${c.row},${c.col}`));

    const innerGroups = dimCells.length > 0
      ? `<g fill="${dim}">${dimCells.map(toSvgRect).join("")}</g><g fill="${fg}">${activeCells.map(toSvgRect).join("")}</g>`
      : `<g fill="${fg}">${activeCells.map(toSvgRect).join("")}</g>`;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${bg}"/><g>${innerGroups}</g></svg>`;
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "pixel-export.svg";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const sliders = [
    { label: "Grid density", value: gridSize, min: 5, max: 120, step: 1, set: setGridSize },
    { label: "Square size", value: Math.round(squareRatio * 100), min: 20, max: 100, step: 1, set: (v) => setSquareRatio(v / 100) },
    { label: "Threshold", value: threshold, min: 0, max: 255, step: 1, set: setThreshold },
  ];

  const C = BG_DARK;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: ${BG_LIGHT}; }
        .pt-root {
          min-height: 100vh;
          background: ${BG_LIGHT};
          font-family: 'DM Sans', 'Helvetica Neue', Arial, sans-serif;
          color: ${BG_DARK};
          padding: 40px 32px 48px;
        }
        .pt-wrap { max-width: 680px; margin: 0 auto; }
        .pt-header {
          display: flex; align-items: baseline; gap: 16px;
          margin-bottom: 28px; padding-bottom: 20px;
          border-bottom: 1px solid ${C};
        }
        .pt-title { font-size: 22px; font-weight: 700; letter-spacing: -0.03em; line-height: 1; }
        .pt-subtitle { font-size: 12px; color: #888; }
        .pt-dropzone {
          border: 1px solid ${C}; padding: 16px 24px; cursor: pointer;
          margin-bottom: 2px; transition: background 0.1s;
          display: flex; align-items: center; gap: 10px;
          font-size: 13px; font-weight: 500; letter-spacing: -0.01em; user-select: none;
        }
        .pt-dropzone:hover { background: #e8e8e8; }
        .pt-dropzone.dragging { background: ${C}; color: ${BG_LIGHT}; }
        .pt-paste-hint { font-size: 11px; color: #aaa; text-align: right; margin-bottom: 12px; letter-spacing: 0.02em; }
        .pt-canvas-wrap {
          border: 1px solid ${C};
          display: flex; justify-content: center; align-items: center;
          min-height: 180px; background: #ebebeb;
          margin-bottom: 24px; overflow: hidden;
        }
        .pt-empty { font-size: 12px; color: #bbb; letter-spacing: 0.05em; }
        .pt-section { border-top: 1px solid #d8d8d8; padding-top: 20px; margin-bottom: 20px; }
        .pt-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px 40px; }
        .pt-grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 20px 32px; }
        .pt-slider-label { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
        .pt-slider-name { font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
        .pt-slider-val { font-size: 11px; color: #888; font-variant-numeric: tabular-nums; }
        input[type=range] {
          -webkit-appearance: none; appearance: none;
          width: 100%; height: 1px; background: ${C}; outline: none; cursor: pointer;
        }
        input[type=range]::-webkit-slider-thumb {
          -webkit-appearance: none; width: 12px; height: 12px;
          background: ${C}; border-radius: 0; cursor: pointer;
        }
        input[type=range]::-moz-range-thumb {
          width: 12px; height: 12px; background: ${C}; border-radius: 0; border: none; cursor: pointer;
        }
        .pt-field-label { font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 8px; display: block; }
        .pt-toggle-btn { width: 100%; display: flex; border: 1px solid ${C}; overflow: hidden; }
        .pt-toggle-option {
          flex: 1; padding: 8px 0; font-size: 11px; font-weight: 700;
          letter-spacing: 0.06em; text-transform: uppercase;
          cursor: pointer; text-align: center; border: none;
          font-family: inherit; background: ${BG_LIGHT}; color: ${C};
          transition: background 0.1s, color 0.1s;
          border-left: 1px solid ${C};
        }
        .pt-toggle-option:first-child { border-left: none; }
        .pt-toggle-option.active { background: ${C}; color: ${BG_LIGHT}; }
        .pt-size-checks { display: flex; border: 1px solid ${C}; overflow: hidden; }
        .pt-size-check {
          flex: 1; padding: 8px 0; font-size: 11px; font-weight: 700;
          letter-spacing: 0.06em; text-transform: uppercase;
          cursor: pointer; text-align: center; border: none;
          font-family: inherit; background: ${BG_LIGHT}; color: ${C};
          transition: background 0.1s, color 0.1s;
          border-left: 1px solid ${C};
          display: flex; align-items: center; justify-content: center; gap: 5px;
        }
        .pt-size-check:first-child { border-left: none; }
        .pt-size-check.active { background: ${C}; color: ${BG_LIGHT}; }
        .pt-size-sq { display: inline-block; background: currentColor; flex-shrink: 0; }
        .pt-dual-track { position: relative; width: 100%; height: 2px; background: #ccc; cursor: pointer; margin-top: 8px; }
        .pt-dual-fill { position: absolute; height: 100%; background: ${C}; }
        .pt-dual-handle {
          position: absolute; top: 50%; transform: translate(-50%, -50%);
          width: 12px; height: 12px; background: ${C};
          cursor: grab; user-select: none; z-index: 2;
        }
        .pt-dual-handle:active { cursor: grabbing; }
        .pt-hint { font-size: 10px; color: #aaa; margin-top: 6px; letter-spacing: 0.03em; }
        .pt-actions { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-top: 24px; }
        .pt-btn {
          padding: 11px 0; font-size: 11px; font-weight: 700;
          letter-spacing: 0.1em; text-transform: uppercase;
          font-family: inherit; cursor: pointer; border: 1px solid ${C};
          transition: opacity 0.1s;
        }
        .pt-btn-primary { background: ${C}; color: ${BG_LIGHT}; }
        .pt-btn-primary:hover:not(:disabled) { opacity: 0.8; }
        .pt-btn-primary:disabled { opacity: 0.2; cursor: not-allowed; }
        .pt-btn-outline { background: ${BG_LIGHT}; color: ${C}; }
        .pt-btn-outline:hover { background: #e8e8e8; }
        .pt-btn-outline.active { background: ${C}; color: ${BG_LIGHT}; }
      `}</style>

      <div className="pt-root">
        <div className="pt-wrap">

          <header className="pt-header">
            <span className="pt-title">TON Tech Pixel Grid</span>
            <span className="pt-subtitle">Image to squares converter</span>
          </header>

          {/* Load zone */}
          <div
            className={`pt-dropzone${isDragging ? " dragging" : ""}`}
            onClick={() => fileInputRef.current.click()}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
          >
            <span>{imageLoaded ? "↺" : "+"}</span>
            <span>{imageLoaded ? imageName : "Drop image or click to load"}</span>
          </div>
          <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFile} style={{ display: "none" }} />
          <div className="pt-paste-hint">or paste with Ctrl+V / Cmd+V</div>

          {/* Canvas */}
          <div className="pt-canvas-wrap">
            {!imageLoaded && <span className="pt-empty">no image loaded</span>}
            <canvas ref={displayCanvasRef} style={{ display: imageLoaded ? "block" : "none", maxWidth: "100%", height: "auto" }} />
          </div>

          {/* Base sliders */}
          <div className="pt-section">
            <div className="pt-grid-3">
              {sliders.map(({ label, value, min, max, step, set }) => (
                <div key={label}>
                  <div className="pt-slider-label">
                    <span className="pt-slider-name">{label}</span>
                    <span className="pt-slider-val">{value}</span>
                  </div>
                  <input type="range" min={min} max={max} step={step} value={value}
                    onChange={(e) => set(Number(e.target.value))} />
                </div>
              ))}
            </div>
          </div>

          {/* Square sizes */}
          <div className="pt-section">
            <span className="pt-field-label">Square sizes</span>
            <div className="pt-size-checks">
              {[{ id: "large", sq: 6 }, { id: "medium", sq: 4 }, { id: "small", sq: 2 }].map(({ id, sq }) => (
                <button key={id}
                  className={`pt-size-check${activeSizes.has(id) ? " active" : ""}`}
                  onClick={() => setActiveSizes(prev => {
                    const next = new Set(prev);
                    if (next.has(id) && next.size > 1) next.delete(id); else next.add(id);
                    return next;
                  })}
                >
                  <span className="pt-size-sq" style={{ width: sq, height: sq }} />
                  {id.charAt(0).toUpperCase() + id.slice(1)}
                </button>
              ))}
            </div>
            {activeSizes.size > 1 && (
              <div style={{ marginTop: 16 }}>
                <div className="pt-slider-label">
                  <span className="pt-slider-name">Size distribution</span>
                  <span className="pt-slider-val">
                    {activeSizes.has("large") ? `L ${sizeBreaks[1]}%` : ""}
                    {activeSizes.has("medium") ? ` M ${sizeBreaks[1] - sizeBreaks[0]}%` : ""}
                    {activeSizes.has("small") ? ` S ${100 - sizeBreaks[1]}%` : ""}
                  </span>
                </div>
                <div className="pt-dual-track" ref={trackRef}
                  onMouseDown={(e) => {
                    const rect = trackRef.current.getBoundingClientRect();
                    const pct = Math.round(((e.clientX - rect.left) / rect.width) * 100);
                    const handle = Math.abs(pct - sizeBreaks[0]) < Math.abs(pct - sizeBreaks[1]) ? 0 : 1;
                    const onMove = (me) => {
                      const p = Math.min(100, Math.max(0, Math.round(((me.clientX - rect.left) / rect.width) * 100)));
                      setSizeBreaks(prev => {
                        const next = [...prev];
                        if (handle === 0) next[0] = Math.min(p, next[1] - 5);
                        else next[1] = Math.max(p, next[0] + 5);
                        return next;
                      });
                    };
                    const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
                    window.addEventListener("mousemove", onMove);
                    window.addEventListener("mouseup", onUp);
                  }}
                >
                  <div className="pt-dual-fill" style={{ left: `${sizeBreaks[0]}%`, width: `${sizeBreaks[1] - sizeBreaks[0]}%` }} />
                  {activeSizes.size >= 2 && <div className="pt-dual-handle" style={{ left: `${sizeBreaks[0]}%` }} />}
                  <div className="pt-dual-handle" style={{ left: `${sizeBreaks[1]}%` }} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                  <span className="pt-hint">Large</span>
                  <span className="pt-hint">Small</span>
                </div>
              </div>
            )}
            <div className="pt-hint" style={{ marginTop: 8 }}>
              {activeSizes.size > 1 ? "Darker areas → larger squares" : "Single size mode"}
            </div>
          </div>

          {/* Color */}
          <div className="pt-section">
            <div className="pt-grid-2">
              <div>
                <span className="pt-field-label">Color</span>
                <div className="pt-toggle-btn">
                  {COLOR_MODES.map(({ id, label }) => (
                    <button key={id}
                      className={`pt-toggle-option${colorMode === id ? " active" : ""}`}
                      onClick={() => handleColorMode(id)}
                    >{label}</button>
                  ))}
                </div>
              </div>
              <div>
                <div className="pt-slider-label">
                  <span className="pt-slider-name">Active squares</span>
                  <span className="pt-slider-val">{activeRatio}%</span>
                </div>
                <input type="range" min={0} max={100} step={1} value={activeRatio}
                  onChange={(e) => handleActiveRatio(Number(e.target.value))} />
                <div className="pt-hint" style={{ marginTop: 6 }}>
                  {activeRatio < 100 ? "Remaining squares fade to background" : "All squares active"}
                </div>
              </div>
            </div>
          </div>

          {/* Invert + Export */}
          <div className="pt-actions">
            <button
              className={`pt-btn pt-btn-outline${pixelInvert ? " active" : ""}`}
              onClick={() => { activeSetRef.current = new Set(); setPixelInvert(v => !v); }}
            >
              {pixelInvert ? "Invert: On" : "Invert: Off"}
            </button>
            <button className="pt-btn pt-btn-primary" onClick={exportPNG} disabled={!imageLoaded}>
              PNG
            </button>
            <button className="pt-btn pt-btn-primary" onClick={exportSVG} disabled={!imageLoaded}>
              SVG
            </button>
          </div>

        </div>
      </div>
    </>
  );
}
