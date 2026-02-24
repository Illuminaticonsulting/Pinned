/**
 * ReplayMode.ts
 * Historical session replay with video-player-style controls.
 *
 * Play any historical session back bar-by-bar. Pause, rewind, scrub, adjust
 * speed (1×, 2×, 5×, 10×). Practice trading without risking money.
 *
 * DeepCharts has basic replay. TradingView's replay is Pro-only and clunky.
 * Ours has a proper video-player UI with scrubbing and speed control.
 */

import type { Candle } from '../core/ChartState';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ReplaySpeed = 0.5 | 1 | 2 | 5 | 10;
export type ReplayState = 'stopped' | 'playing' | 'paused';

export interface ReplayCallbacks {
  /** Called when a new candle should be revealed */
  onRevealCandle: (candles: Candle[]) => void;
  /** Called when replay state changes */
  onStateChange: (state: ReplayState) => void;
  /** Called to fetch candles for the given date range */
  fetchCandles: (startTs: number, endTs: number) => Promise<Candle[]>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SPEEDS: ReplaySpeed[] = [0.5, 1, 2, 5, 10];
const BASE_INTERVAL = 800; // ms per candle at 1x speed

// ─── ReplayMode ──────────────────────────────────────────────────────────────

export class ReplayMode {
  private state: ReplayState = 'stopped';
  private speed: ReplaySpeed = 1;
  private allCandles: Candle[] = [];
  private visibleCount = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private callbacks: ReplayCallbacks;
  private bar: HTMLElement | null = null;
  private container: HTMLElement | null = null;
  private startDatePicker: HTMLInputElement | null = null;
  private endDatePicker: HTMLInputElement | null = null;

  constructor(callbacks: ReplayCallbacks) {
    this.callbacks = callbacks;
  }

  // ── Public API ─────────────────────────────────────────────────────────

  isActive(): boolean {
    return this.state !== 'stopped';
  }

  getState(): ReplayState {
    return this.state;
  }

  /**
   * Mount the replay control bar into the given container.
   */
  mount(container: HTMLElement): void {
    this.container = container;
    this.bar = document.createElement('div');
    this.bar.className = 'replay-bar';
    this.bar.innerHTML = this.buildUI();
    container.appendChild(this.bar);
    this.bindEvents();
    this.hide();
  }

  show(): void {
    if (this.bar) this.bar.style.display = 'flex';
  }

  hide(): void {
    if (this.bar) this.bar.style.display = 'none';
  }

  /** Start replay with loaded candles */
  async startReplay(startTs?: number, endTs?: number): Promise<void> {
    // Use date pickers if no params
    const start = startTs ?? this.getStartTimestamp();
    const end = endTs ?? this.getEndTimestamp();

    if (!start || !end || start >= end) return;

    this.allCandles = await this.callbacks.fetchCandles(start, end);
    if (this.allCandles.length === 0) return;

    // Sort chronologically
    this.allCandles.sort((a, b) => a.timestamp - b.timestamp);

    // Start with first 10 candles visible
    this.visibleCount = Math.min(10, this.allCandles.length);
    this.revealCandles();

    this.state = 'paused';
    this.callbacks.onStateChange(this.state);
    this.show();
    this.updateUI();
  }

  play(): void {
    if (this.state === 'stopped') return;
    if (this.visibleCount >= this.allCandles.length) return;

    this.state = 'playing';
    this.callbacks.onStateChange(this.state);
    this.startTimer();
    this.updateUI();
  }

  pause(): void {
    this.state = 'paused';
    this.callbacks.onStateChange(this.state);
    this.stopTimer();
    this.updateUI();
  }

  stop(): void {
    this.stopTimer();
    this.state = 'stopped';
    this.visibleCount = 0;
    this.allCandles = [];
    this.callbacks.onStateChange(this.state);
    this.hide();
    this.updateUI();
  }

  /** Step forward by one candle */
  stepForward(): void {
    if (this.visibleCount < this.allCandles.length) {
      this.visibleCount++;
      this.revealCandles();
      this.updateUI();
    }
  }

  /** Step backward by one candle */
  stepBackward(): void {
    if (this.visibleCount > 1) {
      this.visibleCount--;
      this.revealCandles();
      this.updateUI();
    }
  }

  /** Jump to a specific position (0-1 normalized) */
  seekTo(position: number): void {
    this.visibleCount = Math.max(1, Math.round(position * this.allCandles.length));
    this.revealCandles();
    this.updateUI();
  }

  setSpeed(speed: ReplaySpeed): void {
    this.speed = speed;
    if (this.state === 'playing') {
      this.stopTimer();
      this.startTimer();
    }
    this.updateUI();
  }

  destroy(): void {
    this.stopTimer();
    this.bar?.remove();
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private startTimer(): void {
    this.stopTimer();
    const interval = BASE_INTERVAL / this.speed;
    this.timer = setInterval(() => {
      if (this.visibleCount >= this.allCandles.length) {
        this.pause();
        return;
      }
      this.visibleCount++;
      this.revealCandles();
      this.updateUI();
    }, interval);
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private revealCandles(): void {
    const visible = this.allCandles.slice(0, this.visibleCount);
    this.callbacks.onRevealCandle(visible);
  }

  private getStartTimestamp(): number {
    if (this.startDatePicker?.value) {
      return new Date(this.startDatePicker.value).getTime();
    }
    return Date.now() - 24 * 60 * 60 * 1000; // Default: 24h ago
  }

  private getEndTimestamp(): number {
    if (this.endDatePicker?.value) {
      return new Date(this.endDatePicker.value).getTime();
    }
    return Date.now();
  }

  // ── UI ─────────────────────────────────────────────────────────────────

  private buildUI(): string {
    return `
      <div class="replay-section replay-dates">
        <label class="replay-label">Start</label>
        <input type="datetime-local" class="replay-date-input" id="replayStart" />
        <label class="replay-label">End</label>
        <input type="datetime-local" class="replay-date-input" id="replayEnd" />
        <button class="replay-btn replay-load-btn" id="replayLoadBtn" title="Load session">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 7h10M7 2v10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          Load
        </button>
      </div>
      <div class="replay-section replay-transport">
        <button class="replay-btn" id="replayStepBack" title="Step back (←)">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9 3L4 7l5 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="replay-btn replay-play-btn" id="replayPlayPause" title="Play/Pause (Space)">
          <svg class="replay-play-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2l10 6-10 6z"/></svg>
          <svg class="replay-pause-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style="display:none"><rect x="3" y="2" width="3" height="12"/><rect x="10" y="2" width="3" height="12"/></svg>
        </button>
        <button class="replay-btn" id="replayStepFwd" title="Step forward (→)">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5 3l5 4-5 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="replay-btn replay-stop-btn" id="replayStop" title="Stop replay">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="3" y="3" width="8" height="8" fill="currentColor"/></svg>
        </button>
      </div>
      <div class="replay-section replay-scrub">
        <input type="range" class="replay-slider" id="replaySlider" min="1" max="100" value="10" />
        <span class="replay-progress" id="replayProgress">10 / 100</span>
      </div>
      <div class="replay-section replay-speed">
        ${SPEEDS.map((s) => `<button class="replay-speed-btn ${s === 1 ? 'active' : ''}" data-speed="${s}">${s}×</button>`).join('')}
      </div>
    `;
  }

  private bindEvents(): void {
    if (!this.bar) return;

    this.startDatePicker = this.bar.querySelector('#replayStart');
    this.endDatePicker = this.bar.querySelector('#replayEnd');

    // Default dates
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    if (this.endDatePicker) this.endDatePicker.value = now.toISOString().slice(0, 16);
    if (this.startDatePicker) this.startDatePicker.value = yesterday.toISOString().slice(0, 16);

    // Load button
    this.bar.querySelector('#replayLoadBtn')?.addEventListener('click', () => {
      this.startReplay();
    });

    // Transport controls
    this.bar.querySelector('#replayPlayPause')?.addEventListener('click', () => {
      if (this.state === 'playing') this.pause();
      else this.play();
    });

    this.bar.querySelector('#replayStepBack')?.addEventListener('click', () => this.stepBackward());
    this.bar.querySelector('#replayStepFwd')?.addEventListener('click', () => this.stepForward());
    this.bar.querySelector('#replayStop')?.addEventListener('click', () => this.stop());

    // Slider scrubbing
    const slider = this.bar.querySelector<HTMLInputElement>('#replaySlider');
    slider?.addEventListener('input', () => {
      const val = parseInt(slider.value, 10);
      const total = this.allCandles.length || 1;
      this.seekTo(val / total);
    });

    // Speed buttons
    this.bar.querySelectorAll<HTMLButtonElement>('.replay-speed-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const speed = parseFloat(btn.dataset.speed!) as ReplaySpeed;
        this.setSpeed(speed);
      });
    });

    // Keyboard shortcuts when replay is active
    document.addEventListener('keydown', (e) => {
      if (!this.isActive()) return;
      if ((e.target as HTMLElement).tagName === 'INPUT') return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          if (this.state === 'playing') this.pause();
          else this.play();
          break;
        case 'ArrowLeft':
          if (!e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            this.stepBackward();
          }
          break;
        case 'ArrowRight':
          if (!e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            this.stepForward();
          }
          break;
      }
    });
  }

  private updateUI(): void {
    if (!this.bar) return;

    // Play/Pause button icon
    const playIcon = this.bar.querySelector<HTMLElement>('.replay-play-icon');
    const pauseIcon = this.bar.querySelector<HTMLElement>('.replay-pause-icon');
    if (playIcon && pauseIcon) {
      playIcon.style.display = this.state === 'playing' ? 'none' : 'block';
      pauseIcon.style.display = this.state === 'playing' ? 'block' : 'none';
    }

    // Slider
    const slider = this.bar.querySelector<HTMLInputElement>('#replaySlider');
    if (slider) {
      slider.max = String(this.allCandles.length || 1);
      slider.value = String(this.visibleCount);
    }

    // Progress
    const progress = this.bar.querySelector('#replayProgress');
    if (progress) {
      progress.textContent = `${this.visibleCount} / ${this.allCandles.length}`;
    }

    // Speed buttons
    this.bar.querySelectorAll<HTMLButtonElement>('.replay-speed-btn').forEach((btn) => {
      btn.classList.toggle('active', parseFloat(btn.dataset.speed!) === this.speed);
    });
  }
}
