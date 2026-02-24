/**
 * drawing/index.ts
 * Barrel exports for the drawing tools subsystem.
 */

export { DrawingManager, type ActiveTool, type ContextMenuItem } from './DrawingManager';
export { renderDrawings } from './DrawingRenderer';
export {
  saveLocal,
  loadLocal,
  saveToServer,
  loadFromServer,
  deleteFromServer,
  updateOnServer,
  exportDrawings,
  importDrawings,
} from './DrawingPersistence';
export {
  distancePointToLineSegment,
  isPointInRect,
  isPointNearRectEdge,
  distancePointToHorizontalLine,
  getHandleAtPoint,
  findNearestDrawing,
  type HandleInfo,
} from './HitTest';
