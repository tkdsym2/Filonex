import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import RefreshIcon from "@mui/icons-material/Refresh";
import PreviewIcon from "@mui/icons-material/Preview";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import ZoomInIcon from "@mui/icons-material/ZoomIn";
import ZoomOutIcon from "@mui/icons-material/ZoomOut";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { NodeData } from "../../types";
import { useRenderStore, EMPTY_RENDER_STATE } from "../../store/renderStore";
import { requestRender } from "../../lib/renderRunner";
import { useT } from "../../lib/i18n";

const ACCENT = "#9333ea";

/** Zoom is relative to "fit width" (1 = page as wide as the panel, max 600px).
 *  Pages are shown as vector SVGs, so even the maximum stays sharp. */
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 20;
const ZOOM_STEP = 1.25;
const FIT_MAX_WIDTH = 600;
const PAGES_PADDING = 14;

const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

interface RenderNodeViewerProps {
  node: NodeData;
}

export function RenderNodeViewer({ node }: RenderNodeViewerProps) {
  const t = useT();
  const render = useRenderStore((s) => s.byNode[node.id]) ?? EMPTY_RENDER_STATE;
  const hasPages = render.status !== "error" && render.pages.length > 0;

  const doRender = useCallback(() => void requestRender(node.id), [node.id]);

  // Bring the preview up to date whenever this node is opened (returns at once
  // when the canvas already rendered the same inputs).
  useEffect(() => {
    void requestRender(node.id);
  }, [node.id]);

  // ─── Zoom ───
  const [zoom, setZoom] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [fitWidth, setFitWidth] = useState(FIT_MAX_WIDTH);
  /** Point (in viewport coords of the scroller) to keep fixed across a zoom change. */
  const anchorRef = useRef<{ x: number; y: number; prevZoom: number } | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const hoveredRef = useRef(false);

  const zoomTo = useCallback((next: number, anchor?: { x: number; y: number }) => {
    const prev = zoomRef.current;
    const z = clampZoom(next);
    if (z === prev) return;
    const el = scrollRef.current;
    anchorRef.current = {
      x: anchor?.x ?? (el ? el.clientWidth / 2 : 0),
      y: anchor?.y ?? (el ? el.clientHeight / 2 : 0),
      prevZoom: prev,
    };
    setZoom(z);
  }, []);

  // Keep the point under the cursor (or the view center) in place.
  useLayoutEffect(() => {
    const a = anchorRef.current;
    const el = scrollRef.current;
    anchorRef.current = null;
    if (!a || !el) return;
    const ratio = zoom / a.prevZoom;
    el.scrollLeft = (el.scrollLeft + a.x - PAGES_PADDING) * ratio + PAGES_PADDING - a.x;
    el.scrollTop = (el.scrollTop + a.y - PAGES_PADDING) * ratio + PAGES_PADDING - a.y;
  }, [zoom]);

  // "Fit width" follows the panel / window size.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () =>
      setFitWidth(Math.max(120, Math.min(FIT_MAX_WIDTH, el.clientWidth - PAGES_PADDING * 2)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasPages]);

  // Cmd/Ctrl + wheel (Chromium also reports trackpad pinch this way) and
  // WebKit's pinch gesture events. Non-passive so the page itself never zooms.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const local = (e: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomTo(zoomRef.current * Math.exp(-e.deltaY * 0.01), local(e));
    };
    let gestureStartZoom = 1;
    type GestureLike = Event & { scale: number; clientX: number; clientY: number };
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gestureStartZoom = zoomRef.current;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as GestureLike;
      zoomTo(gestureStartZoom * g.scale, local(g));
    };
    const onGestureEnd = (e: Event) => e.preventDefault();
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    el.addEventListener("gestureend", onGestureEnd);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      el.removeEventListener("gestureend", onGestureEnd);
    };
  }, [zoomTo, hasPages]);

  // Cmd/Ctrl + "+" / "-" / "0" while the pointer is over the preview.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || !hoveredRef.current) return;
      if (e.key === "=" || e.key === "+" || e.key === ";") {
        e.preventDefault();
        zoomTo(zoomRef.current * ZOOM_STEP);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomTo(zoomRef.current / ZOOM_STEP);
      } else if (e.key === "0") {
        e.preventDefault();
        zoomTo(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomTo]);

  const isRendering = render.status === "rendering";
  const cacheBust = render.revision || render.renderedAt || 0;

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <PreviewIcon sx={{ fontSize: 18, color: ACCENT }} />
        <span style={{ fontWeight: 600, fontFamily: "monospace", flex: 1 }}>
          {node.display_id ?? node.title}
        </span>
      </div>

      <div style={toolbarStyle}>
        <button onClick={doRender} disabled={isRendering} style={renderButtonStyle}>
          <RefreshIcon sx={{ fontSize: 16, ...(isRendering ? spinSx : {}) }} />
          {isRendering
            ? t({ en: "Rendering…", ja: "レンダー中…" })
            : t({ en: "Re-render preview", ja: "プレビュー再生成" })}
        </button>
        <span style={infoTextStyle}>
          {render.pageCount > 0
            ? t(
                { en: "{n} page(s)", ja: "{n} ページ" },
                { n: render.pageCount },
              )
            : ""}
        </span>
        {hasPages && (
          <div style={zoomGroupStyle}>
            <button
              onClick={() => zoomTo(zoomRef.current / ZOOM_STEP)}
              disabled={zoom <= MIN_ZOOM}
              style={zoomButtonStyle}
              title={t({ en: "Zoom out (⌘−)", ja: "縮小 (⌘−)" })}
            >
              <ZoomOutIcon sx={{ fontSize: 16 }} />
            </button>
            <button
              onClick={() => zoomTo(1)}
              style={{ ...zoomButtonStyle, minWidth: 48, fontSize: 12 }}
              title={t({ en: "Fit width (⌘0)", ja: "幅に合わせる (⌘0)" })}
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              onClick={() => zoomTo(zoomRef.current * ZOOM_STEP)}
              disabled={zoom >= MAX_ZOOM}
              style={zoomButtonStyle}
              title={t({ en: "Zoom in (⌘+)", ja: "拡大 (⌘+)" })}
            >
              <ZoomInIcon sx={{ fontSize: 16 }} />
            </button>
          </div>
        )}
      </div>

      {render.status === "error" ? (
        <div style={errorBoxStyle}>
          <div style={errorHeaderStyle}>
            <ErrorOutlineIcon sx={{ fontSize: 16 }} />
            {t({ en: "Typst compile error", ja: "Typst コンパイルエラー" })}
          </div>
          <pre style={errorTextStyle}>{render.error}</pre>
        </div>
      ) : hasPages ? (
        <div
          ref={scrollRef}
          style={pagesWrapStyle}
          onMouseEnter={() => (hoveredRef.current = true)}
          onMouseLeave={() => (hoveredRef.current = false)}
        >
          <div style={pagesColumnStyle}>
            {render.pages.map((p, i) => (
              <img
                key={p}
                src={`${convertFileSrc(render.svgPages[i] ?? p)}?v=${cacheBust}`}
                alt={`page ${i + 1}`}
                draggable={false}
                style={{ ...pageImageStyle, width: Math.round(fitWidth * zoom) }}
              />
            ))}
          </div>
        </div>
      ) : (
        <div style={emptyStyle}>
          {isRendering
            ? t({ en: "Rendering preview…", ja: "プレビューを生成中…" })
            : t({
                en: "No connected Note nodes. Connect Note (Typst) nodes to this render node to preview them.",
                ja: "接続されたノートがありません。ノート(Typst)をこのレンダーノードに接続するとプレビューできます。",
              })}
        </div>
      )}
    </div>
  );
}

const containerStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  overflow: "hidden",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "12px 14px 8px",
};

const toolbarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "0 14px 10px",
  borderBottom: "1px solid #eee",
};

const renderButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  background: ACCENT,
  color: "#fff",
  border: "none",
  borderRadius: 6,
  padding: "6px 12px",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const infoTextStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#6b7280",
};

const pagesWrapStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "auto",
  padding: PAGES_PADDING,
  background: "#f3f4f6",
};

/** Centers the pages while narrower than the viewport, but stays scrollable
 *  to the left edge once zoomed wider (unlike align-items: center). */
const pagesColumnStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 14,
  width: "fit-content",
  minWidth: "100%",
};

const pageImageStyle: React.CSSProperties = {
  display: "block",
  flexShrink: 0,
  // Tailwind preflight sets `img { max-width: 100% }`, which would cap the
  // zoomed page at the viewport width.
  maxWidth: "none",
  boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
  background: "#fff",
};

const zoomGroupStyle: React.CSSProperties = {
  marginLeft: "auto",
  display: "inline-flex",
  alignItems: "center",
  border: "1px solid #e5e7eb",
  borderRadius: 6,
  overflow: "hidden",
};

const zoomButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  height: 28,
  minWidth: 30,
  padding: "0 6px",
  border: "none",
  background: "#fff",
  color: "#374151",
  cursor: "pointer",
  fontVariantNumeric: "tabular-nums",
};

const errorBoxStyle: React.CSSProperties = {
  margin: 14,
  border: "1px solid #fecaca",
  borderRadius: 8,
  background: "#fef2f2",
  overflow: "hidden",
};

const errorHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 12px",
  background: "#fee2e2",
  color: "#b91c1c",
  fontWeight: 600,
  fontSize: 13,
};

const errorTextStyle: React.CSSProperties = {
  margin: 0,
  padding: "10px 12px",
  fontSize: 12,
  fontFamily: "monospace",
  color: "#7f1d1d",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  maxHeight: 280,
  overflowY: "auto",
};

const emptyStyle: React.CSSProperties = {
  flex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  textAlign: "center",
  padding: 24,
  color: "#6b7280",
  fontSize: 13,
  lineHeight: 1.5,
};

const spinSx = {
  animation: "spin 1s linear infinite",
  "@keyframes spin": { from: { transform: "rotate(0deg)" }, to: { transform: "rotate(360deg)" } },
} as const;
