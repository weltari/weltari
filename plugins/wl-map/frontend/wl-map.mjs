// <wl-map> — the default map renderer, shipped as a PLUGIN by decree
// (UI Spec §1.8, FINAL item 6): it dogfoods the plugin contract by consuming
// ONLY the documented public surface — the SSE event stream (/v1/events),
// painter.completed images via /v1/images/*, sublocation.changed +
// sublocation.materialized pins/fog, and the POST /v1/commands/explore
// command. Zero imports, zero build step, zero private access: a community
// plugin can replace this file wholesale.
//
// Canvas 2D tile + fog layer, DOM overlay pins/spinner/labels. Pins anchor to
// world coordinates (unit square) — a repaint or resize never moves a pin.
// Fog contract (UI Spec §1.8): explored = materialized; unexplored squares
// have very faint borders, a translucent overlay on hover, and a centered
// "Unexplored Area" + Explore on click; a running materialization shows a
// spinning loader over a grey overlay on its target square. Explore reveals
// and background materialization reveals share ONE render path: the
// sublocation.materialized event.

const GRID = 8; // MAP_FOG_GRID — the documented 8×8 fog-grid contract

class WlMap extends HTMLElement {
  constructor() {
    super();
    this._pins = new Map(); // sublocation_id -> {name, x, y, current}
    this._explored = new Set(); // 'col,row' revealed squares
    this._pending = new Set(); // 'col,row' materialize in flight (spinner)
    this._selected = null; // 'col,row' clicked unexplored square
    this._hovered = null; // 'col,row' under the pointer
    this._tile = null; // HTMLImageElement of the latest painter composite
    this._source = null;
  }

  connectedCallback() {
    this._worldId = this.getAttribute('world-id') ?? 'w1';
    this._actorId = this.getAttribute('actor-id') ?? 'user:owner';
    this._imageId = this.getAttribute('image-id') ?? `map:${this._worldId}`;

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

    // The spinner keyframes ride inside the element so the plugin stays a
    // single zero-import file; the duration stays a --wl-* token.
    const style = document.createElement('style');
    style.textContent =
      '@keyframes wl-map-spin { to { transform: rotate(360deg); } }';
    this.appendChild(style);

    this._canvas.addEventListener('mousemove', (mouse) => {
      const square = this._squareAt(mouse);
      const key = square === null ? null : `${square.col},${square.row}`;
      if (key !== this._hovered) {
        this._hovered = key;
        this._paint();
      }
    });
    this._canvas.addEventListener('mouseleave', () => {
      if (this._hovered !== null) {
        this._hovered = null;
        this._paint();
      }
    });
    this._canvas.addEventListener('click', (mouse) => {
      const square = this._squareAt(mouse);
      if (square === null) return;
      const key = `${square.col},${square.row}`;
      // Clicks on explored ground do nothing here: pins carry the jumps and
      // Flow-B click classification needs a VLM (a later milestone).
      if (this._explored.has(key) || this._pending.has(key)) return;
      this._selected = this._selected === key ? null : key;
      this._paint();
    });

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
    // THE reveal path (UI Spec §1.8) — Explore clicks and background
    // materialization land here identically: square explored, pin dropped,
    // spinner cleared.
    if (
      event.type === 'sublocation.materialized' &&
      event.payload &&
      event.payload.square &&
      event.payload.map_position &&
      typeof event.payload.sublocation_id === 'string'
    ) {
      const key = `${Number(event.payload.square.col)},${Number(event.payload.square.row)}`;
      this._explored.add(key);
      this._pending.delete(key);
      if (this._selected === key) this._selected = null;
      const current = this._pins.get(event.payload.sublocation_id);
      this._pins.set(event.payload.sublocation_id, {
        name: String(event.payload.name ?? event.payload.sublocation_id),
        x: Number(event.payload.map_position.x),
        y: Number(event.payload.map_position.y),
        current: current ? current.current : false,
      });
      this._paint();
    }
    // A parked materialize job never completes — stop its spinner instead of
    // spinning forever (job.failed keeps it: the runner will retry).
    if (
      event.type === 'job.parked' &&
      event.payload &&
      event.payload.job_type === 'materialize'
    ) {
      this._pending.clear();
      this._paint();
    }
  }

  _squareAt(mouse) {
    const rect = this._canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const col = Math.floor(((mouse.clientX - rect.left) / rect.width) * GRID);
    const row = Math.floor(((mouse.clientY - rect.top) / rect.height) * GRID);
    if (col < 0 || col >= GRID || row < 0 || row >= GRID) return null;
    return { col, row };
  }

  _explore(square) {
    const key = `${square.col},${square.row}`;
    this._pending.add(key);
    this._selected = null;
    this._paint();
    fetch('/v1/commands/explore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        world_id: this._worldId,
        actor_id: this._actorId,
        square,
      }),
    })
      .then((response) => {
        // A refusal never reveals: drop the spinner, the fog stays honest.
        if (!response.ok) {
          this._pending.delete(key);
          this._paint();
        }
      })
      .catch(() => {
        this._pending.delete(key);
        this._paint();
      });
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
    const cellW = width / GRID;
    const cellH = height / GRID;
    const styles = getComputedStyle(this);
    const token = (name, fallback) =>
      styles.getPropertyValue(name).trim() || fallback;

    // Tile layer: the latest painter composite, else a plain field.
    ctx.fillStyle = '#10131a';
    ctx.fillRect(0, 0, width, height);
    if (this._tile) ctx.drawImage(this._tile, 0, 0, width, height);

    // Fog layer (UI Spec §1.8): unexplored squares are veiled; explored =
    // materialized shows the ground through.
    ctx.fillStyle = token('--wl-map-fog-fill', 'rgba(10,11,15,0.55)');
    for (let col = 0; col < GRID; col++) {
      for (let row = 0; row < GRID; row++) {
        if (!this._explored.has(`${col},${row}`)) {
          ctx.fillRect(col * cellW, row * cellH, cellW, cellH);
        }
      }
    }

    // Very faint square borders over the whole grid.
    ctx.strokeStyle = token('--wl-map-fog-border', 'rgba(255,255,255,0.07)');
    ctx.lineWidth = 1;
    for (let i = 1; i < GRID; i++) {
      ctx.beginPath();
      ctx.moveTo(cellW * i, 0);
      ctx.lineTo(cellW * i, height);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, cellH * i);
      ctx.lineTo(width, cellH * i);
      ctx.stroke();
    }

    // Hover overlay on unexplored squares (translucent white).
    if (this._hovered !== null && !this._explored.has(this._hovered)) {
      const [col, row] = this._hovered.split(',').map(Number);
      ctx.fillStyle = token('--wl-map-hover-fill', 'rgba(255,255,255,0.12)');
      ctx.fillRect(col * cellW, row * cellH, cellW, cellH);
    }

    // ---- DOM overlay: pins, the Explore prompt, spinner squares ----
    this._overlay.replaceChildren();

    const squareBox = (key) => {
      const [col, row] = key.split(',').map(Number);
      const el = document.createElement('div');
      el.style.position = 'absolute';
      el.style.left = `${(col / GRID) * 100}%`;
      el.style.top = `${(row / GRID) * 100}%`;
      el.style.width = `${100 / GRID}%`;
      el.style.height = `${100 / GRID}%`;
      return el;
    };

    // Spinner over each in-flight materialization (grey veil + spinning ring,
    // continuously animated for the whole generation window — §1.14).
    for (const key of this._pending) {
      const box = squareBox(key);
      box.style.display = 'flex';
      box.style.alignItems = 'center';
      box.style.justifyContent = 'center';
      box.style.background =
        'var(--wl-map-pending-fill, rgba(120,120,120,0.35))';
      const ring = document.createElement('div');
      ring.style.width = '38%';
      ring.style.height = '38%';
      ring.style.maxWidth = '2.2rem';
      ring.style.maxHeight = '2.2rem';
      ring.style.border = '3px solid var(--wl-border, rgba(255,255,255,0.25))';
      ring.style.borderTopColor = 'var(--wl-accent, #d8a748)';
      ring.style.borderRadius = '50%';
      ring.style.animation =
        'wl-map-spin var(--wl-map-spinner-duration, 1.1s) linear infinite';
      box.appendChild(ring);
      box.setAttribute('data-wl-map-pending', key);
      this._overlay.appendChild(box);
    }

    // The clicked unexplored square: "Unexplored Area" + Explore.
    if (this._selected !== null && !this._pending.has(this._selected)) {
      const key = this._selected;
      const box = squareBox(key);
      box.style.display = 'flex';
      box.style.flexDirection = 'column';
      box.style.alignItems = 'center';
      box.style.justifyContent = 'center';
      box.style.gap = '0.25rem';
      box.style.background = 'var(--wl-map-hover-fill, rgba(255,255,255,0.12))';
      box.style.pointerEvents = 'auto';
      const label = document.createElement('span');
      label.textContent = 'Unexplored Area';
      label.style.fontFamily = 'var(--wl-font-ui, sans-serif)';
      label.style.fontSize = '0.62rem';
      label.style.color = 'var(--wl-text, #e8e4da)';
      label.style.textAlign = 'center';
      const button = document.createElement('button');
      button.textContent = 'Explore';
      button.style.fontFamily = 'var(--wl-font-ui, sans-serif)';
      button.style.fontSize = '0.68rem';
      button.style.padding = '0.15rem 0.55rem';
      button.style.borderRadius = '999px';
      button.style.border = '1px solid var(--wl-accent, #d8a748)';
      button.style.background = 'var(--wl-panel, #1e2128)';
      button.style.color = 'var(--wl-accent, #d8a748)';
      button.style.cursor = 'pointer';
      button.addEventListener('click', (click) => {
        click.stopPropagation();
        const [col, row] = key.split(',').map(Number);
        this._explore({ col, row });
      });
      box.appendChild(label);
      box.appendChild(button);
      this._overlay.appendChild(box);
    }

    // DOM overlay pins, anchored to world coordinates. A pin click is the
    // map-jump surface (UI Spec §1.14): the plugin dispatches a bubbling
    // wl-map-jump CustomEvent (detail = MapJumpDetail in @weltari/protocol)
    // and the HOST answers with a masked scene transition — the plugin never
    // opens scenes itself (documented surface only).
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
