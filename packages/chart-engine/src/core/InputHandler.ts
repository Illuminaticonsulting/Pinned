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
  drawCancel: void;
  drawComplete: void;
  selectDrawing: { drawing: Drawing | null };
  snapToLive: void;
  modeChange: { mode: InputMode };
}

type EventCallback<T> = (payload: T) => void;

// ─── Cursor Styles ─────────────────────────────────────────────────────────────

type CursorStyle = 'default' | 'crosshair' | 'grab' | 'grabbing' | 'pointer' | 'move' | 'not-allowed';

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Minimum drag distance (pixels) before a mousedown → mousemove is treated as a drag. */
const DRAG_THRESHOLD = 3;

/** Momentum friction coefficient per frame (0–1, lower = more friction). */
const MOMENTUM_FRICTION = 0.92;

/** Stop momentum when velocity falls below this (px/frame). */
const MOMENTUM_MIN_VELOCITY = 0.5;

/** Long-press duration for touch (ms). */
const LONG_PRESS_MS = 500;

/** Hit-test tolerance in CSS pixels. */
const HIT_TOLERANCE = 8;

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

  /** Drawing point index during DRAW mode. */
  private drawPointIndex = 0;

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

  constructor(
    canvas: HTMLCanvasElement,
    viewport: Viewport,
    getState: () => Readonly<ChartStateData>,
  ) {
    this.canvas = canvas;
    this.viewport = viewport;
    this.getState = getState;
    this.attachEvents();
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
    this.selectedDrawing = null;
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
   * Detach all event listeners and stop momentum animation.
   * Call when disposing the chart.
   */
  destroy(): void {
    this.detachEvents();
    this.stopMomentum();
    this.listeners.clear();
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

  /** Get CSS-pixel coordinates relative to the canvas. */
  private canvasCoords(e: MouseEvent | Touch): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  /** Convert pixel coords to chart domain (time, price). */
  private toDomain(x: number, y: number): { time: number; price: number } {
    return {
      time: this.viewport.xToTime(x),
      price: this.viewport.yToPrice(y),
    };
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
      const hit = this.hitTestDrawings(x, y);
      if (hit) {
        this.selectedDrawing = hit;
        this.emit('selectDrawing', { drawing: hit });
        this.setCursor('move');
      } else {
        this.selectedDrawing = null;
        this.emit('selectDrawing', { drawing: null });
      }
    }

    if (this.mode === 'NAVIGATE') {
      this.setCursor('grabbing');
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
          this.velocityX = dx;
          this.velocityY = dy;
          this.emit('pan', { deltaX: dx, deltaY: dy });
        } else if (this.mode === 'SELECT' && this.selectedDrawing) {
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

      this.lastPointerX = x;
      this.lastPointerY = y;
    } else {
      // Hover – update cursor style.
      if (this.mode === 'SELECT') {
        const hit = this.hitTestDrawings(x, y);
        this.setCursor(hit ? 'pointer' : 'default');
      }
    }
  }

  private onMouseUp(e: MouseEvent): void {
    if (!this.pointerDown) return;
    const { x, y } = this.canvasCoords(e);
    const domain = this.toDomain(x, y);

    this.pointerDown = false;

    if (!this.isDragging) {
      // It was a click.
      if (this.mode === 'DRAW') {
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
    }

    this.isDragging = false;
    this.updateCursor();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const { x, y } = this.canvasCoords(e);

    // Normalise delta across browsers.
    const delta = e.deltaY > 0 ? 0.9 : 1.1;

    if (e.ctrlKey || e.metaKey) {
      // Ctrl+Wheel: zoom price axis.
      this.emit('zoom', { factor: delta, centerX: x, centerY: y, axis: 'price' });
    } else {
      // Normal wheel: zoom time axis.
      this.emit('zoom', { factor: delta, centerX: x, centerY: y, axis: 'time' });
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

    // Ctrl+Z / Ctrl+Shift+Z handled at a higher level (CommandStack).
  }

  private onKeyUp(_e: KeyboardEvent): void {
    // Reserved for future use (e.g. modifier key releases).
  }

  // ── Momentum ───────────────────────────────────────────────────────────────

  private startMomentum(): void {
    if (Math.abs(this.velocityX) < MOMENTUM_MIN_VELOCITY &&
        Math.abs(this.velocityY) < MOMENTUM_MIN_VELOCITY) {
      return;
    }

    const step = (): void => {
      this.velocityX *= MOMENTUM_FRICTION;
      this.velocityY *= MOMENTUM_FRICTION;

      if (Math.abs(this.velocityX) < MOMENTUM_MIN_VELOCITY &&
          Math.abs(this.velocityY) < MOMENTUM_MIN_VELOCITY) {
        this.stopMomentum();
        return;
      }

      this.emit('pan', { deltaX: this.velocityX, deltaY: this.velocityY });
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
      case 'trendline':
      case 'ray':
      case 'extended_line':
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
