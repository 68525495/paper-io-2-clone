/**
 * InputController – supports:
 *  • Virtual joystick (touch drag anywhere on screen) – primary for mobile
 *  • Mouse pointer direction (desktop)
 *  • WASD / Arrow keyboard (desktop)
 */
export class InputController {
  public targetAngle: number = 0;
  public boost: boolean = false;

  /** true when the player is actively touching / dragging */
  public isTouching: boolean = false;

  // Joystick visual elements
  private joystickBase: HTMLDivElement;
  private joystickKnob: HTMLDivElement;
  private joystickZone: HTMLElement;

  // Touch tracking
  private touchId: number | null = null;
  private touchOriginX: number = 0;
  private touchOriginY: number = 0;
  private pendingKnobX: number = 0;
  private pendingKnobY: number = 0;
  private knobAnimationFrame: number | null = null;

  private static readonly DEAD_ZONE_PX = 6;
  private static readonly KNOB_RADIUS_PX = 50;

  constructor(_canvas: HTMLCanvasElement) {
    // Create joystick visual elements
    this.joystickZone = document.getElementById("joystick-zone")!;

    this.joystickBase = document.createElement("div");
    this.joystickBase.className = "joystick-base";
    this.joystickKnob = document.createElement("div");
    this.joystickKnob.className = "joystick-knob";
    this.joystickBase.appendChild(this.joystickKnob);
    this.joystickZone.appendChild(this.joystickBase);

    if ("PointerEvent" in window) this.setupPointerListeners();
    else this.setupTouchListeners();
    this.setupKeyboardListeners();
    this.setupMouseListeners();
  }

  private beginTouch(id: number, clientX: number, clientY: number): boolean {
    if (this.touchId !== null) return false;
    this.touchId = id;
    this.touchOriginX = clientX;
    this.touchOriginY = clientY;
    this.isTouching = true;

    this.joystickBase.style.display = "block";
    this.joystickBase.style.left = `${clientX}px`;
    this.joystickBase.style.top = `${clientY}px`;
    this.joystickKnob.style.transform = "translate3d(-50%, -50%, 0)";
    return true;
  }

  private updateTouch(id: number, clientX: number, clientY: number) {
    if (id !== this.touchId) return;

    const dx = clientX - this.touchOriginX;
    const dy = clientY - this.touchOriginY;
    const distance = Math.hypot(dx, dy);
    if (distance <= InputController.DEAD_ZONE_PX) return;

    // Update gameplay input immediately. Only the decorative knob is batched.
    this.targetAngle = Math.atan2(-dy, dx);
    const clampedDistance = Math.min(
      distance,
      InputController.KNOB_RADIUS_PX
    );
    this.pendingKnobX = (dx / distance) * clampedDistance;
    this.pendingKnobY = (dy / distance) * clampedDistance;
    if (this.knobAnimationFrame !== null) return;

    this.knobAnimationFrame = requestAnimationFrame(() => {
      this.knobAnimationFrame = null;
      this.joystickKnob.style.transform =
        `translate3d(calc(-50% + ${this.pendingKnobX}px), ` +
        `calc(-50% + ${this.pendingKnobY}px), 0)`;
    });
  }

  private endTouch(id: number) {
    if (id !== this.touchId) return;
    this.touchId = null;
    this.isTouching = false;
    this.joystickBase.style.display = "none";
  }

  private setupPointerListeners() {
    const zone = this.joystickZone;

    zone.addEventListener("pointerdown", (event: PointerEvent) => {
      if (event.pointerType === "mouse") return;
      event.preventDefault();
      if (!this.beginTouch(event.pointerId, event.clientX, event.clientY)) return;
      zone.setPointerCapture(event.pointerId);
    });

    zone.addEventListener("pointermove", (event: PointerEvent) => {
      if (event.pointerId !== this.touchId) return;
      const samples = event.getCoalescedEvents?.() ?? [];
      const latest = samples[samples.length - 1] ?? event;
      this.updateTouch(event.pointerId, latest.clientX, latest.clientY);
    });

    const onPointerEnd = (event: PointerEvent) => {
      this.endTouch(event.pointerId);
    };
    zone.addEventListener("pointerup", onPointerEnd);
    zone.addEventListener("pointercancel", onPointerEnd);
    zone.addEventListener("lostpointercapture", onPointerEnd);
  }

  private setupTouchListeners() {
    const zone = this.joystickZone;

    zone.addEventListener("touchstart", (e: TouchEvent) => {
      e.preventDefault();
      const touch = e.changedTouches[0];
      this.beginTouch(touch.identifier, touch.clientX, touch.clientY);
    }, { passive: false });

    zone.addEventListener("touchmove", (e: TouchEvent) => {
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i];
        if (touch.identifier !== this.touchId) continue;
        this.updateTouch(touch.identifier, touch.clientX, touch.clientY);
        break;
      }
    }, { passive: false });

    const onTouchEnd = (e: TouchEvent) => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === this.touchId) {
          this.endTouch(e.changedTouches[i].identifier);
          break;
        }
      }
    };

    zone.addEventListener("touchend", onTouchEnd);
    zone.addEventListener("touchcancel", onTouchEnd);
  }

  private setupMouseListeners() {
    // Desktop mouse: direction from screen center to cursor
    window.addEventListener("mousemove", (e: MouseEvent) => {
      // Only if not on a touch device currently
      if (this.isTouching) return;
      const centerX = window.innerWidth / 2;
      const centerY = window.innerHeight / 2;
      const dx = e.clientX - centerX;
      const dy = -(e.clientY - centerY); // screen Y down → game Y up
      if (dx * dx + dy * dy > 100) {
        this.targetAngle = Math.atan2(dy, dx);
      }
    });
  }

  private setupKeyboardListeners() {
    window.addEventListener("keydown", (e: KeyboardEvent) => {
      const k = e.key ? e.key.toLowerCase() : "";
      const code = e.code ? e.code.toLowerCase() : "";

      if (k === "w" || k === "arrowup" || code === "keyw" || code === "arrowup") {
        this.targetAngle = Math.PI / 2;
      } else if (k === "s" || k === "arrowdown" || code === "keys" || code === "arrowdown") {
        this.targetAngle = -Math.PI / 2;
      } else if (k === "a" || k === "arrowleft" || code === "keya" || code === "arrowleft") {
        this.targetAngle = Math.PI;
      } else if (k === "d" || k === "arrowright" || code === "keyd" || code === "arrowright") {
        this.targetAngle = 0;
      } else if (k === " " || code === "space") {
        this.boost = true;
      }
    });

    window.addEventListener("keyup", (e: KeyboardEvent) => {
      const k = e.key ? e.key.toLowerCase() : "";
      const code = e.code ? e.code.toLowerCase() : "";
      if (k === " " || code === "space") {
        this.boost = false;
      }
    });
  }

  destroy() {
    if (this.knobAnimationFrame !== null) {
      cancelAnimationFrame(this.knobAnimationFrame);
      this.knobAnimationFrame = null;
    }
  }
}
