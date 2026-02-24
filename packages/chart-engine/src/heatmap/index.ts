/**
 * Heatmap module barrel exports.
 */

export { WebGLHeatmapRenderer } from './WebGLHeatmapRenderer';
export type {
  HeatmapAnnotation,
  HeatmapCellUpdate,
  HeatmapAxisConfig,
} from './WebGLHeatmapRenderer';

export { Canvas2DHeatmapFallback } from './Canvas2DHeatmapFallback';

export { HeatmapPanel } from './HeatmapPanel';
export type { TimeRange, HeatmapPanelOptions } from './HeatmapPanel';
