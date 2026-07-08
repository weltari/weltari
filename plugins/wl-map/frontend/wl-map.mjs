// <wl-map> — the default map renderer, shipped as a PLUGIN by decree
// (UI Spec §1.8, FINAL item 6): it dogfoods the plugin contract by consuming
// ONLY the documented public surface — the SSE event stream (/v1/events),
// painter.completed images via /v1/images/*, sublocation.changed +
// sublocation.materialized + sublocation.created pins/fog, and the POST
// /v1/commands/explore + /v1/commands/map-edit commands. Zero imports, zero
// build step, zero private access: a community plugin can replace this file
// wholesale.
//
// M5 part 2 (Rev 4 §14 Flow A): the pen control toggles draw mode — the user
// draws a freehand lasso on explored ground, types an intent, and the plugin
// POSTs /v1/commands/map-edit. The drawn region renders LOCKED (grey veil +
// spinner, keyed data-wl-map-lock) from the durable map_edit.requested event
// until the edit's painter.completed (job_key painter:map:<w>:edit-<id>) or
// a job.parked carrying the edit's job_key arrives.
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
    this._drawMode = false; // the pen control (Flow A)
    this._stroke = null; // active lasso points [{x,y} unit coords]
    this._draft = null; // finished lasso awaiting its intent text
    this._locks = new Map(); // edit_id -> {points} regions locked in flight
    this._footprints = new Map(); // sublocation_id -> [{x,y}] Flow-A shapes
    this._clicks = new Map(); // click_id -> {x,y} Flow-B classify in flight
    this._discovery = null; // {name, description} transient outcome card
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
      if (this._drawMode) {
        if (this._stroke !== null) {
          const point = this._unitAt(mouse);
          const last = this._stroke[this._stroke.length - 1];
          if (
            point !== null &&
            (last === undefined ||
              Math.hypot(point.x - last.x, point.y - last.y) > 0.004)
          ) {
            if (this._stroke.length < 128) this._stroke.push(point);
            this._paint();
          }
        }
        return;
      }
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
    // The lasso (Flow A): mousedown starts a stroke in draw mode, mousemove
    // (above) collects it, mouseup closes it into a draft awaiting intent.
    this._canvas.addEventListener('mousedown', (mouse) => {
      if (!this._drawMode) return;
      const point = this._unitAt(mouse);
      if (point === null) return;
      this._stroke = [point];
      this._draft = null;
      this._hideIntentBox();
      this._paint();
    });
    this._canvas.addEventListener('mouseup', () => {
      if (!this._drawMode || this._stroke === null) return;
      const points = this._stroke;
      this._stroke = null;
      if (points.length >= 3) {
        this._draft = points;
        this._showIntentBox();
      }
      this._paint();
    });
    this._canvas.addEventListener('click', (mouse) => {
      if (this._drawMode) return; // the pen owns clicks while active
      const square = this._squareAt(mouse);
      if (square === null) return;
      const key = `${square.col},${square.row}`;
      if (this._pending.has(key)) return;
      // Flow B (Rev 4 §14): a click on explored ground. Inside a known
      // footprint or radius = enter that sublocation, zero model calls;
      // outside all radii = ask the server to classify the spot.
      if (this._explored.has(key)) {
        if (this._discovery !== null) {
          this._discovery = null; // any map click dismisses the card
          this._paint();
        }
        const point = this._unitAt(mouse);
        if (point === null) return;
        const near = this._sublocationNear(point);
        if (near !== null) {
          this.dispatchEvent(
            new CustomEvent('wl-map-jump', {
              bubbles: true,
              composed: true,
              detail: { sublocation_id: near.id, name: near.name },
            }),
          );
          return;
        }
        this._classify(point);
        return;
      }
      this._selected = this._selected === key ? null : key;
      this._paint();
    });

    // The pen control (wireframe 08's right-edge pen; UI Spec §1.8 lasso).
    this._penButton = document.createElement('button');
    this._penButton.textContent = '✎';
    this._penButton.title = 'Draw a region to edit the map';
    this._penButton.setAttribute('data-wl-map-pen', '');
    const pen = this._penButton.style;
    pen.position = 'absolute';
    pen.right = '0.5rem';
    pen.top = '50%';
    pen.transform = 'translateY(-50%)';
    pen.width = '2rem';
    pen.height = '2rem';
    pen.borderRadius = '999px';
    pen.border = '1px solid var(--wl-border, rgba(255,255,255,0.25))';
    pen.background = 'var(--wl-panel, #1e2128)';
    pen.color = 'var(--wl-text-dim, #9a958a)';
    pen.cursor = 'pointer';
    pen.fontSize = '0.95rem';
    pen.zIndex = '2';
    this._penButton.addEventListener('click', () => {
      this._drawMode = !this._drawMode;
      this._stroke = null;
      this._draft = null;
      this._hideIntentBox();
      this._canvas.style.cursor = this._drawMode ? 'crosshair' : '';
      this._paint();
    });
    this.appendChild(this._penButton);

    // The intent box (Flow A step 1: draw + speak intent). One persistent
    // element — SSE repaints must not eat the user's half-typed text.
    this._intentBox = document.createElement('div');
    const box = this._intentBox.style;
    box.position = 'absolute';
    box.left = '50%';
    box.bottom = '0.75rem';
    box.transform = 'translateX(-50%)';
    box.display = 'none';
    box.gap = '0.35rem';
    box.padding = '0.4rem';
    box.borderRadius = 'var(--wl-radius, 10px)';
    box.border = '1px solid var(--wl-border, rgba(255,255,255,0.25))';
    box.background = 'var(--wl-panel, #1e2128)';
    box.zIndex = '3';
    this._intentInput = document.createElement('input');
    this._intentInput.type = 'text';
    this._intentInput.placeholder = 'What should be here?';
    this._intentInput.maxLength = 500;
    this._intentInput.setAttribute('data-wl-map-intent', '');
    const input = this._intentInput.style;
    input.width = '14rem';
    input.fontFamily = 'var(--wl-font-ui, sans-serif)';
    input.fontSize = '0.75rem';
    input.padding = '0.25rem 0.5rem';
    input.borderRadius = '999px';
    input.border = '1px solid var(--wl-border, rgba(255,255,255,0.25))';
    input.background = 'transparent';
    input.color = 'var(--wl-text, #e8e4da)';
    const submit = document.createElement('button');
    submit.textContent = 'Create';
    submit.setAttribute('data-wl-map-intent-submit', '');
    const sub = submit.style;
    sub.fontFamily = 'var(--wl-font-ui, sans-serif)';
    sub.fontSize = '0.72rem';
    sub.padding = '0.2rem 0.6rem';
    sub.borderRadius = '999px';
    sub.border = '1px solid var(--wl-accent, #d8a748)';
    sub.background = 'var(--wl-panel, #1e2128)';
    sub.color = 'var(--wl-accent, #d8a748)';
    sub.cursor = 'pointer';
    submit.addEventListener('click', () => this._submitEdit());
    this._intentInput.addEventListener('keydown', (key) => {
      if (key.key === 'Enter') this._submitEdit();
      if (key.key === 'Escape') {
        this._draft = null;
        this._hideIntentBox();
        this._paint();
      }
    });
    const cancel = document.createElement('button');
    cancel.textContent = '✕';
    cancel.title = 'Discard the drawn region';
    const can = cancel.style;
    can.fontFamily = 'var(--wl-font-ui, sans-serif)';
    can.fontSize = '0.72rem';
    can.padding = '0.2rem 0.45rem';
    can.borderRadius = '999px';
    can.border = '1px solid var(--wl-border, rgba(255,255,255,0.25))';
    can.background = 'transparent';
    can.color = 'var(--wl-text-dim, #9a958a)';
    can.cursor = 'pointer';
    cancel.addEventListener('click', () => {
      this._draft = null;
      this._hideIntentBox();
      this._paint();
    });
    this._intentBox.appendChild(this._intentInput);
    this._intentBox.appendChild(submit);
    this._intentBox.appendChild(cancel);
    this.appendChild(this._intentBox);

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
      // A completed edit paint releases its region lock (Flow A step 6).
      const editPrefix = `painter:${this._imageId}:edit-`;
      if (
        typeof event.payload.job_key === 'string' &&
        event.payload.job_key.startsWith(editPrefix)
      ) {
        this._locks.delete(event.payload.job_key.slice(editPrefix.length));
        this._paint();
      }
    }
    // Flow A durable intent: lock the drawn region (also what a reconnect
    // replays — the optimistic local lock under the same edit_id dedupes).
    if (
      event.type === 'map_edit.requested' &&
      event.payload &&
      Array.isArray(event.payload.points) &&
      typeof event.payload.edit_id === 'string'
    ) {
      this._locks.set(event.payload.edit_id, { points: event.payload.points });
      this._paint();
    }
    // Flow A step 6: the created sublocation's pin at the mask centroid
    // (its footprint joins the Flow-B hit-test surface).
    if (
      event.type === 'sublocation.created' &&
      event.payload &&
      event.payload.map_position &&
      typeof event.payload.sublocation_id === 'string'
    ) {
      const current = this._pins.get(event.payload.sublocation_id);
      this._pins.set(event.payload.sublocation_id, {
        name: String(event.payload.name ?? event.payload.sublocation_id),
        x: Number(event.payload.map_position.x),
        y: Number(event.payload.map_position.y),
        current: current ? current.current : false,
      });
      if (Array.isArray(event.payload.footprint)) {
        this._footprints.set(
          event.payload.sublocation_id,
          event.payload.footprint,
        );
      }
      this._paint();
    }
    // Flow B outcome: a persistent spawn drops a pin (and auto-jumps if this
    // client asked); a transient one shows the discovery card once.
    if (
      event.type === 'map_click.resolved' &&
      event.payload &&
      typeof event.payload.click_id === 'string'
    ) {
      const mine = this._clicks.delete(event.payload.click_id);
      if (
        event.payload.outcome === 'created' &&
        typeof event.payload.sublocation_id === 'string' &&
        event.payload.point
      ) {
        this._pins.set(event.payload.sublocation_id, {
          name: String(event.payload.name ?? event.payload.sublocation_id),
          x: Number(event.payload.point.x),
          y: Number(event.payload.point.y),
          current: false,
        });
        if (mine) {
          this.dispatchEvent(
            new CustomEvent('wl-map-jump', {
              bubbles: true,
              composed: true,
              detail: {
                sublocation_id: event.payload.sublocation_id,
                name: String(
                  event.payload.name ?? event.payload.sublocation_id,
                ),
              },
            }),
          );
        }
      } else if (event.payload.outcome === 'transient' && mine) {
        this._discovery = {
          name: String(event.payload.name ?? ''),
          description: String(event.payload.description ?? ''),
        };
      }
      this._paint();
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
    // A parked edit never composites — release its region lock cleanly
    // (criteria e: provider failures park, no half-visible pixels ever).
    if (
      event.type === 'job.parked' &&
      event.payload &&
      typeof event.payload.job_key === 'string'
    ) {
      const key = event.payload.job_key;
      const editJob = `map_edit:${this._worldId}:`;
      const editPaint = `painter:${this._imageId}:edit-`;
      let released = null;
      if (key.startsWith(editJob)) released = key.slice(editJob.length);
      if (key.startsWith(editPaint)) released = key.slice(editPaint.length);
      if (released !== null && this._locks.delete(released)) this._paint();
      // A parked classify never resolves — clear its pulse marker.
      const clickJob = `map_click:${this._worldId}:`;
      if (
        key.startsWith(clickJob) &&
        this._clicks.delete(key.slice(clickJob.length))
      ) {
        this._paint();
      }
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

  _unitAt(mouse) {
    const rect = this._canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = (mouse.clientX - rect.left) / rect.width;
    const y = (mouse.clientY - rect.top) / rect.height;
    return {
      x: Math.min(1, Math.max(0, x)),
      y: Math.min(1, Math.max(0, y)),
    };
  }

  /** The Flow-B radius rule — same numbers as the engine (documented
   * contract, like GRID): a footprint containing the point wins, else the
   * nearest pin within half a fog square. */
  _sublocationNear(point) {
    const RADIUS = 1 / (2 * GRID);
    for (const [id, polygon] of this._footprints) {
      let inside = false;
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const a = polygon[i];
        const b = polygon[j];
        if (
          a.y > point.y !== b.y > point.y &&
          point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
        ) {
          inside = !inside;
        }
      }
      if (inside) {
        const pin = this._pins.get(id);
        return { id, name: pin ? pin.name : id };
      }
    }
    let best = null;
    let bestDistance = RADIUS;
    for (const [id, pin] of this._pins) {
      const distance = Math.hypot(pin.x - point.x, pin.y - point.y);
      if (distance <= bestDistance) {
        best = { id, name: pin.name };
        bestDistance = distance;
      }
    }
    return best;
  }

  _classify(point) {
    const clickId = `c-${crypto.randomUUID().slice(0, 8)}`;
    // Optimistic pulse marker, honest like every spinner: a refusal clears.
    this._clicks.set(clickId, point);
    this._paint();
    fetch('/v1/commands/map-click', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        world_id: this._worldId,
        actor_id: this._actorId,
        point,
        request_id: clickId,
      }),
    })
      .then(async (response) => {
        if (!response.ok) {
          this._clicks.delete(clickId);
          this._paint();
          return;
        }
        // The server is the radius authority: it may answer `enter` for a
        // sublocation this renderer missed — jump instead of waiting.
        const body = await response.json();
        if (body && body.outcome === 'enter' && body.sublocation_id) {
          this._clicks.delete(clickId);
          this._paint();
          this.dispatchEvent(
            new CustomEvent('wl-map-jump', {
              bubbles: true,
              composed: true,
              detail: {
                sublocation_id: String(body.sublocation_id),
                name: String(body.name ?? body.sublocation_id),
              },
            }),
          );
        }
      })
      .catch(() => {
        this._clicks.delete(clickId);
        this._paint();
      });
  }

  _showIntentBox() {
    this._intentBox.style.display = 'flex';
    this._intentInput.value = '';
    this._intentInput.focus();
  }

  _hideIntentBox() {
    this._intentBox.style.display = 'none';
  }

  _submitEdit() {
    const intent = this._intentInput.value.trim();
    if (this._draft === null || intent.length === 0) return;
    const points = this._draft;
    const editId = `e-${crypto.randomUUID().slice(0, 8)}`;
    this._draft = null;
    this._hideIntentBox();
    // Optimistic lock, honest like the Explore spinner: a refusal unlocks —
    // only the durable map_edit.requested (replayed on reconnect) keeps it.
    this._locks.set(editId, { points });
    this._paint();
    fetch('/v1/commands/map-edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        world_id: this._worldId,
        actor_id: this._actorId,
        points,
        intent,
        request_id: editId,
      }),
    })
      .then((response) => {
        if (!response.ok) {
          this._locks.delete(editId);
          this._paint();
        }
      })
      .catch(() => {
        this._locks.delete(editId);
        this._paint();
      });
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

    // Locked regions (Flow A): grey veil + dashed outline while the edit's
    // GM form + painter job are in flight.
    const tracePolygon = (points) => {
      ctx.beginPath();
      points.forEach((p, i) => {
        const px = Number(p.x) * width;
        const py = Number(p.y) * height;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.closePath();
    };
    for (const lock of this._locks.values()) {
      tracePolygon(lock.points);
      ctx.fillStyle = token('--wl-map-pending-fill', 'rgba(120,120,120,0.35)');
      ctx.fill();
      ctx.strokeStyle = token('--wl-accent', '#d8a748');
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // The active lasso stroke / the finished draft awaiting its intent.
    const sketch = this._stroke ?? this._draft;
    if (sketch !== null && sketch.length >= 2) {
      tracePolygon(sketch);
      ctx.fillStyle = token('--wl-map-hover-fill', 'rgba(255,255,255,0.12)');
      ctx.fill();
      ctx.strokeStyle = token('--wl-accent', '#d8a748');
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Pen control active state (persistent element — not overlay-managed).
    if (this._penButton) {
      this._penButton.style.color = this._drawMode
        ? 'var(--wl-accent, #d8a748)'
        : 'var(--wl-text-dim, #9a958a)';
      this._penButton.style.borderColor = this._drawMode
        ? 'var(--wl-accent, #d8a748)'
        : 'var(--wl-border, rgba(255,255,255,0.25))';
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

    // A small spinner at each locked region's centroid (DOM-samplable:
    // data-wl-map-lock=<edit_id>).
    for (const [editId, lock] of this._locks) {
      let cx = 0;
      let cy = 0;
      for (const p of lock.points) {
        cx += Number(p.x);
        cy += Number(p.y);
      }
      cx /= lock.points.length;
      cy /= lock.points.length;
      const ring = document.createElement('div');
      ring.style.position = 'absolute';
      ring.style.left = `${cx * 100}%`;
      ring.style.top = `${cy * 100}%`;
      ring.style.transform = 'translate(-50%, -50%)';
      ring.style.width = '1.4rem';
      ring.style.height = '1.4rem';
      ring.style.border = '3px solid var(--wl-border, rgba(255,255,255,0.25))';
      ring.style.borderTopColor = 'var(--wl-accent, #d8a748)';
      ring.style.borderRadius = '50%';
      ring.style.animation =
        'wl-map-spin var(--wl-map-spinner-duration, 1.1s) linear infinite';
      ring.setAttribute('data-wl-map-lock', editId);
      this._overlay.appendChild(ring);
    }

    // A pulse ring at each classify-in-flight click (Flow B; DOM-samplable:
    // data-wl-map-click=<click_id>).
    for (const [clickId, point] of this._clicks) {
      const ring = document.createElement('div');
      ring.style.position = 'absolute';
      ring.style.left = `${point.x * 100}%`;
      ring.style.top = `${point.y * 100}%`;
      ring.style.transform = 'translate(-50%, -50%)';
      ring.style.width = '1.1rem';
      ring.style.height = '1.1rem';
      ring.style.border = '3px solid var(--wl-border, rgba(255,255,255,0.25))';
      ring.style.borderTopColor = 'var(--wl-accent, #d8a748)';
      ring.style.borderRadius = '50%';
      ring.style.animation =
        'wl-map-spin var(--wl-map-spinner-duration, 1.1s) linear infinite';
      ring.setAttribute('data-wl-map-click', clickId);
      this._overlay.appendChild(ring);
    }

    // The transient discovery card (Flow B: resolves and vanishes — the map
    // shows it once, any click dismisses it, nothing persists).
    if (this._discovery !== null) {
      const card = document.createElement('div');
      card.setAttribute('data-wl-map-discovery', '');
      card.style.position = 'absolute';
      card.style.left = '50%';
      card.style.bottom = '3rem';
      card.style.transform = 'translateX(-50%)';
      card.style.maxWidth = '70%';
      card.style.padding = '0.5rem 0.75rem';
      card.style.borderRadius = 'var(--wl-radius, 10px)';
      card.style.border = '1px solid var(--wl-accent, #d8a748)';
      card.style.background = 'var(--wl-panel, #1e2128)';
      card.style.fontFamily = 'var(--wl-font-ui, sans-serif)';
      card.style.pointerEvents = 'auto';
      card.style.cursor = 'pointer';
      const title = document.createElement('div');
      title.textContent = this._discovery.name;
      title.style.fontSize = '0.78rem';
      title.style.color = 'var(--wl-accent, #d8a748)';
      const body = document.createElement('div');
      body.textContent = this._discovery.description;
      body.style.fontSize = '0.7rem';
      body.style.color = 'var(--wl-text, #e8e4da)';
      card.appendChild(title);
      card.appendChild(body);
      card.addEventListener('click', () => {
        this._discovery = null;
        this._paint();
      });
      this._overlay.appendChild(card);
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
