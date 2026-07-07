// <wl-map> — the default map renderer, shipped as a PLUGIN by decree
// (UI Spec §1.8, FINAL item 6): it dogfoods the plugin contract by consuming
// ONLY the documented public surface — the SSE event stream (/v1/events),
// painter.completed images via /v1/images/*, and sublocation.changed
// map_position pins. Zero imports, zero build step, zero private access:
// a community plugin can replace this file wholesale.
//
// Canvas 2D tile layer + DOM overlay pins. Pins anchor to world coordinates
// (unit square) — a repaint or resize never moves a pin relative to the world.

const GRID = 8; // fog grid squares per side (visual placeholder scale)

class WlMap extends HTMLElement {
  constructor() {
    super();
    this._pins = new Map(); // sublocation_id -> {name, x, y, current}
    this._tile = null; // HTMLImageElement of the latest painter composite
    this._source = null;
  }

  connectedCallback() {
    const worldId = this.getAttribute('world-id') ?? 'w1';
    this._imageId = this.getAttribute('image-id') ?? `map:${worldId}`;

    this.style.position = 'relative';
    this.style.display = 'block';
    this.style.background = 'var(--wl-panel, #1e2128)';
    this.style.border = '1px solid var(--wl-border, rgba(255,255,255,0.12))';
    this.style.borderRadius = 'var(--wl-radius, 10px)';
    this.style.overflow = 'hidden';

    this._canvas = document.createElement('canvas');
    this._canvas.style.width = '100%';
    this._canvas.style.height = '100%';
    this._canvas.style.display = 'block';
    this.appendChild(this._canvas);

    this._overlay = document.createElement('div');
    this._overlay.style.position = 'absolute';
    this._overlay.style.inset = '0';
    this._overlay.style.pointerEvents = 'none';
    this.appendChild(this._overlay);

    this._resizeObserver = new ResizeObserver(() => this._paint());
    this._resizeObserver.observe(this);

    // The documented surface: one public stream, replayed from the log.
    this._source = new EventSource('/v1/events');
    this._source.addEventListener('event', (message) => {
      let event;
      try {
        event = JSON.parse(message.data);
      } catch {
        return; // malformed frames are dropped, never rendered
      }
      this._applyEvent(event);
    });
  }

  disconnectedCallback() {
    if (this._source) this._source.close();
    if (this._resizeObserver) this._resizeObserver.disconnect();
  }

  _applyEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (
      event.type === 'painter.completed' &&
      event.payload &&
      event.payload.image_id === this._imageId &&
      typeof event.payload.path === 'string'
    ) {
      const image = new Image();
      image.onload = () => {
        this._tile = image;
        this._paint();
      };
      image.src = `/v1/images/${event.payload.path}`;
    }
    if (
      event.type === 'sublocation.changed' &&
      event.payload &&
      event.payload.map_position &&
      typeof event.payload.sublocation_id === 'string'
    ) {
      for (const pin of this._pins.values()) pin.current = false;
      this._pins.set(event.payload.sublocation_id, {
        name: String(event.payload.name ?? event.payload.sublocation_id),
        x: Number(event.payload.map_position.x),
        y: Number(event.payload.map_position.y),
        current: true,
      });
      this._paint();
    }
  }

  _paint() {
    const canvas = this._canvas;
    if (!canvas) return;
    const width = this.clientWidth || 480;
    const height = this.clientHeight || 320;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Tile layer: the latest painter composite, else a plain unexplored field.
    ctx.fillStyle = '#10131a';
    ctx.fillRect(0, 0, width, height);
    if (this._tile) ctx.drawImage(this._tile, 0, 0, width, height);

    // Grid fog placeholder (UI Spec §1.8): unexplored squares get very faint
    // white borders. Real fog state arrives with the map milestone part 2.
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    for (let i = 1; i < GRID; i++) {
      const x = (width / GRID) * i;
      const y = (height / GRID) * i;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    // DOM overlay pins, anchored to world coordinates. A pin click is the
    // map-jump surface (UI Spec §1.14): the plugin dispatches a bubbling
    // wl-map-jump CustomEvent (detail = MapJumpDetail in @weltari/protocol)
    // and the HOST answers with a masked scene transition — the plugin never
    // opens scenes itself (documented surface only).
    this._overlay.replaceChildren();
    for (const [id, pin] of this._pins) {
      const el = document.createElement('div');
      el.style.position = 'absolute';
      el.style.left = `${pin.x * 100}%`;
      el.style.top = `${pin.y * 100}%`;
      el.style.transform = 'translate(-50%, -100%)';
      el.style.fontFamily = 'var(--wl-font-ui, sans-serif)';
      el.style.fontSize = '0.72rem';
      el.style.color = pin.current
        ? 'var(--wl-accent, #d8a748)'
        : 'var(--wl-text-dim, #9a958a)';
      el.style.textAlign = 'center';
      el.textContent = `${pin.current ? '◉' : '○'}\n${pin.name}`;
      el.style.whiteSpace = 'pre';
      el.title = `Jump to ${pin.name}`;
      el.style.pointerEvents = 'auto';
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => {
        this.dispatchEvent(
          new CustomEvent('wl-map-jump', {
            bubbles: true,
            composed: true,
            detail: { sublocation_id: id, name: pin.name },
          }),
        );
      });
      this._overlay.appendChild(el);
    }
  }
}

if (!customElements.get('wl-map')) {
  customElements.define('wl-map', WlMap);
}
