/**
 * CustomIndicatorBuilder — Visual node-based indicator builder.
 *
 * Canvas-based node graph editor where users drag source, transform,
 * and output nodes, connect ports, and evaluate the graph in real-time
 * to render custom indicators on the chart.
 */

// ─── Types ─────────────────────────────────────────────────────────────────────

export type NodeCategory = 'source' | 'transform' | 'output';

export type SourceType = 'Price' | 'Volume' | 'Delta' | 'OFI' | 'FundingRate' | 'DOMSize';
export type TransformType = 'SMA' | 'EMA' | 'StdDev' | 'Ratio' | 'Threshold' | 'CrossDetect' | 'Abs' | 'Log';
export type OutputType = 'LineChart' | 'Histogram' | 'Marker' | 'ColorBackground';
export type NodeType = SourceType | TransformType | OutputType;

export interface Port {
  id: string;
  label: string;
  direction: 'input' | 'output';
  dataType: 'numeric';
}

export interface GraphNode {
  id: string;
  type: NodeType;
  category: NodeCategory;
  x: number;
  y: number;
  width: number;
  height: number;
  ports: Port[];
  params: Record<string, number | string>;
}

export interface Connection {
  id: string;
  fromNodeId: string;
  fromPortId: string;
  toNodeId: string;
  toPortId: string;
}

export interface GraphConfig {
  nodes: GraphNode[];
  connections: Connection[];
}

interface DragState {
  type: 'node' | 'connection' | 'pan';
  nodeId?: string;
  offsetX: number;
  offsetY: number;
  fromNodeId?: string;
  fromPortId?: string;
  mouseX: number;
  mouseY: number;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const NODE_HEADER_H = 24;
const PORT_RADIUS = 5;
const PORT_SPACING = 22;
const NODE_MIN_W = 140;
const NODE_MIN_H = 50;

const COLORS = {
  bg: '#0a0e17',
  grid: '#111827',
  gridLine: '#1f293740',
  node: {
    source: { bg: '#1a2332', border: '#2563eb', header: '#1e3a5f' },
    transform: { bg: '#1f2937', border: '#8b5cf6', header: '#312e5c' },
    output: { bg: '#1a2320', border: '#10b981', header: '#1e3a2f' },
  },
  port: { input: '#60a5fa', output: '#f59e0b' },
  connection: '#6366f1',
  connectionDrag: '#6366f180',
  selection: '#6366f1',
  text: '#f9fafb',
  textDim: '#9ca3af',
  paletteSection: '#6b7280',
};

const SOURCE_NODES: { type: SourceType; label: string }[] = [
  { type: 'Price', label: 'Price' },
  { type: 'Volume', label: 'Volume' },
  { type: 'Delta', label: 'Delta' },
  { type: 'OFI', label: 'OFI' },
  { type: 'FundingRate', label: 'Funding Rate' },
  { type: 'DOMSize', label: 'DOM Size' },
];

const TRANSFORM_NODES: { type: TransformType; label: string; params: Record<string, number> }[] = [
  { type: 'SMA', label: 'SMA(n)', params: { period: 14 } },
  { type: 'EMA', label: 'EMA(n)', params: { period: 14 } },
  { type: 'StdDev', label: 'StdDev(n)', params: { period: 20 } },
  { type: 'Ratio', label: 'Ratio', params: {} },
  { type: 'Threshold', label: 'Threshold', params: { value: 0 } },
  { type: 'CrossDetect', label: 'Cross Detect', params: {} },
  { type: 'Abs', label: 'Abs', params: {} },
  { type: 'Log', label: 'Log', params: {} },
];

const OUTPUT_NODES: { type: OutputType; label: string; params: Record<string, string> }[] = [
  { type: 'LineChart', label: 'Line Chart', params: { color: '#6366f1', lineWidth: '2' } },
  { type: 'Histogram', label: 'Histogram', params: { colorUp: '#10b981', colorDown: '#ef4444' } },
  { type: 'Marker', label: 'Marker', params: { color: '#f59e0b', shape: 'triangle' } },
  { type: 'ColorBackground', label: 'Color BG', params: { color: '#6366f130' } },
];

const PALETTE_W = 180;

const STYLES = {
  wrapper: {
    display: 'flex', width: '100%', height: '100%', background: '#0a0e17',
    overflow: 'hidden', fontFamily: 'Inter, system-ui, sans-serif',
  } as Partial<CSSStyleDeclaration>,
  palette: {
    width: `${PALETTE_W}px`, minWidth: `${PALETTE_W}px`, overflowY: 'auto',
    background: '#111827', borderRight: '1px solid #374151', padding: '8px',
    flexShrink: '0',
  } as Partial<CSSStyleDeclaration>,
  paletteSection: {
    fontSize: '10px', fontWeight: '600', color: '#6b7280',
    textTransform: 'uppercase', letterSpacing: '0.05em',
    marginTop: '12px', marginBottom: '6px',
  } as Partial<CSSStyleDeclaration>,
  paletteItem: {
    display: 'flex', alignItems: 'center', gap: '6px',
    padding: '6px 8px', borderRadius: '4px', cursor: 'grab',
    fontSize: '12px', color: '#f9fafb', marginBottom: '2px',
    background: '#1f2937', border: '1px solid #374151',
    userSelect: 'none',
  } as Partial<CSSStyleDeclaration>,
  canvasArea: {
    flex: '1', position: 'relative', overflow: 'hidden',
  } as Partial<CSSStyleDeclaration>,
  toolbar: {
    position: 'absolute', top: '8px', right: '8px', display: 'flex', gap: '6px', zIndex: '10',
  } as Partial<CSSStyleDeclaration>,
  toolbarBtn: {
    appearance: 'none', border: '1px solid #374151', background: '#1f2937',
    color: '#9ca3af', borderRadius: '4px', padding: '4px 10px', fontSize: '11px',
    cursor: 'pointer', fontWeight: '500',
  } as Partial<CSSStyleDeclaration>,
  paramOverlay: {
    position: 'absolute', background: '#1f2937', border: '1px solid #374151',
    borderRadius: '6px', padding: '12px', zIndex: '20', minWidth: '200px',
    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
  } as Partial<CSSStyleDeclaration>,
};

// ─── CustomIndicatorBuilder ────────────────────────────────────────────────────

export class CustomIndicatorBuilder {
  private container: HTMLElement | null = null;
  private wrapperEl: HTMLDivElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private canvasArea: HTMLDivElement | null = null;

  // State
  private nodes: GraphNode[] = [];
  private connections: Connection[] = [];
  private selectedNodeId: string | null = null;
  private dragState: DragState | null = null;
  private panX = 0;
  private panY = 0;

  // Param editor
  private paramOverlay: HTMLDivElement | null = null;

  // Callbacks
  private onEvaluate?: (results: Map<string, number[]>) => void;

  // Animation
  private rafId = 0;

  // ── Public API ────────────────────────────────────────────────────────

  mount(container: HTMLElement): void {
    this.container = container;
    this.buildDOM();
    this.bindEvents();
    this.startRenderLoop();
  }

  getConfig(): GraphConfig {
    return {
      nodes: JSON.parse(JSON.stringify(this.nodes)),
      connections: JSON.parse(JSON.stringify(this.connections)),
    };
  }

  loadConfig(json: GraphConfig): void {
    this.nodes = json.nodes || [];
    this.connections = json.connections || [];
    this.selectedNodeId = null;
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
    this.paramOverlay?.remove();
    this.wrapperEl?.remove();
    this.container = null;
    this.wrapperEl = null;
    this.canvas = null;
    this.ctx = null;
    this.nodes = [];
    this.connections = [];
  }

  onGraphEvaluate(cb: (results: Map<string, number[]>) => void): void {
    this.onEvaluate = cb;
  }

  // ── DOM ───────────────────────────────────────────────────────────────

  private buildDOM(): void {
    this.wrapperEl = document.createElement('div');
    Object.assign(this.wrapperEl.style, STYLES.wrapper);

    // Palette
    const palette = document.createElement('div');
    Object.assign(palette.style, STYLES.palette);
    palette.appendChild(this.buildPaletteSection('Sources', SOURCE_NODES, 'source'));
    palette.appendChild(this.buildPaletteSection('Transforms', TRANSFORM_NODES, 'transform'));
    palette.appendChild(this.buildPaletteSection('Outputs', OUTPUT_NODES, 'output'));

    // Save / Load / Share buttons at bottom of palette
    const actions = document.createElement('div');
    actions.style.marginTop = '16px';
    actions.style.display = 'flex';
    actions.style.flexDirection = 'column';
    actions.style.gap = '4px';
    for (const { label, action } of [
      { label: '💾 Save', action: () => this.saveGraph() },
      { label: '📂 Load', action: () => this.loadGraph() },
      { label: '🌐 Share', action: () => this.shareGraph() },
    ]) {
      const btn = document.createElement('button');
      Object.assign(btn.style, STYLES.toolbarBtn);
      btn.style.width = '100%';
      btn.textContent = label;
      btn.addEventListener('click', action);
      actions.appendChild(btn);
    }
    palette.appendChild(actions);

    this.wrapperEl.appendChild(palette);

    // Canvas area
    this.canvasArea = document.createElement('div');
    Object.assign(this.canvasArea.style, STYLES.canvasArea);

    this.canvas = document.createElement('canvas');
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.display = 'block';
    this.canvasArea.appendChild(this.canvas);

    // Toolbar
    const toolbar = document.createElement('div');
    Object.assign(toolbar.style, STYLES.toolbar);
    const evalBtn = document.createElement('button');
    Object.assign(evalBtn.style, STYLES.toolbarBtn);
    evalBtn.style.background = '#6366f1';
    evalBtn.style.color = '#fff';
    evalBtn.style.borderColor = '#6366f1';
    evalBtn.textContent = '▶ Evaluate';
    evalBtn.addEventListener('click', () => this.evaluateGraph());
    toolbar.appendChild(evalBtn);
    this.canvasArea.appendChild(toolbar);

    this.wrapperEl.appendChild(this.canvasArea);
    this.container!.appendChild(this.wrapperEl);

    this.resizeCanvas();
  }

  private buildPaletteSection(
    title: string,
    items: { type: string; label: string }[],
    category: NodeCategory,
  ): HTMLDivElement {
    const section = document.createElement('div');
    const heading = document.createElement('div');
    Object.assign(heading.style, STYLES.paletteSection);
    heading.textContent = title;
    section.appendChild(heading);

    for (const item of items) {
      const el = document.createElement('div');
      Object.assign(el.style, STYLES.paletteItem);
      const dot = document.createElement('span');
      dot.style.width = '8px';
      dot.style.height = '8px';
      dot.style.borderRadius = '50%';
      dot.style.background =
        category === 'source' ? '#2563eb'
          : category === 'transform' ? '#8b5cf6'
            : '#10b981';
      el.appendChild(dot);
      const label = document.createElement('span');
      label.textContent = item.label;
      el.appendChild(label);

      el.addEventListener('click', () => {
        this.addNode(item.type as NodeType, category);
      });

      section.appendChild(el);
    }

    return section;
  }

  // ── Events ────────────────────────────────────────────────────────────

  private bindEvents(): void {
    if (!this.canvas) return;

    this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
    this.canvas.addEventListener('mouseup', (e) => this.onMouseUp(e));
    this.canvas.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    window.addEventListener('keydown', (e) => this.onKeyDown(e));

    const ro = new ResizeObserver(() => this.resizeCanvas());
    if (this.canvasArea) ro.observe(this.canvasArea);
  }

  private onMouseDown(e: MouseEvent): void {
    const { x, y } = this.canvasToGraph(e.offsetX, e.offsetY);

    // Check if clicking on a port
    for (const node of this.nodes) {
      for (const port of node.ports) {
        const px = this.getPortX(node, port);
        const py = this.getPortY(node, port);
        if (Math.hypot(x - px, y - py) < PORT_RADIUS + 4) {
          if (port.direction === 'output') {
            this.dragState = {
              type: 'connection',
              fromNodeId: node.id,
              fromPortId: port.id,
              offsetX: 0,
              offsetY: 0,
              mouseX: x,
              mouseY: y,
            };
            return;
          }
        }
      }
    }

    // Check if clicking on a node
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const node = this.nodes[i];
      if (x >= node.x && x <= node.x + node.width && y >= node.y && y <= node.y + node.height) {
        this.selectedNodeId = node.id;
        this.dragState = {
          type: 'node',
          nodeId: node.id,
          offsetX: x - node.x,
          offsetY: y - node.y,
          mouseX: x,
          mouseY: y,
        };
        // Move to top
        const [removed] = this.nodes.splice(i, 1);
        this.nodes.push(removed);
        return;
      }
    }

    // Pan
    this.selectedNodeId = null;
    this.dragState = {
      type: 'pan',
      offsetX: this.panX,
      offsetY: this.panY,
      mouseX: e.offsetX,
      mouseY: e.offsetY,
    };
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.dragState) return;
    const { x, y } = this.canvasToGraph(e.offsetX, e.offsetY);

    if (this.dragState.type === 'node' && this.dragState.nodeId) {
      const node = this.nodes.find((n) => n.id === this.dragState!.nodeId);
      if (node) {
        node.x = x - this.dragState.offsetX;
        node.y = y - this.dragState.offsetY;
      }
    } else if (this.dragState.type === 'connection') {
      this.dragState.mouseX = x;
      this.dragState.mouseY = y;
    } else if (this.dragState.type === 'pan') {
      this.panX = this.dragState.offsetX + (e.offsetX - this.dragState.mouseX);
      this.panY = this.dragState.offsetY + (e.offsetY - this.dragState.mouseY);
    }
  }

  private onMouseUp(e: MouseEvent): void {
    if (!this.dragState) return;

    if (this.dragState.type === 'connection' && this.dragState.fromNodeId && this.dragState.fromPortId) {
      const { x, y } = this.canvasToGraph(e.offsetX, e.offsetY);

      // Find target port
      for (const node of this.nodes) {
        if (node.id === this.dragState.fromNodeId) continue;
        for (const port of node.ports) {
          if (port.direction !== 'input') continue;
          const px = this.getPortX(node, port);
          const py = this.getPortY(node, port);
          if (Math.hypot(x - px, y - py) < PORT_RADIUS + 6) {
            // Type checking: numeric -> numeric
            if (port.dataType === 'numeric') {
              // Remove existing connection to this input
              this.connections = this.connections.filter(
                (c) => !(c.toNodeId === node.id && c.toPortId === port.id),
              );
              this.connections.push({
                id: this.uid(),
                fromNodeId: this.dragState.fromNodeId!,
                fromPortId: this.dragState.fromPortId!,
                toNodeId: node.id,
                toPortId: port.id,
              });
            }
            break;
          }
        }
      }
    }

    this.dragState = null;
  }

  private onDoubleClick(e: MouseEvent): void {
    const { x, y } = this.canvasToGraph(e.offsetX, e.offsetY);

    for (const node of this.nodes) {
      if (x >= node.x && x <= node.x + node.width && y >= node.y && y <= node.y + node.height) {
        this.showParamEditor(node, e.clientX, e.clientY);
        return;
      }
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.selectedNodeId) {
        this.deleteNode(this.selectedNodeId);
        this.selectedNodeId = null;
      }
    }
  }

  // ── Node Management ───────────────────────────────────────────────────

  private addNode(type: NodeType, category: NodeCategory): void {
    const ports = this.createPorts(type, category);
    const height = Math.max(
      NODE_MIN_H,
      NODE_HEADER_H + Math.max(
        ports.filter((p) => p.direction === 'input').length,
        ports.filter((p) => p.direction === 'output').length,
      ) * PORT_SPACING + 10,
    );

    const params = this.getDefaultParams(type);

    const node: GraphNode = {
      id: this.uid(),
      type,
      category,
      x: 200 - this.panX + Math.random() * 100,
      y: 100 - this.panY + Math.random() * 100,
      width: NODE_MIN_W,
      height,
      ports,
      params,
    };

    this.nodes.push(node);
    this.selectedNodeId = node.id;
  }

  private deleteNode(nodeId: string): void {
    this.nodes = this.nodes.filter((n) => n.id !== nodeId);
    this.connections = this.connections.filter(
      (c) => c.fromNodeId !== nodeId && c.toNodeId !== nodeId,
    );
  }

  private createPorts(type: NodeType, category: NodeCategory): Port[] {
    const ports: Port[] = [];

    if (category === 'source') {
      ports.push({ id: 'out', label: 'Out', direction: 'output', dataType: 'numeric' });
    } else if (category === 'transform') {
      if (type === 'Ratio' || type === 'CrossDetect') {
        ports.push({ id: 'in_a', label: 'A', direction: 'input', dataType: 'numeric' });
        ports.push({ id: 'in_b', label: 'B', direction: 'input', dataType: 'numeric' });
      } else {
        ports.push({ id: 'in', label: 'In', direction: 'input', dataType: 'numeric' });
      }
      ports.push({ id: 'out', label: 'Out', direction: 'output', dataType: 'numeric' });
    } else if (category === 'output') {
      ports.push({ id: 'in', label: 'In', direction: 'input', dataType: 'numeric' });
    }

    return ports;
  }

  private getDefaultParams(type: NodeType): Record<string, number | string> {
    const found =
      TRANSFORM_NODES.find((n) => n.type === type) ||
      OUTPUT_NODES.find((n) => n.type === type);
    return found ? { ...found.params } : {};
  }

  // ── Param Editor ──────────────────────────────────────────────────────

  private showParamEditor(node: GraphNode, clientX: number, clientY: number): void {
    this.paramOverlay?.remove();

    if (Object.keys(node.params).length === 0) return;

    this.paramOverlay = document.createElement('div');
    Object.assign(this.paramOverlay.style, STYLES.paramOverlay);
    this.paramOverlay.style.left = `${clientX}px`;
    this.paramOverlay.style.top = `${clientY}px`;

    const title = document.createElement('div');
    title.style.fontSize = '12px';
    title.style.fontWeight = '600';
    title.style.color = '#f9fafb';
    title.style.marginBottom = '8px';
    title.textContent = `${node.type} Parameters`;
    this.paramOverlay.appendChild(title);

    for (const [key, val] of Object.entries(node.params)) {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '8px';
      row.style.marginBottom = '6px';

      const label = document.createElement('label');
      label.style.fontSize = '11px';
      label.style.color = '#9ca3af';
      label.style.width = '80px';
      label.textContent = key;
      row.appendChild(label);

      const input = document.createElement('input');
      input.style.background = '#374151';
      input.style.border = '1px solid #4b5563';
      input.style.borderRadius = '3px';
      input.style.color = '#f9fafb';
      input.style.padding = '4px 8px';
      input.style.fontSize = '12px';
      input.style.width = '80px';
      input.style.outline = 'none';
      input.value = String(val);
      input.addEventListener('input', () => {
        const numVal = parseFloat(input.value);
        node.params[key] = isNaN(numVal) ? input.value : numVal;
      });
      row.appendChild(input);

      this.paramOverlay.appendChild(row);
    }

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.style.marginTop = '8px';
    closeBtn.style.background = '#374151';
    closeBtn.style.border = 'none';
    closeBtn.style.color = '#f9fafb';
    closeBtn.style.padding = '4px 12px';
    closeBtn.style.borderRadius = '3px';
    closeBtn.style.fontSize = '11px';
    closeBtn.style.cursor = 'pointer';
    closeBtn.textContent = 'Done';
    closeBtn.addEventListener('click', () => {
      this.paramOverlay?.remove();
      this.paramOverlay = null;
    });
    this.paramOverlay.appendChild(closeBtn);

    document.body.appendChild(this.paramOverlay);
  }

  // ── Graph Evaluation ──────────────────────────────────────────────────

  private evaluateGraph(): void {
    // Topological sort: from outputs back to sources
    const evaluated = new Map<string, number[]>();
    const nodeMap = new Map(this.nodes.map((n) => [n.id, n]));

    const resolve = (nodeId: string, portId: string): number[] => {
      const cacheKey = `${nodeId}:${portId}`;
      if (evaluated.has(cacheKey)) return evaluated.get(cacheKey)!;

      const node = nodeMap.get(nodeId);
      if (!node) return [];

      let result: number[] = [];

      if (node.category === 'source') {
        // Placeholder: in production, this fetches real data
        result = Array.from({ length: 100 }, (_, i) => Math.sin(i * 0.1) * 100 + 1000);
      } else {
        // Resolve inputs
        const inputConnections = this.connections.filter((c) => c.toNodeId === nodeId);
        const inputs = new Map<string, number[]>();
        for (const conn of inputConnections) {
          const fromNode = nodeMap.get(conn.fromNodeId);
          if (fromNode) {
            inputs.set(conn.toPortId, resolve(conn.fromNodeId, conn.fromPortId));
          }
        }

        const primary = inputs.get('in') || inputs.get('in_a') || [];
        const secondary = inputs.get('in_b') || [];

        switch (node.type) {
          case 'SMA': {
            const period = (node.params.period as number) || 14;
            result = this.computeSMA(primary, period);
            break;
          }
          case 'EMA': {
            const period = (node.params.period as number) || 14;
            result = this.computeEMA(primary, period);
            break;
          }
          case 'StdDev': {
            const period = (node.params.period as number) || 20;
            result = this.computeStdDev(primary, period);
            break;
          }
          case 'Ratio':
            result = primary.map((v, i) => secondary[i] ? v / secondary[i] : 0);
            break;
          case 'Threshold': {
            const threshold = (node.params.value as number) || 0;
            result = primary.map((v) => v > threshold ? 1 : 0);
            break;
          }
          case 'CrossDetect':
            result = primary.map((v, i) => {
              if (i === 0) return 0;
              const prevA = primary[i - 1];
              const prevB = secondary[i - 1] ?? 0;
              const currB = secondary[i] ?? 0;
              if (prevA <= prevB && v > currB) return 1;  // cross above
              if (prevA >= prevB && v < currB) return -1; // cross below
              return 0;
            });
            break;
          case 'Abs':
            result = primary.map((v) => Math.abs(v));
            break;
          case 'Log':
            result = primary.map((v) => v > 0 ? Math.log(v) : 0);
            break;
          default:
            result = primary;
        }
      }

      evaluated.set(cacheKey, result);
      return result;
    };

    // Evaluate all output nodes
    const outputResults = new Map<string, number[]>();
    for (const node of this.nodes) {
      if (node.category === 'output') {
        const inputConn = this.connections.find((c) => c.toNodeId === node.id);
        if (inputConn) {
          const data = resolve(inputConn.fromNodeId, inputConn.fromPortId);
          outputResults.set(node.id, data);
        }
      }
    }

    this.onEvaluate?.(outputResults);
  }

  private computeSMA(data: number[], period: number): number[] {
    const result: number[] = [];
    for (let i = 0; i < data.length; i++) {
      if (i < period - 1) {
        result.push(data[i]);
      } else {
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += data[j];
        result.push(sum / period);
      }
    }
    return result;
  }

  private computeEMA(data: number[], period: number): number[] {
    const k = 2 / (period + 1);
    const result: number[] = [data[0]];
    for (let i = 1; i < data.length; i++) {
      result.push(data[i] * k + result[i - 1] * (1 - k));
    }
    return result;
  }

  private computeStdDev(data: number[], period: number): number[] {
    const result: number[] = [];
    for (let i = 0; i < data.length; i++) {
      if (i < period - 1) {
        result.push(0);
      } else {
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += data[j];
        const mean = sum / period;
        let variance = 0;
        for (let j = i - period + 1; j <= i; j++) variance += (data[j] - mean) ** 2;
        result.push(Math.sqrt(variance / period));
      }
    }
    return result;
  }

  // ── Rendering ─────────────────────────────────────────────────────────

  private startRenderLoop(): void {
    const render = () => {
      this.draw();
      this.rafId = requestAnimationFrame(render);
    };
    this.rafId = requestAnimationFrame(render);
  }

  private resizeCanvas(): void {
    if (!this.canvas || !this.canvasArea) return;
    const rect = this.canvasArea.getBoundingClientRect();
    const dpr = devicePixelRatio;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx = this.canvas.getContext('2d');
  }

  private draw(): void {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;

    const dpr = devicePixelRatio;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;

    ctx.save();
    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, w, h);

    // Grid
    ctx.strokeStyle = COLORS.gridLine;
    ctx.lineWidth = 1;
    const gridSize = 20;
    const offsetX = this.panX % gridSize;
    const offsetY = this.panY % gridSize;
    for (let x = offsetX; x < w; x += gridSize) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = offsetY; y < h; y += gridSize) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    ctx.translate(this.panX, this.panY);

    // Connections
    for (const conn of this.connections) {
      const fromNode = this.nodes.find((n) => n.id === conn.fromNodeId);
      const toNode = this.nodes.find((n) => n.id === conn.toNodeId);
      if (!fromNode || !toNode) continue;

      const fromPort = fromNode.ports.find((p) => p.id === conn.fromPortId);
      const toPort = toNode.ports.find((p) => p.id === conn.toPortId);
      if (!fromPort || !toPort) continue;

      const x1 = this.getPortX(fromNode, fromPort);
      const y1 = this.getPortY(fromNode, fromPort);
      const x2 = this.getPortX(toNode, toPort);
      const y2 = this.getPortY(toNode, toPort);

      this.drawConnection(ctx, x1, y1, x2, y2, COLORS.connection);
    }

    // Dragging connection preview
    if (this.dragState?.type === 'connection' && this.dragState.fromNodeId) {
      const fromNode = this.nodes.find((n) => n.id === this.dragState!.fromNodeId);
      const fromPort = fromNode?.ports.find((p) => p.id === this.dragState!.fromPortId);
      if (fromNode && fromPort) {
        const x1 = this.getPortX(fromNode, fromPort);
        const y1 = this.getPortY(fromNode, fromPort);
        this.drawConnection(ctx, x1, y1, this.dragState.mouseX, this.dragState.mouseY, COLORS.connectionDrag);
      }
    }

    // Nodes
    for (const node of this.nodes) {
      this.drawNode(ctx, node);
    }

    ctx.restore();
  }

  private drawNode(ctx: CanvasRenderingContext2D, node: GraphNode): void {
    const colors = COLORS.node[node.category];
    const isSelected = node.id === this.selectedNodeId;

    // Shadow
    ctx.shadowBlur = isSelected ? 16 : 4;
    ctx.shadowColor = isSelected ? COLORS.selection + '60' : '#00000040';

    // Body
    ctx.fillStyle = colors.bg;
    ctx.beginPath();
    ctx.roundRect(node.x, node.y, node.width, node.height, 6);
    ctx.fill();

    // Border
    ctx.shadowBlur = 0;
    ctx.strokeStyle = isSelected ? COLORS.selection : colors.border;
    ctx.lineWidth = isSelected ? 2 : 1;
    ctx.stroke();

    // Header
    ctx.fillStyle = colors.header;
    ctx.beginPath();
    ctx.roundRect(node.x, node.y, node.width, NODE_HEADER_H, [6, 6, 0, 0]);
    ctx.fill();

    // Title
    ctx.fillStyle = COLORS.text;
    ctx.font = '600 11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(node.type, node.x + node.width / 2, node.y + NODE_HEADER_H / 2);

    // Ports
    for (const port of node.ports) {
      const px = this.getPortX(node, port);
      const py = this.getPortY(node, port);

      ctx.beginPath();
      ctx.arc(px, py, PORT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = port.direction === 'input' ? COLORS.port.input : COLORS.port.output;
      ctx.fill();
      ctx.strokeStyle = colors.bg;
      ctx.lineWidth = 2;
      ctx.stroke();

      // Port label
      ctx.fillStyle = COLORS.textDim;
      ctx.font = '10px Inter, system-ui, sans-serif';
      ctx.textAlign = port.direction === 'input' ? 'left' : 'right';
      ctx.textBaseline = 'middle';
      const labelX = port.direction === 'input' ? px + PORT_RADIUS + 4 : px - PORT_RADIUS - 4;
      ctx.fillText(port.label, labelX, py);
    }
  }

  private drawConnection(
    ctx: CanvasRenderingContext2D,
    x1: number, y1: number,
    x2: number, y2: number,
    color: string,
  ): void {
    const dx = Math.abs(x2 - x1) * 0.5;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.bezierCurveTo(x1 + dx, y1, x2 - dx, y2, x2, y2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // ── Port Positioning ──────────────────────────────────────────────────

  private getPortX(node: GraphNode, port: Port): number {
    return port.direction === 'input' ? node.x : node.x + node.width;
  }

  private getPortY(node: GraphNode, port: Port): number {
    const portsOfDir = node.ports.filter((p) => p.direction === port.direction);
    const idx = portsOfDir.indexOf(port);
    return node.y + NODE_HEADER_H + 15 + idx * PORT_SPACING;
  }

  // ── Coordinate Transform ──────────────────────────────────────────────

  private canvasToGraph(canvasX: number, canvasY: number): { x: number; y: number } {
    return { x: canvasX - this.panX, y: canvasY - this.panY };
  }

  // ── Save / Load / Share ───────────────────────────────────────────────

  private saveGraph(): void {
    const config = this.getConfig();
    const json = JSON.stringify(config, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `indicator_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  private loadGraph(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      try {
        const config = JSON.parse(text) as GraphConfig;
        this.loadConfig(config);
      } catch (err) {
        console.error('Failed to load graph config:', err);
      }
    });
    input.click();
  }

  private async shareGraph(): Promise<void> {
    const config = this.getConfig();
    try {
      await fetch('/api/v1/indicators/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(config),
      });
    } catch (err) {
      console.error('Failed to share indicator:', err);
    }
  }

  // ── Utility ───────────────────────────────────────────────────────────

  private uid(): string {
    return Math.random().toString(36).slice(2, 10);
  }
}
