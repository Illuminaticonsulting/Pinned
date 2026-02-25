/**
 * InputHandler.ts
 * Mouse, touch, and keyboard input handler for the Pinned chart engine.
 *
 * Attaches to the topmost canvas layer and translates raw DOM events into
 * semantic chart actions (pan, zoom, drawing placement, selection, etc.).
 *
 * Uses an EventEmitter pattern so that any part of the application can
 * subscribe to high-level input events.
 */

import type { Viewport } from './Viewport';
import type { ChartStateData, Drawing, ChartPoint } from './ChartState';

// ─── Input Modes ───────────────────────────────────────────────────────────────

/** Active input mode that determines how pointer events are interpreted. */
export type InputMode = 'NAVIGATE' | 'DRAW' | 'SELECT';

// ─── Event Payloads ────────────────────────────────────────────────────────────

export interface PanEvent {
  deltaX: number;
  deltaY: number;
}

export interface ZoomEvent {
  factor: number;
  centerX: number;
  centerY: number;
  axis: 'time' | 'price' | 'both';
}

export interface ClickEvent {
  x: number;
  y: number;
  time: number;
  price: number;
  button: number;
  shiftKey: boolean;
  ctrlKey: boolean;
}

export interface DrawingClickEvent {
  drawing: Drawing;
  x: number;
  y: number;
}

export interface DrawingDragEvent {
  drawing: Drawing;
  deltaX: number;
  deltaY: number;
  startPoint: ChartPoint;
  currentPoint: ChartPoint;
}

export interface ContextMenuEvent {
  x: number;
  y: number;
  time: number;
  price: number;
  drawing: Drawing | null;
}

export interface CursorMoveEvent {
  x: number;
  y: number;
  time: number;
  price: number;
}

/** Map of event names to their payload types. */
export interface InputEventMap {
  pan: PanEvent;
  zoom: ZoomEvent;
  click: ClickEvent;
  drawingClick: DrawingClickEvent;
  drawingDrag: DrawingDragEvent;
  contextMenu: ContextMenuEvent;
  cursorMove: CursorMoveEvent;
  drawPoint: { time: number; price: number; pointIndex: number };
  drawPreview: { time: number; price: number };
  drawCancel: void;
  drawComplete: void;
  selectDrawing: { drawing: Drawing | null };
  hoverDrawing: { drawing: Drawing | null };
  drawingMoveStart: { drawing: Drawing };
  drawingMoveEnd: void;
  drawingResizeStart: { drawing: Drawing; x: number; y: number };
  drawingResize: { time: number; price: number };
  drawingResizeEnd: void;
  deleteDrawing: { drawing: Drawing };
  undo: void;
  redo: void;
  snapToLive: void;
  modeChange: { mode: InputMode };
}

type EventCallback<T> = (payload: T) => void;

// ─── Cursor Styles ─────────────────────────────────────────────────────────────

type CursorStyle = 'default' | 'crosshair' | 'grab' | 'grabbing' | 'pointer' | 'move' | 'not-allowed' | 'ns-resize' | 'ew-resize' | 'n-resize' | 'col-resize'
  | 'nw-resize' | 'ne-resize' | 'sw-resize' | 'se-resize' | 'n-resize' | 's-resize' | 'e-resize' | 'w-resize';

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Minimum drag distance (pixels) before a mousedown → mousemove is treated as a drag. */
const DRAG_THRESHOLD = 3;

/** Momentum friction coefficient per frame (0–1, lower = more friction). */
const MOMENTUM_FRICTION = 0.94;

/** Stop momentum when velocity falls below this (px/frame). */
const MOMENTUM_MIN_VELOCITY = 0.2;

/** Long-press duration for touch (ms). */
const LONG_PRESS_MS = 500;

/** Hit-test tolerance in CSS pixels. */
const HIT_TOLERANCE = 8;

/** Right-side price axis width in CSS pixels (must match renderer). */
const RIGHT_MARGIN = 80;

/** Bottom time axis height in CSS pixels (must match renderer). */
const BOTTOM_MARGIN = 28;

/** Zoom sensitivity for smooth wheel/trackpad zoom. */
const ZOOM_SENSITIVITY = 0.0015;

/** Zoom sensitivity for trackpad pinch (Ctrl+wheel on macOS). */
const PINCH_ZOOM_SENSITIVITY = 0.008;

/** Number of recent velocity samples to average for smooth momentum. */
const VELOCITY_SAMPLES = 5;

/** Minimum time between velocity samples (ms) to avoid micro-deltas. */
const VELOCITY_SAMPLE_MIN_DT = 4;

// ─── InputHandler ──────────────────────────────────────────────────────────────

/**
 * Handles all user input on the chart canvas.
 *
 * @example
 * ```ts
 * const input = new InputHandler(topCanvas, viewport, () => chartState.getState());
 * input.on('pan', ({ deltaX, deltaY }) => viewport.pan(deltaX, deltaY));
 * input.on('zoom', ({ factor, centerX, centerY }) => viewport.zoom(factor, centerX, centerY));
 * ```
 */
export class InputHandler {
  private readonly canvas: HTMLCanvasElement;
  private readonly viewport: Viewport;
  private readonly getState: () => Readonly<ChartStateData>;

  /** Current input mode. */
  private mode: InputMode = 'NAVIGATE';

  /** Event listeners (EventEmitter). */
  private listeners: Map<string, Set<EventCallback<any>>> = new Map();

  // ── Pointer tracking ───────────────────────────────────────────────────────

  private pointerDown = false;
  private pointerStartX = 0;
  private pointerStartY = 0;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private isDragging = false;

  /** Currently selected drawing (SELECT mode). */
  private selectedDrawing: Drawing | null = null;

  /** Currently hovered drawing (for visual feedback). */
  private hoveredDrawing: Drawing | null = null;

  /** Drawing point index during DRAW mode. */
  private drawPointIndex = 0;

  /** Whether a move-drag has been started (to emit drawingMoveStart once). */
  private _moveDragStarted = false;

  /** Whether we are currently resizing a handle. */
  private _resizing = false;

  /** Callback to check if the cursor is on a resize handle (set by ChartPane). */
  private _checkResize: ((x: number, y: number) => boolean) | null = null;

  // ── Momentum ───────────────────────────────────────────────────────────────

  private velocityX = 0;
  private velocityY = 0;
  private momentumRaf = 0;

  // ── Touch state ────────────────────────────────────────────────────────────

  private touches: Map<number, { x: number; y: number }> = new Map();
  private initialPinchDistance = 0;
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Bound handlers (stored for cleanup) ────────────────────────────────────

  private boundHandlers: Record<string, EventListener> = {};

  // ── Cached layout / interaction state ───────────────────────────────────────

  /** Cached bounding rect — updated on resize/scroll, avoids layout recalc on every event. */
  private cachedRect: DOMRect | null = null;

  /** ResizeObserver for updating cached rect. */
  private resizeObserver: ResizeObserver | null = null;

  /** AbortController for scroll listener. */
  private scrollAbort: AbortController | null = null;

  /** Velocity history for averaged momentum (recent samples). */
  private velocityHistory: { vx: number; vy: number; t: number }[] = [];

  /** Which interaction zone the current drag started in. */
  private dragZone: 'chart' | 'priceAxis' | 'timeAxis' = 'chart';

  /** Timestamp of last pointer move (for velocity delta-time). */
  private lastMoveTime = 0;

  constructor(
    canvas: HTMLCanvasElement,
    viewport: Viewport,
    getState: () => Readonly<ChartStateData>,
  ) {
    this.canvas = canvas;
    this.viewport = viewport;
    this.getState = getState;
    this.attachEvents();

    // Cache bounding rect to avoid getBoundingClientRect() on every event.
    this.cachedRect = canvas.getBoundingClientRect();
    this.resizeObserver = new ResizeObserver(() => {
      this.cachedRect = this.canvas.getBoundingClientRect();
    });
    this.resizeObserver.observe(canvas);
    this.scrollAbort = new AbortController();
    window.addEventListener('scroll', () => {
      this.cachedRect = this.canvas.getBoundingClientRect();
    }, { passive: true, capture: true, signal: this.scrollAbort.signal });
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Subscribe to an input event.
   *
   * @param event    - Event name.
   * @param callback - Listener.
   * @returns Unsubscribe function.
   */
  on<K extends keyof InputEventMap>(
    event: K,
    callback: EventCallback<InputEventMap[K]>,
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
    return () => this.off(event, callback);
  }

  /**
   * Remove an event listener.
   */
  off<K extends keyof InputEventMap>(
    event: K,
    callback: EventCallback<InputEventMap[K]>,
  ): void {
    this.listeners.get(event)?.delete(callback);
  }

  /**
   * Set the active input mode.
   *
   * @param mode - New mode.
   */
  setMode(mode: InputMode): void {
    this.mode = mode;
    this.drawPointIndex = 0;
    // Only clear selection when leaving SELECT mode, not when entering it
    if (mode !== 'SELECT') {
      this.selectedDrawing = null;
    }
    this._resizing = false;
    this._moveDragStarted = false;
    this.updateCursor();
    this.emit('modeChange', { mode });
  }

  /**
   * Get the current input mode.
   */
  getMode(): InputMode {
    return this.mode;
  }

  /**
   * Programmatically set the selected drawing (used after auto-finish).
   */
  setSelectedDrawing(drawing: Drawing | null): void {
    this.selectedDrawing = drawing;
  }

  /**
   * Set a callback that checks whether screen coords (x, y) are on a resize
   * handle of the currently selected drawing. If the callback returns true, a
   * resize operation has been started in DrawingManager.
   */
  setResizeChecker(fn: (x: number, y: number) => boolean): void {
    this._checkResize = fn;
  }

  /**
   * Check if cursor is near any endpoint of the given drawing (for resize cursor).
   */
  private _isNearHandle(x: number, y: number, drawing: Drawing): boolean {
    for (const p of drawing.points) {
      const px = this.viewport.timeToX(p.time);
      const py = this.viewport.priceToY(p.price);
      if (Math.hypot(x - px, y - py) <= HIT_TOLERANCE) return true;
    }
    return false;
  }

  /**
   * Detach all event listeners and stop momentum animation.
   * Call when disposing the chart.
   */
  destroy(): void {
    this.detachEvents();
    this.stopMomentum();
    this.listeners.clear();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.scrollAbort?.abort();
    this.scrollAbort = null;
    this.cachedRect = null;
  }

  // ── Event Emission ─────────────────────────────────────────────────────────

  private emit<K extends keyof InputEventMap>(event: K, payload: InputEventMap[K]): void {
    const cbs = this.listeners.get(event);
    if (!cbs) return;
    for (const cb of cbs) {
      try {
        cb(payload);
      } catch (err) {
        console.error(`[InputHandler] Error in "${event}" listener:`, err);
      }
    }
  }

  // ── Coordinate Helpers ─────────────────────────────────────────────────────

  /** Get CSS-pixel coordinates relative to the canvas (uses cached rect). */
  private canvasCoords(e: MouseEvent | Touch): { x: number; y: number } {
    const r = this.cachedRect ?? (this.cachedRect = this.canvas.getBoundingClientRect());
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** Determine which interaction zone a point falls in. */
  private getZone(x: number, y: number): 'chart' | 'priceAxis' | 'timeAxis' {
    const { width, height } = this.viewport.getLogicalSize();
    if (x > width - RIGHT_MARGIN && y < height - BOTTOM_MARGIN) return 'priceAxis';
    if (y > height - BOTTOM_MARGIN && x < width - RIGHT_MARGIN) return 'timeAxis';
    return 'chart';
  }

  /** Convert pixel coords to chart domain (time, price). */
  private toDomain(x: number, y: number): { time: number; price: number } {
    return {
      time: this.viewport.xToTime(x),
      price: this.viewport.yToPrice(y),
    };
  }

  /** Snap cursor to nearest candle OHLC price for magnetic drawing placement (binary search). */
  private snapToOHLC(
    cursorX: number,
    domain: { time: number; price: number },
  ): { time: number; price: number } {
    const state = this.getState();
    const candles = state.candles;
    const candleW = this.viewport.getCandleWidth();
    const snapRadius = candleW * 0.6;

    if (candles.length === 0) return domain;

    // Binary search for the nearest candle by timestamp
    const cursorTime = this.viewport.xToTime(cursorX);
    let lo = 0, hi = candles.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (candles[mid]!.timestamp < cursorTime) lo = mid + 1;
      else hi = mid;
    }

    // Check a small window around the found index
    let bestCandle: any = null;
    let bestDist = Infinity;
    for (let i = Math.max(0, lo - 2); i <= Math.min(candles.length - 1, lo + 2); i++) {
      const c = candles[i]!;
      const cx = this.viewport.timeToX(c.timestamp);
      const dist = Math.abs(cx - cursorX);
      if (dist < bestDist && dist <= snapRadius) {
        bestDist = dist;
        bestCandle = c;
      }
    }

    if (state.liveCandle) {
      const cx = this.viewport.timeToX(state.liveCandle.timestamp);
      const dist = Math.abs(cx - cursorX);
      if (dist < bestDist && dist <= snapRadius) {
        bestCandle = state.liveCandle;
      }
    }

    if (!bestCandle) return domain;

    // Snap price to nearest OHLC level within 12px
    const prices: number[] = [bestCandle.open, bestCandle.high, bestCandle.low, bestCandle.close];
    let closestPrice = domain.price;
    let closestPriceDist = Infinity;

    for (const p of prices) {
      const py = this.viewport.priceToY(p);
      const cursorY = this.viewport.priceToY(domain.price);
      const d = Math.abs(py - cursorY);
      if (d < closestPriceDist && d < 12) {
        closestPriceDist = d;
        closestPrice = p;
      }
    }

    return { time: bestCandle.timestamp, price: closestPrice };
  }

  // ── Cursor ─────────────────────────────────────────────────────────────────

  private setCursor(style: CursorStyle): void {
    this.canvas.style.cursor = style;
  }

  private updateCursor(): void {
    switch (this.mode) {
      case 'NAVIGATE':
        this.setCursor(this.pointerDown ? 'grabbing' : 'crosshair');
        break;
      case 'DRAW':
        this.setCursor('crosshair');
        break;
      case 'SELECT':
        this.setCursor('default');
        break;
    }
  }

  // ── Event Attachment ───────────────────────────────────────────────────────

  private attachEvents(): void {
    const h = this.boundHandlers;

    // Mouse
    h.mousedown = this.onMouseDown.bind(this) as EventListener;
    h.mousemove = this.onMouseMove.bind(this) as EventListener;
    h.mouseup = this.onMouseUp.bind(this) as EventListener;
    h.wheel = this.onWheel.bind(this) as EventListener;
    h.dblclick = this.onDblClick.bind(this) as EventListener;
    h.contextmenu = this.onContextMenu.bind(this) as EventListener;

    this.canvas.addEventListener('mousedown', h.mousedown);
    this.canvas.addEventListener('mousemove', h.mousemove);
    this.canvas.addEventListener('mouseup', h.mouseup);
    this.canvas.addEventListener('wheel', h.wheel, { passive: false });
    this.canvas.addEventListener('dblclick', h.dblclick);
    this.canvas.addEventListener('contextmenu', h.contextmenu);

    // Global mouseup (in case pointer leaves canvas while dragging)
    h.windowMouseup = this.onMouseUp.bind(this) as EventListener;
    window.addEventListener('mouseup', h.windowMouseup);

    // Hide crosshair when cursor leaves canvas
    h.mouseleave = ((e: MouseEvent) => {
      this.emit('cursorMove', { x: -1, y: -1, time: 0, price: 0 } as any);
    }) as EventListener;
    this.canvas.addEventListener('mouseleave', h.mouseleave);

    // Touch
    h.touchstart = this.onTouchStart.bind(this) as EventListener;
    h.touchmove = this.onTouchMove.bind(this) as EventListener;
    h.touchend = this.onTouchEnd.bind(this) as EventListener;

    this.canvas.addEventListener('touchstart', h.touchstart, { passive: false });
    this.canvas.addEventListener('touchmove', h.touchmove, { passive: false });
    this.canvas.addEventListener('touchend', h.touchend);

    // Keyboard (delegated from document)
    h.keydown = this.onKeyDown.bind(this) as EventListener;
    h.keyup = this.onKeyUp.bind(this) as EventListener;
    document.addEventListener('keydown', h.keydown);
    document.addEventListener('keyup', h.keyup);
  }

  private detachEvents(): void {
    const h = this.boundHandlers;
    this.canvas.removeEventListener('mousedown', h.mousedown);
    this.canvas.removeEventListener('mousemove', h.mousemove);
    this.canvas.removeEventListener('mouseup', h.mouseup);
    this.canvas.removeEventListener('wheel', h.wheel);
    this.canvas.removeEventListener('dblclick', h.dblclick);
    this.canvas.removeEventListener('contextmenu', h.contextmenu);
    window.removeEventListener('mouseup', h.windowMouseup);
    this.canvas.removeEventListener('mouseleave', h.mouseleave);

    this.canvas.removeEventListener('touchstart', h.touchstart);
    this.canvas.removeEventListener('touchmove', h.touchmove);
    this.canvas.removeEventListener('touchend', h.touchend);

    document.removeEventListener('keydown', h.keydown);
    document.removeEventListener('keyup', h.keyup);
  }

  // ── Mouse Handlers ─────────────────────────────────────────────────────────

  private onMouseDown(e: MouseEvent): void {
    if (e.button === 2) return; // Right-click handled by contextmenu.
    const { x, y } = this.canvasCoords(e);

    this.pointerDown = true;
    this.isDragging = false;
    this.pointerStartX = x;
    this.pointerStartY = y;
    this.lastPointerX = x;
    this.lastPointerY = y;
    this.velocityX = 0;
    this.velocityY = 0;
    this.stopMomentum();

    if (this.mode === 'SELECT') {
      // 1) Check resize handle first (on the SELECTED drawing)
      if (this.selectedDrawing && this._checkResize?.(x, y)) {
        this._resizing = true;
        this.emit('drawingResizeStart', { drawing: this.selectedDrawing, x, y });
        this.setCursor('move');
        return;
      }

      // 2) Check if clicking on any drawing body
      const hit = this.hitTestDrawings(x, y);
      if (hit) {
        if (hit.id !== this.selectedDrawing?.id) {
          // Clicked a different drawing — select it instead
          this.selectedDrawing = hit;
          this.emit('selectDrawing', { drawing: hit });
        }
        this.setCursor('move');
      } else {
        // Clicked empty area → deselect and return to navigate
        this.selectedDrawing = null;
        this.emit('selectDrawing', { drawing: null });
        this.mode = 'NAVIGATE';
        this.emit('modeChange', { mode: 'NAVIGATE' });
        this.setCursor('grabbing');
      }
      return;
    }

    if (this.mode === 'NAVIGATE') {
      // Detect which zone the drag starts in
      const zone = this.getZone(x, y);
      this.dragZone = zone;

      // Only hit-test drawings in the chart area
      const hit = zone === 'chart' ? this.hitTestDrawings(x, y) : null;
      if (hit) {
        this.selectedDrawing = hit;
        this.mode = 'SELECT';
        this.emit('selectDrawing', { drawing: hit });
        this.emit('modeChange', { mode: 'SELECT' });
        this.setCursor('move');
      } else {
        this.setCursor(
          zone === 'chart' ? 'grabbing' :
          zone === 'priceAxis' ? 'ns-resize' : 'ew-resize'
        );
      }
    }
  }

  private onMouseMove(e: MouseEvent): void {
    const { x, y } = this.canvasCoords(e);
    const domain = this.toDomain(x, y);

    // Always emit cursor position.
    this.emit('cursorMove', { x, y, time: domain.time, price: domain.price });

    if (this.pointerDown) {
      const dx = x - this.lastPointerX;
      const dy = y - this.lastPointerY;

      // Check drag threshold.
      if (!this.isDragging) {
        const totalDx = x - this.pointerStartX;
        const totalDy = y - this.pointerStartY;
        if (Math.sqrt(totalDx * totalDx + totalDy * totalDy) >= DRAG_THRESHOLD) {
          this.isDragging = true;
        }
      }

      if (this.isDragging) {
        if (this.mode === 'NAVIGATE') {
          const now = performance.now();

          // Track velocity with timestamps for smooth momentum
          if (now - this.lastMoveTime >= VELOCITY_SAMPLE_MIN_DT) {
            this.velocityHistory.push({ vx: dx, vy: dy, t: now });
            if (this.velocityHistory.length > VELOCITY_SAMPLES) {
              this.velocityHistory.shift();
            }
            this.lastMoveTime = now;
          }

          if (this.dragZone === 'priceAxis') {
            // Dragging on price axis: scale price independently
            const factor = Math.exp(dy * 0.005);
            this.emit('zoom', { factor, centerX: x, centerY: this.pointerStartY, axis: 'price' });
          } else if (this.dragZone === 'timeAxis') {
            // Dragging on time axis: scale time independently
            const factor = Math.exp(-dx * 0.003);
            this.emit('zoom', { factor, centerX: this.pointerStartX, centerY: y, axis: 'time' });
          } else {
            // Normal chart drag: pan both axes
            this.velocityX = dx;
            this.velocityY = dy;
            this.emit('pan', { deltaX: dx, deltaY: dy });
          }
        } else if (this.mode === 'SELECT' && this.selectedDrawing) {
          if (this._resizing) {
            // Resize mode: emit domain coords so DrawingManager can reposition handle
            this.emit('drawingResize', { time: domain.time, price: domain.price });
          } else {
            // Move mode: emit move-start on first drag frame
            if (!this._moveDragStarted) {
              this._moveDragStarted = true;
              this.emit('drawingMoveStart', { drawing: this.selectedDrawing });
            }
            const startDomain = this.toDomain(this.pointerStartX, this.pointerStartY);
            this.emit('drawingDrag', {
              drawing: this.selectedDrawing,
              deltaX: dx,
              deltaY: dy,
              startPoint: { time: startDomain.time, price: startDomain.price },
              currentPoint: { time: domain.time, price: domain.price },
            });
          }
        }
      }

      this.lastPointerX = x;
      this.lastPointerY = y;
    } else {
      // Not dragging — hover feedback or draw preview.
      if (this.mode === 'DRAW' && this.drawPointIndex > 0) {
        // Rubber-band preview: emit cursor position so the pending drawing
        // can render a ghost line from the last placed point to the cursor.
        const snapped = this.snapToOHLC(x, domain);
        this.emit('drawPreview', { time: snapped.time, price: snapped.price });
      } else if (this.mode === 'SELECT' || this.mode === 'NAVIGATE') {
        // Hover – update cursor style and hover drawing state.
        const hit = this.hitTestDrawings(x, y);
        if (hit !== this.hoveredDrawing) {
          this.hoveredDrawing = hit;
          this.emit('hoverDrawing', { drawing: hit });
        }
        if (this.mode === 'SELECT') {
          // Check if hovering over a resize handle of the selected drawing
          if (this.selectedDrawing && this._isNearHandle(x, y, this.selectedDrawing)) {
            this.setCursor('nw-resize');
          } else if (hit) {
            this.setCursor('move');
          } else {
            this.setCursor('default');
          }
        } else if (hit) {
          this.setCursor('pointer');
        } else {
          this.setCursor(this.pointerDown ? 'grabbing' : 'crosshair');
        }
      }
    }
  }

  private onMouseUp(e: MouseEvent): void {
    if (!this.pointerDown) return;
    const { x, y } = this.canvasCoords(e);
    let domain = this.toDomain(x, y);

    this.pointerDown = false;

    if (!this.isDragging) {
      // It was a click (not a drag).
      if (this.mode === 'DRAW') {
        // Snap to nearest OHLC price for precise drawing placement
        domain = this.snapToOHLC(x, domain);
        this.emit('drawPoint', {
          time: domain.time,
          price: domain.price,
          pointIndex: this.drawPointIndex,
        });
        this.drawPointIndex++;
      } else if (this.mode === 'SELECT') {
        const hit = this.hitTestDrawings(x, y);
        if (hit) {
          this.emit('drawingClick', { drawing: hit, x, y });
        } else {
          // Click on empty area → deselect and return to navigate
          this.selectedDrawing = null;
          this.emit('selectDrawing', { drawing: null });
          this.setMode('NAVIGATE');
        }
      } else if (this.mode === 'NAVIGATE') {
        // Click on a drawing in NAVIGATE mode → select it
        const hit = this.hitTestDrawings(x, y);
        if (hit) {
          this.selectedDrawing = hit;
          this.setMode('SELECT');
          this.emit('selectDrawing', { drawing: hit });
        }
      }

      this.emit('click', {
        x,
        y,
        time: domain.time,
        price: domain.price,
        button: e.button,
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey || e.metaKey,
      });
    } else if (this.mode === 'NAVIGATE') {
      // Start momentum scrolling.
      this.startMomentum();
    } else if (this.mode === 'SELECT') {
      if (this._resizing) {
        // Finished resizing a handle — commit
        this._resizing = false;
        this.emit('drawingResizeEnd', undefined as any);
      } else if (this._moveDragStarted) {
        // Finished dragging a drawing — commit the move
        this._moveDragStarted = false;
        this.emit('drawingMoveEnd', undefined as any);
      }
    }

    this.isDragging = false;
    this.updateCursor();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const { x, y } = this.canvasCoords(e);
    const { width, height } = this.viewport.getLogicalSize();

    // Normalize deltaY/deltaX across browsers and input devices.
    // deltaMode 0 = pixels, 1 = lines (×40), 2 = pages (×800)
    let deltaY = e.deltaY;
    let deltaX = e.deltaX;
    if (e.deltaMode === 1) { deltaY *= 40; deltaX *= 40; }
    else if (e.deltaMode === 2) { deltaY *= 800; deltaX *= 800; }

    // macOS trackpad pinch-to-zoom fires as Ctrl+wheel
    const isPinch = e.ctrlKey && !e.metaKey;

    if (isPinch) {
      // ── Trackpad pinch: zoom both axes centered on cursor ──
      const factor = Math.exp(-deltaY * PINCH_ZOOM_SENSITIVITY);
      this.emit('zoom', { factor, centerX: x, centerY: y, axis: 'both' });
    } else if (e.shiftKey) {
      // ── Shift+wheel: horizontal pan (scroll through time) ──
      this.emit('pan', { deltaX: -deltaY, deltaY: 0 });
    } else if (x > width - RIGHT_MARGIN && y < height - BOTTOM_MARGIN) {
      // ── Wheel on price axis: scale price independently ──
      const factor = Math.exp(-deltaY * ZOOM_SENSITIVITY * 2);
      this.emit('zoom', { factor, centerX: x, centerY: y, axis: 'price' });
    } else if (y > height - BOTTOM_MARGIN && x < width - RIGHT_MARGIN) {
      // ── Wheel on time axis: scale time independently ──
      const factor = Math.exp(-deltaY * ZOOM_SENSITIVITY * 2);
      this.emit('zoom', { factor, centerX: x, centerY: y, axis: 'time' });
    } else {
      // ── Normal wheel on chart: smooth zoom time axis at cursor ──
      // Exponential mapping → buttery-smooth on trackpad, natural on mouse wheel
      const factor = Math.exp(-deltaY * ZOOM_SENSITIVITY);

      // If there’s significant horizontal delta (trackpad two-finger swipe), also pan
      if (Math.abs(deltaX) > 1) {
        this.emit('pan', { deltaX: -deltaX, deltaY: 0 });
      }

      this.emit('zoom', { factor, centerX: x, centerY: y, axis: 'time' });
    }
  }

  private onDblClick(e: MouseEvent): void {
    const { x } = this.canvasCoords(e);
    const { width } = this.viewport.getLogicalSize();
    // Double click near right edge → snap to live.
    if (x > width * 0.9) {
      this.emit('snapToLive', undefined as any);
    }
  }

  private onContextMenu(e: MouseEvent): void {
    e.preventDefault();

    // Right-click cancels an in-progress drawing (like TradingView).
    if (this.mode === 'DRAW' && this.drawPointIndex > 0) {
      this.drawPointIndex = 0;
      this.emit('drawCancel', undefined as any);
      this.setMode('NAVIGATE');
      return;
    }

    const { x, y } = this.canvasCoords(e);
    const domain = this.toDomain(x, y);
    const hit = this.hitTestDrawings(x, y);

    this.emit('contextMenu', {
      x,
      y,
      time: domain.time,
      price: domain.price,
      drawing: hit,
    });
  }

  // ── Touch Handlers ─────────────────────────────────────────────────────────

  private onTouchStart(e: TouchEvent): void {
    e.preventDefault();
    this.stopMomentum();

    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      const { x, y } = this.canvasCoords(t);
      this.touches.set(t.identifier, { x, y });
    }

    if (this.touches.size === 1) {
      // Single finger – potential pan or long press.
      const [first] = this.touches.values();
      this.pointerStartX = first.x;
      this.pointerStartY = first.y;
      this.lastPointerX = first.x;
      this.lastPointerY = first.y;
      this.pointerDown = true;
      this.isDragging = false;

      // Start long-press timer.
      this.longPressTimer = setTimeout(() => {
        const domain = this.toDomain(first.x, first.y);
        const hit = this.hitTestDrawings(first.x, first.y);
        this.emit('contextMenu', {
          x: first.x,
          y: first.y,
          time: domain.time,
          price: domain.price,
          drawing: hit,
        });
        this.longPressTimer = null;
      }, LONG_PRESS_MS);
    } else if (this.touches.size === 2) {
      // Two fingers – pinch to zoom.
      this.cancelLongPress();
      const pts = [...this.touches.values()];
      this.initialPinchDistance = Math.hypot(
        pts[1].x - pts[0].x,
        pts[1].y - pts[0].y,
      );
    }
  }

  private onTouchMove(e: TouchEvent): void {
    e.preventDefault();
    this.cancelLongPress();

    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      const { x, y } = this.canvasCoords(t);
      this.touches.set(t.identifier, { x, y });
    }

    if (this.touches.size === 1) {
      // Single-finger pan.
      const [pt] = this.touches.values();
      const dx = pt.x - this.lastPointerX;
      const dy = pt.y - this.lastPointerY;

      if (!this.isDragging) {
        const tdx = pt.x - this.pointerStartX;
        const tdy = pt.y - this.pointerStartY;
        if (Math.sqrt(tdx * tdx + tdy * tdy) >= DRAG_THRESHOLD) {
          this.isDragging = true;
        }
      }

      if (this.isDragging) {
        this.velocityX = dx;
        this.velocityY = dy;
        this.emit('pan', { deltaX: dx, deltaY: dy });
      }

      this.lastPointerX = pt.x;
      this.lastPointerY = pt.y;
    } else if (this.touches.size === 2) {
      // Pinch zoom.
      const pts = [...this.touches.values()];
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);

      if (this.initialPinchDistance > 0) {
        const factor = dist / this.initialPinchDistance;
        const cx = (pts[0].x + pts[1].x) / 2;
        const cy = (pts[0].y + pts[1].y) / 2;
        this.emit('zoom', { factor, centerX: cx, centerY: cy, axis: 'both' });
      }

      this.initialPinchDistance = dist;
    }
  }

  private onTouchEnd(e: TouchEvent): void {
    for (let i = 0; i < e.changedTouches.length; i++) {
      this.touches.delete(e.changedTouches[i].identifier);
    }
    this.cancelLongPress();

    if (this.touches.size === 0) {
      this.pointerDown = false;
      if (this.isDragging) {
        this.startMomentum();
      }
      this.isDragging = false;
    }
  }

  private cancelLongPress(): void {
    if (this.longPressTimer !== null) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  // ── Keyboard Handlers ──────────────────────────────────────────────────────

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      if (this.mode === 'DRAW') {
        this.drawPointIndex = 0;
        this.emit('drawCancel', undefined as any);
        this.setMode('NAVIGATE');
      } else if (this.mode === 'SELECT') {
        this.selectedDrawing = null;
        this.emit('selectDrawing', { drawing: null });
        this.setMode('NAVIGATE');
      }
    }

    // Delete / Backspace — delete the selected drawing
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.mode === 'SELECT' && this.selectedDrawing) {
      e.preventDefault();
      this.emit('deleteDrawing', { drawing: this.selectedDrawing });
      this.selectedDrawing = null;
      this.setMode('NAVIGATE');
    }

    // Ctrl+Z / Cmd+Z — undo
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      this.emit('undo', undefined as any);
    }

    // Ctrl+Shift+Z / Cmd+Shift+Z / Ctrl+Y / Cmd+Y — redo
    if (((e.ctrlKey || e.metaKey) && e.key === 'z' && e.shiftKey) ||
        ((e.ctrlKey || e.metaKey) && e.key === 'y')) {
      e.preventDefault();
      this.emit('redo', undefined as any);
    }
  }

  private onKeyUp(_e: KeyboardEvent): void {
    // Reserved for future use (e.g. modifier key releases).
  }

  // ── Momentum ───────────────────────────────────────────────────────────────

  private startMomentum(): void {
    // Only apply momentum for chart area drags, not axis drags
    if (this.dragZone !== 'chart') return;

    // Average velocity over recent samples for smoother momentum
    if (this.velocityHistory.length >= 2) {
      const recent = this.velocityHistory.slice(-VELOCITY_SAMPLES);
      let totalVx = 0, totalVy = 0;
      for (const s of recent) {
        totalVx += s.vx;
        totalVy += s.vy;
      }
      this.velocityX = totalVx / recent.length;
      this.velocityY = totalVy / recent.length;
    }
    this.velocityHistory = [];

    if (Math.abs(this.velocityX) < MOMENTUM_MIN_VELOCITY &&
        Math.abs(this.velocityY) < MOMENTUM_MIN_VELOCITY) {
      return;
    }

    let lastTime = performance.now();

    const step = (): void => {
      const now = performance.now();
      const dt = Math.min(now - lastTime, 32); // Cap at ~30fps minimum
      const frameFactor = dt / 16.67; // Normalize to 60fps baseline
      lastTime = now;

      // Frame-rate-independent friction (consistent feel at any refresh rate)
      const friction = Math.pow(MOMENTUM_FRICTION, frameFactor);
      this.velocityX *= friction;
      this.velocityY *= friction;

      if (Math.abs(this.velocityX) < MOMENTUM_MIN_VELOCITY &&
          Math.abs(this.velocityY) < MOMENTUM_MIN_VELOCITY) {
        this.stopMomentum();
        return;
      }

      this.emit('pan', {
        deltaX: this.velocityX * frameFactor,
        deltaY: this.velocityY * frameFactor,
      });
      this.momentumRaf = requestAnimationFrame(step);
    };

    this.momentumRaf = requestAnimationFrame(step);
  }

  private stopMomentum(): void {
    if (this.momentumRaf) {
      cancelAnimationFrame(this.momentumRaf);
      this.momentumRaf = 0;
    }
    this.velocityX = 0;
    this.velocityY = 0;
  }

  // ── Hit Testing ────────────────────────────────────────────────────────────

  /**
   * Test if a point (in CSS pixels) is near any active drawing.
   * Returns the closest drawing within {@link HIT_TOLERANCE}, or `null`.
   */
  private hitTestDrawings(x: number, y: number): Drawing | null {
    const state = this.getState();
    const drawings = state.activeDrawings;
    if (!drawings || drawings.length === 0) return null;

    let closest: Drawing | null = null;
    let closestDist = HIT_TOLERANCE;

    for (const d of drawings) {
      if (!d.visible) continue;
      const dist = this.distanceToDrawing(d, x, y);
      if (dist < closestDist) {
        closestDist = dist;
        closest = d;
      }
    }

    return closest;
  }

  /**
   * Compute the minimum pixel distance from point (px, py) to a drawing.
   */
  private distanceToDrawing(drawing: Drawing, px: number, py: number): number {
    const pts = drawing.points.map((p) => ({
      x: this.viewport.timeToX(p.time),
      y: this.viewport.priceToY(p.price),
    }));

    switch (drawing.type) {
      case 'horizontal_line': {
        if (pts.length === 0) return Infinity;
        return Math.abs(py - pts[0].y);
      }
      case 'vertical_line': {
        if (pts.length === 0) return Infinity;
        return Math.abs(px - pts[0].x);
      }
      case 'trendline': {
        if (pts.length < 2) return Infinity;
        return this.pointToSegmentDist(px, py, pts[0].x, pts[0].y, pts[1].x, pts[1].y);
      }
      case 'ray': {
        // Ray extends from p0 through p1 infinitely — use unclamped t≥0
        if (pts.length < 2) return Infinity;
        return this.pointToRayDist(px, py, pts[0].x, pts[0].y, pts[1].x, pts[1].y, false, true);
      }
      case 'extended_line': {
        // Infinite line through p0 and p1 — use fully unclamped t
        if (pts.length < 2) return Infinity;
        return this.pointToRayDist(px, py, pts[0].x, pts[0].y, pts[1].x, pts[1].y, true, true);
      }
      case 'parallel_channel': {
        if (pts.length < 2) return Infinity;
        return this.pointToSegmentDist(px, py, pts[0].x, pts[0].y, pts[1].x, pts[1].y);
      }
      case 'rectangle':
      case 'price_range':
      case 'date_range':
      case 'measure': {
        if (pts.length < 2) return Infinity;
        return this.pointToRectDist(px, py, pts[0].x, pts[0].y, pts[1].x, pts[1].y);
      }
      case 'fibonacci_retracement':
      case 'fibonacci_extension': {
        if (pts.length < 2) return Infinity;
        // Simplified: treat as rectangle region.
        return this.pointToRectDist(px, py, pts[0].x, pts[0].y, pts[1].x, pts[1].y);
      }
      case 'ellipse': {
        if (pts.length < 2) return Infinity;
        const cx = (pts[0].x + pts[1].x) / 2;
        const cy = (pts[0].y + pts[1].y) / 2;
        const rx = Math.abs(pts[1].x - pts[0].x) / 2;
        const ry = Math.abs(pts[1].y - pts[0].y) / 2;
        if (rx === 0 || ry === 0) return Infinity;
        const norm = Math.sqrt(((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2);
        return Math.abs(norm - 1) * Math.min(rx, ry);
      }
      case 'text': {
        if (pts.length === 0) return Infinity;
        return Math.sqrt((px - pts[0].x) ** 2 + (py - pts[0].y) ** 2);
      }
      default:
        return Infinity;
    }
  }

  /** Point-to-line-segment distance. */
  private pointToSegmentDist(
    px: number, py: number,
    x1: number, y1: number,
    x2: number, y2: number,
  ): number {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);

    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));

    const projX = x1 + t * dx;
    const projY = y1 + t * dy;
    return Math.sqrt((px - projX) ** 2 + (py - projY) ** 2);
  }

  /** Point-to-ray / infinite line distance. */
  private pointToRayDist(
    px: number, py: number,
    x1: number, y1: number,
    x2: number, y2: number,
    extendLeft: boolean,
    extendRight: boolean,
  ): number {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);

    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    // Clamp based on extension mode
    if (!extendLeft) t = Math.max(0, t);
    if (!extendRight) t = Math.min(1, t);

    const projX = x1 + t * dx;
    const projY = y1 + t * dy;
    return Math.sqrt((px - projX) ** 2 + (py - projY) ** 2);
  }

  /** Minimum distance from a point to the perimeter of an axis-aligned rectangle. */
  private pointToRectDist(
    px: number, py: number,
    x1: number, y1: number,
    x2: number, y2: number,
  ): number {
    const left = Math.min(x1, x2);
    const right = Math.max(x1, x2);
    const top = Math.min(y1, y2);
    const bottom = Math.max(y1, y2);

    // If inside, return distance to nearest edge.
    if (px >= left && px <= right && py >= top && py <= bottom) {
      return Math.min(px - left, right - px, py - top, bottom - py);
    }

    // Closest point on perimeter.
    const cx = Math.max(left, Math.min(px, right));
    const cy = Math.max(top, Math.min(py, bottom));
    return Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
  }
}
