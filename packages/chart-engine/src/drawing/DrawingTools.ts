/**
 * DrawingTools.ts
 * Complete TradingView-class drawing tools definitions.
 * Defines all available tools, their categories, required points,
 * default properties, keyboard shortcuts, and SVG icons.
 */

import type { DrawingType, DrawingProperties } from '../core/ChartState';

// ─── Tool Categories ───────────────────────────────────────────────────────────

export type ToolCategory =
  | 'lines'
  | 'channels'
  | 'fibonacci'
  | 'shapes'
  | 'measurements'
  | 'annotations'
  | 'patterns';

export interface ToolDefinition {
  id: string;
  label: string;
  category: ToolCategory;
  drawingType: DrawingType;
  requiredPoints: number;
  icon: string;           // SVG string
  shortcut?: string;      // keyboard shortcut
  cursor: string;         // CSS cursor when tool is active
  defaultProperties: DrawingProperties;
  description: string;
}

// ─── Icons (inline SVG paths) ──────────────────────────────────────────────────

const icon = (path: string, vb = '0 0 24 24') =>
  `<svg viewBox="${vb}" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;

const ICONS = {
  hline:       icon('<line x1="2" y1="12" x2="22" y2="12"/>'),
  vline:       icon('<line x1="12" y1="2" x2="12" y2="22"/>'),
  trendline:   icon('<line x1="3" y1="20" x2="21" y2="4"/>'),
  ray:         icon('<line x1="3" y1="18" x2="21" y2="6"/><circle cx="3" cy="18" r="2" fill="currentColor"/>'),
  extended:    icon('<line x1="1" y1="18" x2="23" y2="6"/><circle cx="8" cy="14" r="2" fill="currentColor"/><circle cx="16" cy="9" r="2" fill="currentColor"/>'),
  channel:     icon('<line x1="3" y1="18" x2="21" y2="10"/><line x1="3" y1="10" x2="21" y2="2"/><line x1="3" y1="18" x2="3" y2="10" stroke-dasharray="3 2"/>'),
  fib:         icon('<line x1="2" y1="4" x2="22" y2="4" stroke-dasharray="4 2"/><line x1="2" y1="9" x2="22" y2="9" stroke-dasharray="4 2"/><line x1="2" y1="14" x2="22" y2="14" stroke-dasharray="4 2"/><line x1="2" y1="20" x2="22" y2="20"/>'),
  fibExt:      icon('<line x1="2" y1="6" x2="22" y2="6" stroke-dasharray="4 2"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="18" x2="22" y2="18" stroke-dasharray="4 2"/><path d="M12 6v12" stroke-dasharray="2 2"/>'),
  rect:        icon('<rect x="4" y="6" width="16" height="12" rx="1"/>'),
  ellipse:     icon('<ellipse cx="12" cy="12" rx="9" ry="6"/>'),
  priceRange:  icon('<rect x="2" y="6" width="20" height="12" rx="1" stroke-dasharray="4 2"/><line x1="12" y1="6" x2="12" y2="18"/><path d="M9 9l3-3 3 3M9 15l3 3 3-3" fill="none"/>'),
  dateRange:   icon('<line x1="6" y1="2" x2="6" y2="22"/><line x1="18" y1="2" x2="18" y2="22"/><line x1="6" y1="12" x2="18" y2="12" stroke-dasharray="3 2"/><path d="M9 9l-3 3 3 3M15 9l3 3-3 3" fill="none"/>'),
  measure:     icon('<path d="M3 20l8-8m0 8l8-8" /><line x1="3" y1="20" x2="19" y2="4"/><circle cx="3" cy="20" r="2" fill="currentColor"/><circle cx="19" cy="4" r="2" fill="currentColor"/>'),
  text:        icon('<text x="5" y="18" font-size="16" font-weight="bold" fill="currentColor" stroke="none">T</text>'),
  crosshair:   icon('<line x1="12" y1="2" x2="12" y2="22" stroke-dasharray="3 2"/><line x1="2" y1="12" x2="22" y2="12" stroke-dasharray="3 2"/><circle cx="12" cy="12" r="3"/>'),
  pointer:     icon('<path d="M5 3l14 8-6 2-4 6z" fill="currentColor" stroke="none"/>'),
  eraser:      icon('<path d="M18 13l-5 5H7l-3-3 9-9 5 5z"/><line x1="13" y1="18" x2="21" y2="18"/>'),
};

// ─── Color Palette ─────────────────────────────────────────────────────────────

export const TOOL_COLORS = [
  '#2196F3', '#f44336', '#4CAF50', '#FF9800', '#9C27B0',
  '#00BCD4', '#E91E63', '#FFC107', '#8BC34A', '#3F51B5',
  '#FF5722', '#607D8B', '#CDDC39', '#795548', '#009688',
  '#ffffff', '#9e9e9e', '#000000',
];

export const LINE_WIDTHS = [1, 2, 3, 4, 5];

// ─── Tool Definitions ──────────────────────────────────────────────────────────

export const DRAWING_TOOLS: ToolDefinition[] = [
  // ── Lines ────────────────────────────────────────────────────────────────
  {
    id: 'hline',
    label: 'Horizontal Line',
    category: 'lines',
    drawingType: 'horizontal_line',
    requiredPoints: 1,
    icon: ICONS.hline,
    shortcut: 'H',
    cursor: 'crosshair',
    defaultProperties: { color: '#2196F3', lineWidth: 1, lineStyle: 'solid', showLabels: true },
    description: 'Draw a horizontal price level',
  },
  {
    id: 'vline',
    label: 'Vertical Line',
    category: 'lines',
    drawingType: 'vertical_line',
    requiredPoints: 1,
    icon: ICONS.vline,
    shortcut: 'V',
    cursor: 'crosshair',
    defaultProperties: { color: '#2196F3', lineWidth: 1, lineStyle: 'solid' },
    description: 'Draw a vertical time marker',
  },
  {
    id: 'trendline',
    label: 'Trend Line',
    category: 'lines',
    drawingType: 'trendline',
    requiredPoints: 2,
    icon: ICONS.trendline,
    shortcut: 'T',
    cursor: 'crosshair',
    defaultProperties: { color: '#2196F3', lineWidth: 2, lineStyle: 'solid', showLabels: true },
    description: 'Draw a line between two points',
  },
  {
    id: 'ray',
    label: 'Ray',
    category: 'lines',
    drawingType: 'ray',
    requiredPoints: 2,
    icon: ICONS.ray,
    cursor: 'crosshair',
    defaultProperties: { color: '#FF9800', lineWidth: 1, lineStyle: 'solid', extendRight: true },
    description: 'Draw a ray extending from an anchor',
  },
  {
    id: 'extended_line',
    label: 'Extended Line',
    category: 'lines',
    drawingType: 'extended_line',
    requiredPoints: 2,
    icon: ICONS.extended,
    cursor: 'crosshair',
    defaultProperties: { color: '#4CAF50', lineWidth: 1, lineStyle: 'solid', extendLeft: true, extendRight: true },
    description: 'Draw an infinite line through two points',
  },

  // ── Channels ─────────────────────────────────────────────────────────────
  {
    id: 'parallel_channel',
    label: 'Parallel Channel',
    category: 'channels',
    drawingType: 'parallel_channel',
    requiredPoints: 3,
    icon: ICONS.channel,
    shortcut: 'P',
    cursor: 'crosshair',
    defaultProperties: { color: '#9C27B0', lineWidth: 1, lineStyle: 'solid', fillColor: '#9C27B0', fillOpacity: 0.08 },
    description: 'Draw two parallel trend lines',
  },

  // ── Fibonacci ────────────────────────────────────────────────────────────
  {
    id: 'fibonacci',
    label: 'Fib Retracement',
    category: 'fibonacci',
    drawingType: 'fibonacci_retracement',
    requiredPoints: 2,
    icon: ICONS.fib,
    shortcut: 'F',
    cursor: 'crosshair',
    defaultProperties: {
      color: '#FF9800', lineWidth: 1, lineStyle: 'dashed', showLabels: true,
      levels: [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1],
      fillColor: '#FF9800', fillOpacity: 0.06,
    },
    description: 'Fibonacci retracement levels',
  },
  {
    id: 'fib_extension',
    label: 'Fib Extension',
    category: 'fibonacci',
    drawingType: 'fibonacci_extension',
    requiredPoints: 2,
    icon: ICONS.fibExt,
    cursor: 'crosshair',
    defaultProperties: {
      color: '#00BCD4', lineWidth: 1, lineStyle: 'dashed', showLabels: true,
      levels: [0, 0.618, 1, 1.272, 1.618, 2, 2.618, 3.618, 4.236],
      fillColor: '#00BCD4', fillOpacity: 0.04,
    },
    description: 'Fibonacci extension levels',
  },

  // ── Shapes ───────────────────────────────────────────────────────────────
  {
    id: 'rectangle',
    label: 'Rectangle',
    category: 'shapes',
    drawingType: 'rectangle',
    requiredPoints: 2,
    icon: ICONS.rect,
    shortcut: 'R',
    cursor: 'crosshair',
    defaultProperties: { color: '#2196F3', lineWidth: 1, lineStyle: 'solid', fillColor: '#2196F3', fillOpacity: 0.12 },
    description: 'Draw a rectangle zone',
  },
  {
    id: 'ellipse',
    label: 'Ellipse',
    category: 'shapes',
    drawingType: 'ellipse',
    requiredPoints: 2,
    icon: ICONS.ellipse,
    cursor: 'crosshair',
    defaultProperties: { color: '#E91E63', lineWidth: 1, lineStyle: 'solid', fillColor: '#E91E63', fillOpacity: 0.10 },
    description: 'Draw an ellipse',
  },

  // ── Measurements ─────────────────────────────────────────────────────────
  {
    id: 'price_range',
    label: 'Price Range',
    category: 'measurements',
    drawingType: 'price_range',
    requiredPoints: 2,
    icon: ICONS.priceRange,
    cursor: 'crosshair',
    defaultProperties: { color: '#4CAF50', lineWidth: 1, lineStyle: 'dashed', fillColor: '#4CAF50', fillOpacity: 0.08, showLabels: true },
    description: 'Measure price difference + percentage',
  },
  {
    id: 'date_range',
    label: 'Date Range',
    category: 'measurements',
    drawingType: 'date_range',
    requiredPoints: 2,
    icon: ICONS.dateRange,
    cursor: 'crosshair',
    defaultProperties: { color: '#3F51B5', lineWidth: 1, lineStyle: 'dashed', fillColor: '#3F51B5', fillOpacity: 0.06, showLabels: true },
    description: 'Measure time span + bar count',
  },
  {
    id: 'measure',
    label: 'Measure Tool',
    category: 'measurements',
    drawingType: 'measure',
    requiredPoints: 2,
    icon: ICONS.measure,
    shortcut: 'M',
    cursor: 'crosshair',
    defaultProperties: { color: '#607D8B', lineWidth: 1, lineStyle: 'dashed', showLabels: true },
    description: 'Measure distance, angle, bars, and P&L',
  },

  // ── Annotations ──────────────────────────────────────────────────────────
  {
    id: 'text',
    label: 'Text Note',
    category: 'annotations',
    drawingType: 'text',
    requiredPoints: 1,
    icon: ICONS.text,
    cursor: 'text',
    defaultProperties: { color: '#ffffff', fontSize: 14, text: 'Note', lineWidth: 0, lineStyle: 'solid' },
    description: 'Place a text annotation',
  },
];

// ─── Lookup Helpers ────────────────────────────────────────────────────────────

const TOOL_MAP = new Map(DRAWING_TOOLS.map(t => [t.id, t]));
const SHORTCUT_MAP = new Map(DRAWING_TOOLS.filter(t => t.shortcut).map(t => [t.shortcut!, t.id]));

export function getToolById(id: string): ToolDefinition | undefined {
  return TOOL_MAP.get(id);
}

export function getToolByShortcut(key: string): string | undefined {
  return SHORTCUT_MAP.get(key.toUpperCase());
}

export function getToolsByCategory(category: ToolCategory): ToolDefinition[] {
  return DRAWING_TOOLS.filter(t => t.category === category);
}

export const TOOL_CATEGORIES: { id: ToolCategory; label: string }[] = [
  { id: 'lines', label: 'Lines' },
  { id: 'channels', label: 'Channels' },
  { id: 'fibonacci', label: 'Fibonacci' },
  { id: 'shapes', label: 'Shapes' },
  { id: 'measurements', label: 'Measurements' },
  { id: 'annotations', label: 'Annotations' },
];
