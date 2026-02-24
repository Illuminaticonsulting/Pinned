/**
 * AlertModal — Alert creation/editing modal dialog.
 *
 * Allows users to configure alerts on price, delta divergence,
 * OFI threshold, absorption, funding spikes, and patterns.
 */

// ─── Types ─────────────────────────────────────────────────────────────────────

export type AlertCondition =
  | 'price_crosses'
  | 'delta_divergence'
  | 'ofi_threshold'
  | 'absorption'
  | 'funding_spike'
  | 'pattern';

export type AlertOperator = 'gt' | 'lt' | 'cross_above' | 'cross_below';

export type AlertExpiry = 'once' | 'recurring' | 'until_cancelled';

export interface AlertDelivery {
  inApp: boolean;
  browserPush: boolean;
  telegram: boolean;
  email: boolean;
}

export interface AlertFormData {
  condition: AlertCondition;
  value: number;
  operator: AlertOperator;
  delivery: AlertDelivery;
  expiry: AlertExpiry;
}

export interface AlertModalOptions {
  /** Pre-fill price value (e.g. from right-click on chart). */
  prefillPrice?: number;
  /** Pre-select condition type. */
  condition?: AlertCondition;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const CONDITIONS: { value: AlertCondition; label: string }[] = [
  { value: 'price_crosses', label: 'Price Crosses' },
  { value: 'delta_divergence', label: 'Delta Divergence' },
  { value: 'ofi_threshold', label: 'OFI Threshold' },
  { value: 'absorption', label: 'Absorption' },
  { value: 'funding_spike', label: 'Funding Spike' },
  { value: 'pattern', label: 'Pattern' },
];

const OPERATORS: { value: AlertOperator; label: string }[] = [
  { value: 'gt', label: 'Greater Than' },
  { value: 'lt', label: 'Less Than' },
  { value: 'cross_above', label: 'Crosses Above' },
  { value: 'cross_below', label: 'Crosses Below' },
];

const EXPIRY_OPTIONS: { value: AlertExpiry; label: string }[] = [
  { value: 'once', label: 'Once' },
  { value: 'recurring', label: 'Recurring' },
  { value: 'until_cancelled', label: 'Until Cancelled' },
];

const API_ENDPOINT = '/api/v1/alerts';

// ─── AlertModal ────────────────────────────────────────────────────────────────

export class AlertModal {
  private overlayEl: HTMLDivElement | null = null;
  private modalEl: HTMLDivElement | null = null;

  // Form state
  private condition: AlertCondition = 'price_crosses';
  private value = 0;
  private operator: AlertOperator = 'gt';
  private delivery: AlertDelivery = {
    inApp: true,
    browserPush: false,
    telegram: false,
    email: false,
  };
  private expiry: AlertExpiry = 'once';

  // DOM refs
  private conditionSelect: HTMLSelectElement | null = null;
  private valueInput: HTMLInputElement | null = null;
  private operatorSelect: HTMLSelectElement | null = null;
  private expiryRadios: HTMLInputElement[] = [];
  private deliveryCheckboxes: Map<keyof AlertDelivery, HTMLInputElement> = new Map();
  private errorEl: HTMLDivElement | null = null;

  // Callbacks
  private submitCb?: (data: AlertFormData) => void;

  // ── Public API ───────────────────────────────────────────────────────────

  show(options?: AlertModalOptions): void {
    if (this.overlayEl) this.hide(); // close any existing

    // Apply options
    if (options?.prefillPrice !== undefined) this.value = options.prefillPrice;
    if (options?.condition) this.condition = options.condition;

    this.buildDOM();
    this.bindEvents();

    // Animated entrance
    requestAnimationFrame(() => {
      if (this.overlayEl) this.overlayEl.style.opacity = '1';
      if (this.modalEl) {
        this.modalEl.style.transform = 'translateY(0)';
        this.modalEl.style.opacity = '1';
      }
    });
  }

  hide(): void {
    if (this.overlayEl) {
      this.overlayEl.style.opacity = '0';
      if (this.modalEl) {
        this.modalEl.style.transform = 'translateY(12px)';
        this.modalEl.style.opacity = '0';
      }
      setTimeout(() => {
        this.overlayEl?.remove();
        this.overlayEl = null;
        this.modalEl = null;
      }, 200);
    }
  }

  onSubmit(cb: (data: AlertFormData) => void): void {
    this.submitCb = cb;
  }

  // ── DOM Construction ─────────────────────────────────────────────────────

  private buildDOM(): void {
    // Overlay
    this.overlayEl = document.createElement('div');
    this.overlayEl.className = 'modal-overlay';
    Object.assign(this.overlayEl.style, {
      opacity: '0',
      transition: 'opacity 200ms ease',
    });

    // Modal
    this.modalEl = document.createElement('div');
    this.modalEl.className = 'modal';
    Object.assign(this.modalEl.style, {
      transform: 'translateY(12px)',
      opacity: '0',
      transition: 'transform 200ms ease, opacity 200ms ease',
      maxWidth: '440px',
    });

    // ── Header ─────────────────────────────────────────────────────
    const header = document.createElement('div');
    header.className = 'modal__header';

    const title = document.createElement('div');
    title.className = 'modal__title';
    title.textContent = 'Create Alert';
    header.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'modal__close';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => this.hide());
    header.appendChild(closeBtn);

    this.modalEl.appendChild(header);

    // ── Body ───────────────────────────────────────────────────────
    const body = document.createElement('div');
    body.className = 'modal__body';
    Object.assign(body.style, {
      display: 'flex',
      flexDirection: 'column',
      gap: '16px',
    });

    // Condition
    body.appendChild(this.createFieldGroup('Condition', () => {
      this.conditionSelect = document.createElement('select');
      this.conditionSelect.className = 'select';
      for (const c of CONDITIONS) {
        const opt = document.createElement('option');
        opt.value = c.value;
        opt.textContent = c.label;
        if (c.value === this.condition) opt.selected = true;
        this.conditionSelect.appendChild(opt);
      }
      return this.conditionSelect;
    }));

    // Value
    body.appendChild(this.createFieldGroup('Value', () => {
      this.valueInput = document.createElement('input');
      this.valueInput.className = 'input';
      this.valueInput.type = 'number';
      this.valueInput.step = 'any';
      this.valueInput.placeholder = 'Enter value...';
      if (this.value) this.valueInput.value = this.value.toString();
      return this.valueInput;
    }));

    // Operator
    body.appendChild(this.createFieldGroup('Operator', () => {
      this.operatorSelect = document.createElement('select');
      this.operatorSelect.className = 'select';
      for (const op of OPERATORS) {
        const opt = document.createElement('option');
        opt.value = op.value;
        opt.textContent = op.label;
        if (op.value === this.operator) opt.selected = true;
        this.operatorSelect.appendChild(opt);
      }
      return this.operatorSelect;
    }));

    // Delivery
    body.appendChild(this.createFieldGroup('Delivery', () => {
      const container = document.createElement('div');
      Object.assign(container.style, { display: 'flex', flexDirection: 'column', gap: '8px' });

      const deliveryItems: { key: keyof AlertDelivery; label: string }[] = [
        { key: 'inApp', label: 'In-App Notification' },
        { key: 'browserPush', label: 'Browser Push' },
        { key: 'telegram', label: 'Telegram' },
        { key: 'email', label: 'Email' },
      ];

      for (const item of deliveryItems) {
        const label = document.createElement('label');
        Object.assign(label.style, {
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          cursor: 'pointer',
          fontSize: '13px',
          color: '#e5e7eb',
        });

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = this.delivery[item.key];
        Object.assign(checkbox.style, { accentColor: '#6366f1', cursor: 'pointer' });
        this.deliveryCheckboxes.set(item.key, checkbox);

        const text = document.createElement('span');
        text.textContent = item.label;

        label.appendChild(checkbox);
        label.appendChild(text);
        container.appendChild(label);
      }

      return container;
    }));

    // Expiry
    body.appendChild(this.createFieldGroup('Expiry', () => {
      const container = document.createElement('div');
      Object.assign(container.style, { display: 'flex', gap: '16px' });

      for (const exp of EXPIRY_OPTIONS) {
        const label = document.createElement('label');
        Object.assign(label.style, {
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          cursor: 'pointer',
          fontSize: '13px',
          color: '#e5e7eb',
        });

        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'alert-expiry';
        radio.value = exp.value;
        radio.checked = exp.value === this.expiry;
        Object.assign(radio.style, { accentColor: '#6366f1', cursor: 'pointer' });
        this.expiryRadios.push(radio);

        const text = document.createElement('span');
        text.textContent = exp.label;

        label.appendChild(radio);
        label.appendChild(text);
        container.appendChild(label);
      }

      return container;
    }));

    // Error display
    this.errorEl = document.createElement('div');
    Object.assign(this.errorEl.style, {
      color: '#ef4444',
      fontSize: '12px',
      display: 'none',
      padding: '6px 0',
    });
    body.appendChild(this.errorEl);

    this.modalEl.appendChild(body);

    // ── Footer ─────────────────────────────────────────────────────
    const footer = document.createElement('div');
    footer.className = 'modal__footer';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn--secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => this.hide());
    footer.appendChild(cancelBtn);

    const submitBtn = document.createElement('button');
    submitBtn.className = 'btn btn--primary';
    submitBtn.textContent = 'Create Alert';
    submitBtn.addEventListener('click', () => this.handleSubmit());
    footer.appendChild(submitBtn);

    this.modalEl.appendChild(footer);

    // Assemble
    this.overlayEl.appendChild(this.modalEl);
    document.body.appendChild(this.overlayEl);
  }

  private createFieldGroup(label: string, buildInput: () => HTMLElement): HTMLDivElement {
    const group = document.createElement('div');
    Object.assign(group.style, { display: 'flex', flexDirection: 'column', gap: '4px' });

    const labelEl = document.createElement('label');
    Object.assign(labelEl.style, {
      fontSize: '12px',
      fontWeight: '600',
      color: '#9ca3af',
      textTransform: 'uppercase',
      letterSpacing: '0.03em',
    });
    labelEl.textContent = label;
    group.appendChild(labelEl);

    const input = buildInput();
    group.appendChild(input);

    return group;
  }

  // ── Events ───────────────────────────────────────────────────────────────

  private bindEvents(): void {
    // Overlay click to close
    this.overlayEl?.addEventListener('click', (e) => {
      if (e.target === this.overlayEl) this.hide();
    });

    // ESC to close
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.hide();
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);
  }

  // ── Submit ───────────────────────────────────────────────────────────────

  private handleSubmit(): void {
    // Read form
    this.condition = (this.conditionSelect?.value as AlertCondition) ?? 'price_crosses';
    this.value = parseFloat(this.valueInput?.value ?? '0');
    this.operator = (this.operatorSelect?.value as AlertOperator) ?? 'gt';

    for (const [key, checkbox] of this.deliveryCheckboxes) {
      this.delivery[key] = checkbox.checked;
    }

    const checkedRadio = this.expiryRadios.find((r) => r.checked);
    this.expiry = (checkedRadio?.value as AlertExpiry) ?? 'once';

    // Validate
    const errors = this.validate();
    if (errors.length > 0) {
      this.showError(errors.join('. '));
      return;
    }

    const formData: AlertFormData = {
      condition: this.condition,
      value: this.value,
      operator: this.operator,
      delivery: { ...this.delivery },
      expiry: this.expiry,
    };

    // Submit to API
    this.submitToAPI(formData);

    // Fire callback
    this.submitCb?.(formData);
    this.hide();
  }

  private validate(): string[] {
    const errors: string[] = [];

    if (!this.value && this.value !== 0) {
      errors.push('Value is required');
    }
    if (isNaN(this.value)) {
      errors.push('Value must be a number');
    }

    const hasDelivery = Object.values(this.delivery).some((v) => v);
    if (!hasDelivery) {
      errors.push('Select at least one delivery method');
    }

    return errors;
  }

  private showError(msg: string): void {
    if (!this.errorEl) return;
    this.errorEl.textContent = msg;
    this.errorEl.style.display = 'block';
  }

  private async submitToAPI(data: AlertFormData): Promise<void> {
    try {
      const response = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        console.warn(`[AlertModal] API returned ${response.status}`);
      }
    } catch (err) {
      console.warn('[AlertModal] Failed to submit alert:', err);
    }
  }
}
