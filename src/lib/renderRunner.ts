/**
 * Render-node preview runner, shared by the canvas `RenderNode` (auto-render)
 * and `RenderNodeViewer` (panel / detached window).
 *
 * - One render in flight per node: a request that arrives while one is running
 *   is coalesced into a single follow-up run (so typing/dragging never queues
 *   a pile of compiles).
 * - The finished state is broadcast to every window, so a detached viewer shows
 *   the canvas's result (and vice versa) without compiling again. The backend
 *   also caches by input fingerprint, so a repeat request with unchanged inputs
 *   returns immediately.
 */
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { renderTypstPreview } from "./tauri-commands";
import { useRenderStore, type RenderState } from "../store/renderStore";

const RENDER_UPDATED = "render-updated";

interface RenderUpdatedPayload {
  nodeId: string;
  state: Partial<RenderState>;
  source: string;
}

const inflight = new Map<string, Promise<void>>();
const rerun = new Set<string>();

function windowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return "main";
  }
}

async function renderOnce(nodeId: string): Promise<void> {
  const { update } = useRenderStore.getState();
  // Keep the previous pages visible while re-rendering.
  update(nodeId, { status: "rendering", error: null });
  let next: Partial<RenderState>;
  try {
    const res = await renderTypstPreview(nodeId);
    next = {
      status: "ok",
      pages: res.pages,
      pageCount: res.page_count,
      svgPages: res.svg_pages,
      error: null,
      renderedAt: Date.now(),
      revision: res.revision,
    };
  } catch (e) {
    next = { status: "error", error: String(e), pages: [], pageCount: 0, svgPages: [], revision: "" };
  }
  update(nodeId, next);
  void emit(RENDER_UPDATED, { nodeId, state: next, source: windowLabel() } satisfies RenderUpdatedPayload);
}

/** Render (or re-render) a render node's preview. Resolves when it is up to date. */
export function requestRender(nodeId: string): Promise<void> {
  const running = inflight.get(nodeId);
  if (running) {
    rerun.add(nodeId);
    return running;
  }
  const p = (async () => {
    do {
      rerun.delete(nodeId);
      await renderOnce(nodeId);
    } while (rerun.has(nodeId));
  })().finally(() => inflight.delete(nodeId));
  inflight.set(nodeId, p);
  return p;
}

// Adopt results rendered in other windows (registered once per window).
void listen<RenderUpdatedPayload>(RENDER_UPDATED, (event) => {
  const { nodeId, state, source } = event.payload;
  if (source === windowLabel()) return;
  // A local render in flight will publish its own (newer) result.
  if (inflight.has(nodeId)) return;
  useRenderStore.getState().update(nodeId, state);
}).catch(() => {
  /* not running inside Tauri */
});
