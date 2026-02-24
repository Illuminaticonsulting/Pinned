/**
 * CommandStack.ts
 * Undo / Redo system using the Command pattern for the Pinned chart engine.
 *
 * Provides a bounded stack of reversible operations together with built-in
 * command types for common drawing mutations.
 */

import type { ChartState, Drawing, ChartPoint, DrawingProperties } from './ChartState';

// ─── Command Interface ─────────────────────────────────────────────────────────

/**
 * A reversible operation.
 * Every concrete command must implement both `execute` (do / redo) and `undo`.
 */
export interface Command {
  /** Perform (or re-perform) the operation. */
  execute(): void;
  /** Reverse the operation. */
  undo(): void;
  /** Human-readable description for debugging / UI display. */
  readonly description: string;
}

// ─── CommandStack ──────────────────────────────────────────────────────────────

/** Maximum number of commands kept in the undo history. */
const MAX_STACK_DEPTH = 50;

/**
 * Manages an undo / redo history of {@link Command} objects.
 *
 * @example
 * ```ts
 * const stack = new CommandStack();
 * stack.push(new AddDrawingCommand(drawing, chartState));
 * stack.undo(); // drawing removed
 * stack.redo(); // drawing re-added
 * ```
 */
export class CommandStack {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];

  /**
   * Execute a command and add it to the undo stack.
   * The redo stack is cleared because the timeline has diverged.
   *
   * @param command - The command to execute.
   */
  push(command: Command): void {
    command.execute();
    this.undoStack.push(command);

    // Enforce maximum depth.
    if (this.undoStack.length > MAX_STACK_DEPTH) {
      this.undoStack.shift();
    }

    // New action invalidates the redo history.
    this.redoStack = [];
  }

  /**
   * Undo the most recent command.
   * The command is moved to the redo stack.
   *
   * @returns `true` if an undo was performed, `false` if the stack was empty.
   */
  undo(): boolean {
    const command = this.undoStack.pop();
    if (!command) return false;

    command.undo();
    this.redoStack.push(command);
    return true;
  }

  /**
   * Redo the most recently undone command.
   * The command is moved back to the undo stack.
   *
   * @returns `true` if a redo was performed, `false` if the stack was empty.
   */
  redo(): boolean {
    const command = this.redoStack.pop();
    if (!command) return false;

    command.execute();
    this.undoStack.push(command);
    return true;
  }

  /**
   * @returns `true` if there is at least one command that can be undone.
   */
  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /**
   * @returns `true` if there is at least one command that can be redone.
   */
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Clear both undo and redo stacks.
   */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  /**
   * @returns The number of commands in the undo stack.
   */
  get undoSize(): number {
    return this.undoStack.length;
  }

  /**
   * @returns The number of commands in the redo stack.
   */
  get redoSize(): number {
    return this.redoStack.length;
  }

  /**
   * @returns The description of the command that would be undone next, or `null`.
   */
  get nextUndoDescription(): string | null {
    return this.undoStack.length > 0
      ? this.undoStack[this.undoStack.length - 1].description
      : null;
  }

  /**
   * @returns The description of the command that would be redone next, or `null`.
   */
  get nextRedoDescription(): string | null {
    return this.redoStack.length > 0
      ? this.redoStack[this.redoStack.length - 1].description
      : null;
  }
}

// ─── Built-in Command Types ────────────────────────────────────────────────────

/**
 * Command that adds a drawing to the chart.
 */
export class AddDrawingCommand implements Command {
  readonly description: string;

  constructor(
    private readonly drawing: Drawing,
    private readonly state: ChartState,
  ) {
    this.description = `Add ${drawing.type} drawing`;
  }

  execute(): void {
    const current = this.state.get('activeDrawings');
    this.state.setState({
      activeDrawings: [...current, this.drawing],
    });
  }

  undo(): void {
    const current = this.state.get('activeDrawings');
    this.state.setState({
      activeDrawings: current.filter((d) => d.id !== this.drawing.id),
    });
  }
}

/**
 * Command that removes a drawing from the chart.
 */
export class RemoveDrawingCommand implements Command {
  readonly description: string;

  /** Index at which the drawing was located (for faithful undo insertion). */
  private originalIndex = -1;

  constructor(
    private readonly drawing: Drawing,
    private readonly state: ChartState,
  ) {
    this.description = `Remove ${drawing.type} drawing`;
  }

  execute(): void {
    const current = this.state.get('activeDrawings');
    this.originalIndex = current.findIndex((d) => d.id === this.drawing.id);
    this.state.setState({
      activeDrawings: current.filter((d) => d.id !== this.drawing.id),
    });
  }

  undo(): void {
    const current = [...this.state.get('activeDrawings')];
    if (this.originalIndex >= 0 && this.originalIndex <= current.length) {
      current.splice(this.originalIndex, 0, this.drawing);
    } else {
      current.push(this.drawing);
    }
    this.state.setState({ activeDrawings: current });
  }
}

/**
 * Command that modifies the properties of an existing drawing
 * (e.g. color, line width, fill).
 */
export class ModifyDrawingCommand implements Command {
  readonly description: string;

  constructor(
    private readonly drawingId: string,
    private readonly oldProps: Partial<DrawingProperties>,
    private readonly newProps: Partial<DrawingProperties>,
    private readonly state: ChartState,
  ) {
    this.description = `Modify drawing properties`;
  }

  execute(): void {
    this.applyProps(this.newProps);
  }

  undo(): void {
    this.applyProps(this.oldProps);
  }

  private applyProps(props: Partial<DrawingProperties>): void {
    const current = this.state.get('activeDrawings');
    this.state.setState({
      activeDrawings: current.map((d) =>
        d.id === this.drawingId
          ? {
              ...d,
              properties: { ...d.properties, ...props },
              updatedAt: Date.now(),
            }
          : d,
      ),
    });
  }
}

/**
 * Command that moves a drawing by updating its anchor points.
 */
export class MoveDrawingCommand implements Command {
  readonly description: string;

  constructor(
    private readonly drawingId: string,
    private readonly oldPoints: ChartPoint[],
    private readonly newPoints: ChartPoint[],
    private readonly state: ChartState,
  ) {
    this.description = `Move drawing`;
  }

  execute(): void {
    this.applyPoints(this.newPoints);
  }

  undo(): void {
    this.applyPoints(this.oldPoints);
  }

  private applyPoints(points: ChartPoint[]): void {
    const current = this.state.get('activeDrawings');
    this.state.setState({
      activeDrawings: current.map((d) =>
        d.id === this.drawingId
          ? { ...d, points, updatedAt: Date.now() }
          : d,
      ),
    });
  }
}
