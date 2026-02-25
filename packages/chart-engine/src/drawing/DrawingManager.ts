/**
 * DrawingManager.ts
 * Central manager for all drawing-tool operations on the Pinned chart engine.
 *
 * Lifecycle: tool selection → point placement → finish → selection / move /
 * resize → delete / clone, with full undo/redo integration via CommandStack
 * and persistence to localStorage & REST API.
 */

import type {
  Drawing,
  DrawingType,
  DrawingProperties,
  ChartPoint,
} from '../core/ChartState';
import { ChartState } from '../core/ChartState';
import {
  CommandStack,
  AddDrawingCommand,
  RemoveDrawingCommand,
  MoveDrawingCommand,
} from '../core/CommandStack';
import type { Viewport } from '../core/Viewport';
import {
  findNearestDrawing,
  getHandleAtPoint,
  type HandleInfo,
} from './HitTest';
import {
  saveLocal,
  loadLocal,
  saveToServer as persistSaveToServer,
  loadFromServer as persistLoadFromServer,
} from './DrawingPersistence';
import { getToolById } from './DrawingTools';

// ─── Tool Type Alias ───────────────────────────────────────────────────────────

/**
 * Convenience union of the drawing tool names the toolbar exposes.
 * `null` means no tool is active (pointer / selection mode).
 */
export type ActiveTool = string | null;

/** Map toolbar tool names → internal DrawingType. */
const TOOL_TO_DRAWING_TYPE: Record<string, DrawingType> = {
  hline: 'horizontal_line',
  vline: 'vertical_line',
  trendline: 'trendline',
  ray: 'ray',
  extended_line: 'extended_line',
  parallel_channel: 'parallel_channel',
  fibonacci: 'fibonacci_retracement',
  fib_extension: 'fibonacci_extension',
  rectangle: 'rectangle',
  ellipse: 'ellipse',
  text: 'text',
  price_range: 'price_range',
  date_range: 'date_range',
  measure: 'measure',
  anchored_vwap: 'anchored_vwap',
};

/** Number of click-points required per tool before auto-finishing. */
const REQUIRED_POINTS: Record<string, number> = {
  hline: 1,
  vline: 1,
  trendline: 2,
  ray: 2,
  extended_line: 2,
  parallel_channel: 3,
  fibonacci: 2,
  fib_extension: 2,
  rectangle: 2,
  ellipse: 2,
  text: 1,
  price_range: 2,
  date_range: 2,
  measure: 2,
  anchored_vwap: 1,
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Generate a unique 12-char hex ID. */
function uid(): string {
  const a = Math.random().toString(16).slice(2, 8);
  const b = Date.now().toString(16).slice(-6);
  return `${a}${b}`;
}

/** Default visual properties for a new drawing, sourced from DrawingTools.ts definitions. */
function defaultProps(tool: ActiveTool): DrawingProperties {
  const base: DrawingProperties = {
    color: '#2196F3',
    lineWidth: 1,
    lineStyle: 'solid',
    showLabels: true,
  };
  if (!tool) return base;
  const def = getToolById(tool);
  if (def) return { ...base, ...def.defaultProperties };
  return base;
}

// ─── Context-Menu Items ────────────────────────────────────────────────────────

export interface ContextMenuItem {
  label: string;
  action: string;
}

// ─── Move / Resize State ───────────────────────────────────────────────────────

interface MoveState {
  drawingId: string;
  originalPoints: ChartPoint[];
}

interface ResizeState {
  drawingId: string;
  handle: HandleInfo;
  originalPoints: ChartPoint[];
}

// ─── DrawingManager ────────────────────────────────────────────────────────────

export class DrawingManager {
  /** Currently selected toolbar tool. */
  private activeTool: ActiveTool = null;

  /** In-progress drawing (not yet committed). */
  private pendingDrawing: Drawing | null = null;

  /** Currently selected (committed) drawing id. */
  private selectedDrawingId: string | null = null;

  /** State for an in-progress move operation. */
  private moveState: MoveState | null = null;

  /** State for an in-progress resize operation. */
  private resizeState: ResizeState | null = null;

  constructor(
    private readonly state: ChartState,
    private readonly commandStack: CommandStack,
  ) {}

  // ── Tool Selection ─────────────────────────────────────────────────────────

  getActiveTool(): ActiveTool {
    return this.activeTool;
  }

  setActiveTool(tool: ActiveTool): void {
    this.activeTool = tool;
    this.pendingDrawing = null;
    this.state.setState({ selectedDrawingTool: tool });
  }

  // ── Drawing Lifecycle ──────────────────────────────────────────────────────

  /**
   * Begin creating a new drawing with the currently active tool.
   * Call {@link addPoint} next to set anchor positions, then {@link finishDrawing}.
   */
  startDrawing(tool: ActiveTool): void {
    if (!tool) return;
    this.activeTool = tool;
    this.state.setState({ selectedDrawingTool: tool });

    const now = Date.now();
    this.pendingDrawing = {
      id: uid(),
      type: TOOL_TO_DRAWING_TYPE[tool] ?? 'trendline',
      points: [],
      properties: defaultProps(tool),
      selected: false,
      locked: false,
      visible: true,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Append a chart-space anchor point to the in-progress drawing.
   * Automatically finishes the drawing when the required number of points is reached.
   */
  addPoint(time: number, price: number): void {
    if (!this.pendingDrawing || !this.activeTool) return;

    const newPoints: ChartPoint[] = [...this.pendingDrawing.points, { time, price }];
    this.pendingDrawing = { ...this.pendingDrawing, points: newPoints, updatedAt: Date.now() };

    const required = REQUIRED_POINTS[this.activeTool] ?? 2;
    if (newPoints.length >= required) {
      this.finishDrawing();
    }
  }

  /**
   * Finalise the in-progress drawing and commit it to state via CommandStack.
   * After committing, auto-selects the finished drawing so it's immediately
   * ready for move/resize without an extra click.
   */
  finishDrawing(): Drawing | null {
    if (!this.pendingDrawing) return null;
    if (this.pendingDrawing.points.length === 0) {
      this.pendingDrawing = null;
      return null;
    }

    const drawing: Drawing = { ...this.pendingDrawing, updatedAt: Date.now() };
    this.commandStack.push(new AddDrawingCommand(drawing, this.state));

    const finished = drawing;
    this.pendingDrawing = null;
    this.activeTool = null;
    this.state.setState({ selectedDrawingTool: null });

    // Auto-select the newly created drawing so user can immediately move/resize it
    this.selectDrawing(finished.id);

    // Notify that drawing is complete — pass the finished drawing so ChartPane
    // can switch InputHandler to SELECT mode with the drawing pre-selected
    this._onDrawingComplete?.(finished);
    return finished;
  }

  /** Callback invoked when a drawing is auto-finished. Set by ChartPane. */
  _onDrawingComplete: ((drawing: Drawing) => void) | null = null;

  /** Access the in-progress (preview) drawing, if any. */
  getPendingDrawing(): Drawing | null {
    return this.pendingDrawing;
  }

  /**
   * Update the preview cursor point for rubber-band rendering.
   * Temporarily adds/replaces the "next" point so the preview line follows the cursor.
   */
  updatePreviewPoint(time: number, price: number): void {
    if (!this.pendingDrawing || !this.activeTool) return;
    const required = REQUIRED_POINTS[this.activeTool] ?? 2;
    const pts = [...this.pendingDrawing.points];
    // Only rubber-band if we have at least 1 point but haven't finished yet
    if (pts.length === 0 || pts.length >= required) return;
    // If we already have the ghost point appended, replace it; otherwise append
    if (pts.length > this.pendingDrawing.points.length) {
      pts[pts.length - 1] = { time, price };
    } else {
      pts.push({ time, price });
    }
    // Store as _previewPoints (separate from committed points) so addPoint doesn't double-count
    this.pendingDrawing = { ...this.pendingDrawing, _previewPoints: pts } as any;
  }

  /**
   * Get the pending drawing with preview (rubber-band) points for rendering.
   */
  getPendingDrawingForRender(): Drawing | null {
    if (!this.pendingDrawing) return null;
    const preview = (this.pendingDrawing as any)._previewPoints;
    if (preview) {
      return { ...this.pendingDrawing, points: preview };
    }
    return this.pendingDrawing;
  }

  // ── Hit Testing ────────────────────────────────────────────────────────────

  /**
   * Find a drawing at the given screen-pixel position (within 5 px).
   */
  findDrawingAt(x: number, y: number, viewport: Viewport): Drawing | null {
    const drawings = this.state.get('activeDrawings');
    return findNearestDrawing(x, y, drawings, viewport, 5);
  }

  // ── Selection ──────────────────────────────────────────────────────────────

  selectDrawing(id: string): void {
    this.selectedDrawingId = id;
    const drawings = this.state.get('activeDrawings');
    this.state.setState({
      activeDrawings: drawings.map((d) => ({
        ...d,
        selected: d.id === id,
      })),
    });
  }

  deselectAll(): void {
    this.selectedDrawingId = null;
    const drawings = this.state.get('activeDrawings');
    this.state.setState({
      activeDrawings: drawings.map((d) =>
        d.selected ? { ...d, selected: false } : d,
      ),
    });
  }

  getSelectedDrawingId(): string | null {
    return this.selectedDrawingId;
  }

  // ── Move ───────────────────────────────────────────────────────────────────

  startMoveDrawing(id: string): void {
    const drawing = this.state.get('activeDrawings').find((d) => d.id === id);
    if (!drawing || drawing.locked) return;

    this.moveState = {
      drawingId: id,
      originalPoints: [...drawing.points],
    };
  }

  updateMoveDrawing(deltaTime: number, deltaPrice: number): void {
    if (!this.moveState) return;

    const drawings = this.state.get('activeDrawings');
    this.state.setState({
      activeDrawings: drawings.map((d) => {
        if (d.id !== this.moveState!.drawingId) return d;
        return {
          ...d,
          points: this.moveState!.originalPoints.map((p) => ({
            time: p.time + deltaTime,
            price: p.price + deltaPrice,
          })),
          updatedAt: Date.now(),
        };
      }),
    });
  }

  finishMoveDrawing(): void {
    if (!this.moveState) return;

    const drawing = this.state.get('activeDrawings').find(
      (d) => d.id === this.moveState!.drawingId,
    );
    if (drawing) {
      // Replace the un-tracked setState above with a proper undo-able command.
      // First, revert to original points silently…
      const currentPoints = [...drawing.points];
      this.state.setState({
        activeDrawings: this.state.get('activeDrawings').map((d) =>
          d.id === this.moveState!.drawingId
            ? { ...d, points: this.moveState!.originalPoints }
            : d,
        ),
      });
      // …then push the move command which re-applies the new points.
      this.commandStack.push(
        new MoveDrawingCommand(
          this.moveState.drawingId,
          this.moveState.originalPoints,
          currentPoints,
          this.state,
        ),
      );
    }

    this.moveState = null;
  }

  // ── Resize ─────────────────────────────────────────────────────────────────

  /**
   * Detect a handle under the cursor and begin resizing if found.
   * Returns `true` if a resize operation was started.
   */
  startResize(px: number, py: number, viewport: Viewport): boolean {
    const drawings = this.state.get('activeDrawings');
    for (const d of drawings) {
      if (!d.selected || d.locked) continue;
      const handle = getHandleAtPoint(px, py, d, viewport, 8);
      if (handle) {
        this.resizeState = {
          drawingId: d.id,
          handle,
          originalPoints: [...d.points],
        };
        return true;
      }
    }
    return false;
  }

  /**
   * Update the handle being dragged to a new chart-space position.
   */
  updateResize(time: number, price: number): void {
    if (!this.resizeState) return;

    const { drawingId, handle } = this.resizeState;
    const drawings = this.state.get('activeDrawings');
    const drawing = drawings.find((d) => d.id === drawingId);
    if (!drawing) return;

    let newPoints = [...drawing.points];

    switch (drawing.type) {
      case 'horizontal_line': {
        // Single point – update price.
        newPoints = [{ time: drawing.points[0].time, price }];
        break;
      }
      case 'trendline':
      case 'ray':
      case 'extended_line':
      case 'fibonacci_retracement':
      case 'fibonacci_extension': {
        if (handle.handleIndex < newPoints.length) {
          newPoints[handle.handleIndex] = { time, price };
        }
        break;
      }
      case 'rectangle':
      case 'price_range':
      case 'date_range': {
        // Corner / midpoint handles: map handle index back to corner adjustments.
        const p0 = { ...newPoints[0] };
        const p1 = { ...newPoints[1] };

        switch (handle.handleIndex) {
          case 0: // top-left corner
            newPoints = [{ time, price }, p1];
            break;
          case 1: // top-right
            newPoints = [{ time: p0.time, price }, { time, price: p1.price }];
            break;
          case 2: // bottom-right
            newPoints = [p0, { time, price }];
            break;
          case 3: // bottom-left
            newPoints = [{ time, price: p0.price }, { time: p1.time, price }];
            break;
          case 4: // mid-top
            newPoints = [{ time: p0.time, price }, p1];
            break;
          case 5: // mid-right
            newPoints = [p0, { time, price: p1.price }];
            break;
          case 6: // mid-bottom
            newPoints = [p0, { time: p1.time, price }];
            break;
          case 7: // mid-left
            newPoints = [{ time, price: p0.price }, p1];
            break;
        }
        break;
      }
      default: {
        if (handle.handleIndex < newPoints.length) {
          newPoints[handle.handleIndex] = { time, price };
        }
        break;
      }
    }

    this.state.setState({
      activeDrawings: drawings.map((d) =>
        d.id === drawingId
          ? { ...d, points: newPoints, updatedAt: Date.now() }
          : d,
      ),
    });
  }

  /**
   * Finalise the resize and push an undoable command.
   */
  finishResize(): void {
    if (!this.resizeState) return;

    const drawing = this.state.get('activeDrawings').find(
      (d) => d.id === this.resizeState!.drawingId,
    );
    if (drawing) {
      const currentPoints = [...drawing.points];
      // Revert then replay through CommandStack.
      this.state.setState({
        activeDrawings: this.state.get('activeDrawings').map((d) =>
          d.id === this.resizeState!.drawingId
            ? { ...d, points: this.resizeState!.originalPoints }
            : d,
        ),
      });
      this.commandStack.push(
        new MoveDrawingCommand(
          this.resizeState.drawingId,
          this.resizeState.originalPoints,
          currentPoints,
          this.state,
        ),
      );
    }

    this.resizeState = null;
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  deleteDrawing(id: string): void {
    const drawing = this.state.get('activeDrawings').find((d) => d.id === id);
    if (!drawing) return;
    this.commandStack.push(new RemoveDrawingCommand(drawing, this.state));
    if (this.selectedDrawingId === id) this.selectedDrawingId = null;
  }

  // ── Clone ──────────────────────────────────────────────────────────────────

  /**
   * Duplicate a drawing with a slight time/price offset.
   */
  cloneDrawing(id: string): Drawing | null {
    const drawing = this.state.get('activeDrawings').find((d) => d.id === id);
    if (!drawing) return null;

    const now = Date.now();
    // Small offset so the clone doesn't sit exactly on top.
    const timeDelta = 60_000; // 1 minute
    const priceDelta =
      drawing.points.length > 0
        ? (drawing.points[0].price * 0.002) // 0.2 % of anchor price
        : 0;

    const clone: Drawing = {
      ...drawing,
      id: uid(),
      selected: false,
      points: drawing.points.map((p) => ({
        time: p.time + timeDelta,
        price: p.price + priceDelta,
      })),
      createdAt: now,
      updatedAt: now,
    };

    this.commandStack.push(new AddDrawingCommand(clone, this.state));
    return clone;
  }

  // ── Update Properties ──────────────────────────────────────────────────────

  /**
   * Update the visual properties of a drawing (color, lineWidth, etc.).
   * Applies the partial property update and persists it in state.
   */
  updateProperties(drawingId: string, props: Partial<import('../core/ChartState').DrawingProperties>): void {
    const drawings = this.state.get('activeDrawings');
    const idx = drawings.findIndex((d) => d.id === drawingId);
    if (idx === -1) return;

    const drawing = drawings[idx]!;
    const updated: import('../core/ChartState').Drawing = {
      ...drawing,
      properties: { ...drawing.properties, ...props },
      updatedAt: Date.now(),
    };

    // If updated points were provided (from coordinates tab), apply them
    const updatedPoints = (props as any)._updatedPoints;
    if (updatedPoints && Array.isArray(updatedPoints)) {
      (updated as any).points = updatedPoints;
      delete (updated.properties as any)._updatedPoints;
    }

    const newDrawings = [...drawings];
    newDrawings[idx] = updated;
    this.state.setState({ activeDrawings: newDrawings });
  }

  // ── Context Menu ───────────────────────────────────────────────────────────

  /**
   * Return the context-menu actions available for a drawing.
   */
  getContextMenuItems(drawingId: string): ContextMenuItem[] {
    const drawing = this.state.get('activeDrawings').find((d) => d.id === drawingId);
    if (!drawing) return [];

    const items: ContextMenuItem[] = [
      { label: 'Edit Properties…', action: 'edit' },
      { label: 'Clone', action: 'clone' },
    ];

    if (drawing.locked) {
      items.push({ label: 'Unlock', action: 'unlock' });
    } else {
      items.push({ label: 'Lock', action: 'lock' });
    }

    if (drawing.visible) {
      items.push({ label: 'Hide', action: 'hide' });
    } else {
      items.push({ label: 'Show', action: 'show' });
    }

    items.push({ label: 'Bring to Front', action: 'bring_to_front' });
    items.push({ label: 'Send to Back', action: 'send_to_back' });
    items.push({ label: 'Delete', action: 'delete' });

    return items;
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  saveToLocalStorage(symbol: string, timeframe: string): void {
    const drawings = this.state.get('activeDrawings');
    saveLocal(symbol, timeframe, drawings);
  }

  loadFromLocalStorage(symbol: string, timeframe: string): void {
    const drawings = loadLocal(symbol, timeframe);
    this.state.setState({ activeDrawings: drawings });
  }

  async saveToServer(drawing: Drawing): Promise<void> {
    await persistSaveToServer(drawing);
  }

  async loadFromServer(
    userId: string,
    symbol: string,
    timeframe: string,
  ): Promise<void> {
    const drawings = await persistLoadFromServer(symbol, timeframe);
    this.state.setState({ activeDrawings: drawings });
  }
}
