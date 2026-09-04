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

  constructor(_canvas: HTMLCanvasElement) {
    // Create joystick visual elements
    this.joystickZone = document.getElementById("joystick-zone")!;

    this.joystickBase = document.createElement("div");
    this.joystickBase.className = "joystick-base";
    this.joystickKnob = document.createElement("div");
    this.joystickKnob.className = "joystick-knob";
    this.joystickBase.appendChild(this.joystickKnob);
    this.joystickZone.appendChild(this.joystickBase);

    this.setupTouchListeners();
    this.setupKeyboardListeners();
    this.setupMouseListeners();
  }

  private setupTouchListeners() {
    const zone = this.joystickZone;

    zone.addEventListener("touchstart", (e: TouchEvent) => {
      e.preventDefault();
      if (this.touchId !== null) return; // already tracking a finger
      const touch = e.changedTouches[0];
      this.touchId = touch.identifier;
      this.touchOriginX = touch.clientX;
      this.touchOriginY = touch.clientY;
      this.isTouching = true;

      // Show joystick base at touch point
      this.joystickBase.style.display = "block";
      this.joystickBase.style.left = `${touch.clientX}px`;
      this.joystickBase.style.top = `${touch.clientY}px`;
      // Reset knob to center
      this.joystickKnob.style.transform = "translate(-50%, -50%)";
    }, { passive: false });

    zone.addEventListener("touchmove", (e: TouchEvent) => {
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i];
        if (touch.identifier !== this.touchId) continue;

        const dx = touch.clientX - this.touchOriginX;
        const dy = touch.clientY - this.touchOriginY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist > 8) {
          // Calculate angle: screen Y down → game Y up
          this.targetAngle = Math.atan2(-dy, dx);

          // Clamp knob visual within base radius (60px)
          const maxR = 50;
          const clampedDist = Math.min(dist, maxR);
          const normDx = (dx / dist) * clampedDist;
          const normDy = (dy / dist) * clampedDist;
          this.joystickKnob.style.transform =
            `translate(calc(-50% + ${normDx}px), calc(-50% + ${normDy}px))`;
        }
        break;
      }
    }, { passive: false });

    const onTouchEnd = (e: TouchEvent) => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === this.touchId) {
          this.touchId = null;
          this.isTouching = false;
          this.joystickBase.style.display = "none";
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
    // Clean up if needed
  }
}
