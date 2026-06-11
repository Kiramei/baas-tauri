import { BasePlayer } from "./player/BasePlayer";
import { ScreenInfo } from "./GeometryInfo";
import {
  ControlMessage,
  KeyCodeControlMessage,
  ScrollControlMessage,
  TouchControlMessage,
} from "./MessageCenter";

import { Point, Position, Size } from "./GeometryInfo";
import { DataUtil } from "./CommonUtil";
import { KeyEvent, KeyToCodeMap } from "./KeySpaceMap";

interface Touch {
  action: number;
  position: Position;
  buttons: number;
  invalid: boolean;
}

interface TouchOnClient {
  client: {
    width: number;
    height: number;
  };
  touch: Touch;
}

interface CommonTouchAndMouse {
  clientX: number;
  clientY: number;
  type: string;
  target: EventTarget | null;
  buttons: number;
}

interface MiniMouseEvent extends CommonTouchAndMouse {
  ctrlKey: boolean;
  shiftKey: boolean;
  buttons: number;
}

class MotionEvent {
  public static ACTION_DOWN = 0;
  public static ACTION_UP = 1;
  public static ACTION_MOVE = 2;
  public static BUTTON_PRIMARY: number = 1 << 0;
}

export type TouchEventNames =
  | "touchstart"
  | "touchend"
  | "touchmove"
  | "touchcancel"
  | "mousedown"
  | "mouseup"
  | "mousemove";
export type WheelEventNames = "wheel";
export type InteractionEvents = TouchEventNames | WheelEventNames;
export type KeyEventNames = "keydown" | "keyup";

export interface KeyEventListener {
  onKeyEvent: (event: KeyCodeControlMessage) => void;
}

abstract class InteractionHandlerBase {
  protected static readonly SIMULATE_MULTI_TOUCH = "SIMULATE_MULTI_TOUCH";
  protected static readonly STROKE_STYLE: string = "#00BEA4";
  protected static EVENT_ACTION_MAP: Record<string, number> = {
    touchstart: MotionEvent.ACTION_DOWN,
    touchend: MotionEvent.ACTION_UP,
    touchmove: MotionEvent.ACTION_MOVE,
    touchcancel: MotionEvent.ACTION_UP,
    mousedown: MotionEvent.ACTION_DOWN,
    mousemove: MotionEvent.ACTION_MOVE,
    mouseup: MotionEvent.ACTION_UP,
    [InteractionHandlerBase.SIMULATE_MULTI_TOUCH]: -1,
  };
  private static options = DataUtil.supportsPassive() ? { passive: false } : false;
  private static idToPointerMap: Map<number, number> = new Map();
  private static pointerToIdMap: Map<number, number> = new Map();
  private static touchPointRadius = 10;
  private static centerPointRadius = 5;
  private static touchPointImage?: HTMLImageElement;
  private static centerPointImage?: HTMLImageElement;
  private static pointImagesLoaded = false;
  private static eventListeners: Map<string, Set<InteractionHandlerBase>> = new Map();
  protected readonly ctx: CanvasRenderingContext2D | null;
  protected readonly tag: HTMLCanvasElement;
  protected over = false;
  protected lastPosition?: MouseEvent;
  private multiTouchActive = false;
  private multiTouchCenter?: Point;
  private multiTouchShift = false;
  private dirtyPlace: Point[] = [];

  protected constructor(
    public readonly player: BasePlayer,
    public readonly touchEventsNames: InteractionEvents[],
    public readonly keyEventsNames: KeyEventNames[]
  ) {
    this.tag = player.getTouchableElement();
    this.ctx = this.tag.getContext("2d");
    InteractionHandlerBase.loadImages();
    InteractionHandlerBase.bindGlobalListeners(this);
  }

  public static mapTypeToAction(type: string): number {
    return this.EVENT_ACTION_MAP[type];
  }

  protected static bindGlobalListeners(interactionHandler: InteractionHandlerBase): void {
    interactionHandler.touchEventsNames.forEach((eventName) => {
      let set: Set<InteractionHandlerBase> | undefined =
        InteractionHandlerBase.eventListeners.get(eventName);
      if (!set) {
        set = new Set();
        document.body.addEventListener(
          eventName,
          this.onInteractionEvent,
          InteractionHandlerBase.options
        );
        this.eventListeners.set(eventName, set);
      }
      set.add(interactionHandler);
    });
    interactionHandler.keyEventsNames.forEach((eventName) => {
      let set = InteractionHandlerBase.eventListeners.get(eventName);
      if (!set) {
        set = new Set();
        document.body.addEventListener(eventName, this.onKeyEvent);
        this.eventListeners.set(eventName, set);
      }
      set.add(interactionHandler);
    });
  }

  protected static unbindListeners(touchHandler: InteractionHandlerBase): void {
    touchHandler.touchEventsNames.forEach((eventName) => {
      const set = InteractionHandlerBase.eventListeners.get(eventName);
      if (!set) {
        return;
      }
      set.delete(touchHandler);
      if (set.size <= 0) {
        this.eventListeners.delete(eventName);
        document.body.removeEventListener(eventName, this.onInteractionEvent);
      }
    });
    touchHandler.keyEventsNames.forEach((eventName) => {
      const set = InteractionHandlerBase.eventListeners.get(eventName);
      if (!set) {
        return;
      }
      set.delete(touchHandler);
      if (set.size <= 0) {
        this.eventListeners.delete(eventName);
        document.body.removeEventListener(eventName, this.onKeyEvent);
      }
    });
  }

  protected static onInteractionEvent = (event: MouseEvent | TouchEvent): void => {
    const set = InteractionHandlerBase.eventListeners.get(event.type as TouchEventNames);
    if (!set) {
      return;
    }
    set.forEach((instance) => {
      instance.onInteraction(event);
    });
  };

  protected static onKeyEvent = (event: KeyboardEvent): void => {
    const set = InteractionHandlerBase.eventListeners.get(event.type as KeyEventNames);
    if (!set) {
      return;
    }
    set.forEach((instance) => {
      instance.onKey(event);
    });
  };

  protected static loadImages(): void {
    if (this.pointImagesLoaded) {
      return;
    }
    const total = 2;
    let current = 0;

    const onload = (event: Event) => {
      if (++current === total) {
        this.pointImagesLoaded = true;
      }
      if (event.target === this.touchPointImage) {
        this.touchPointRadius = this.touchPointImage.width / 2;
      } else if (event.target === this.centerPointImage) {
        this.centerPointRadius = this.centerPointImage.width / 2;
      }
    };
    const touch = (this.touchPointImage = new Image());
    touch.onload = onload;
    const center = (this.centerPointImage = new Image());
    center.onload = onload;
  }

  protected static getPointerId(type: string, identifier: number): number {
    if (this.idToPointerMap.has(identifier)) {
      const pointerId = this.idToPointerMap.get(identifier) as number;
      if (type === "touchend" || type === "touchcancel") {
        this.idToPointerMap.delete(identifier);
        this.pointerToIdMap.delete(pointerId);
      }
      return pointerId;
    }
    let pointerId = 0;
    while (this.pointerToIdMap.has(pointerId)) {
      pointerId++;
    }
    this.idToPointerMap.set(identifier, pointerId);
    this.pointerToIdMap.set(pointerId, identifier);
    return pointerId;
  }

  protected static buildTouchOnClient(
    event: CommonTouchAndMouse,
    screenInfo: ScreenInfo
  ): TouchOnClient | null {
    const action = this.mapTypeToAction(event.type);
    const { width, height } = screenInfo.videoSize;
    const target: HTMLElement = event.target as HTMLElement;
    const rect = target.getBoundingClientRect();
    let { clientWidth, clientHeight } = target;
    let touchX = event.clientX - rect.left;
    let touchY = event.clientY - rect.top;
    let invalid = false;
    if (touchX < 0 || touchX > clientWidth || touchY < 0 || touchY > clientHeight) {
      invalid = true;
    }
    const eps = 1e5;
    const ratio = width / height;
    const shouldBe = Math.round(eps * ratio);
    const haveNow = Math.round((eps * clientWidth) / clientHeight);
    if (shouldBe > haveNow) {
      const realHeight = Math.ceil(clientWidth / ratio);
      const top = (clientHeight - realHeight) / 2;
      if (touchY < top || touchY > top + realHeight) {
        invalid = true;
      }
      touchY -= top;
      clientHeight = realHeight;
    } else if (shouldBe < haveNow) {
      const realWidth = Math.ceil(clientHeight * ratio);
      const left = (clientWidth - realWidth) / 2;
      if (touchX < left || touchX > left + realWidth) {
        invalid = true;
      }
      touchX -= left;
      clientWidth = realWidth;
    }
    const x = (touchX * width) / clientWidth;
    const y = (touchY * height) / clientHeight;
    const size = new Size(width, height);
    const point = new Point(x, y);
    const position = new Position(point, size);
    if (x < 0 || y < 0 || x > width || y > height) {
      invalid = true;
    }
    return {
      client: {
        width: clientWidth,
        height: clientHeight,
      },
      touch: {
        invalid,
        action,
        position,
        buttons: event.buttons,
      },
    };
  }

  protected static createEmulatedMessage(
    action: number,
    event: TouchControlMessage
  ): TouchControlMessage {
    const { pointerId, position, buttons } = event;
    let pressure = event.pressure;
    if (action === MotionEvent.ACTION_UP) {
      pressure = 0;
    }
    return new TouchControlMessage(action, pointerId, position, pressure, buttons);
  }

  private static validateMessage(
    originalEvent: MiniMouseEvent | TouchEvent,
    message: TouchControlMessage,
    storage: Map<number, TouchControlMessage>
  ): TouchControlMessage[] {
    const messages: TouchControlMessage[] = [];
    const { action, pointerId } = message;
    const previous = storage.get(pointerId);
    if (action === MotionEvent.ACTION_UP) {
      if (!previous) {
        console.warn("Received ACTION_UP while there are no DOWN stored");
      } else {
        storage.delete(pointerId);
        messages.push(message);
      }
    } else if (action === MotionEvent.ACTION_DOWN) {
      if (previous) {
        console.warn("Received ACTION_DOWN while already has one stored");
      } else {
        storage.set(pointerId, message);
        messages.push(message);
      }
    } else if (action === MotionEvent.ACTION_MOVE) {
      if (!previous) {
        if (
          (originalEvent instanceof MouseEvent && originalEvent.buttons) ||
          (window["TouchEvent"] && originalEvent instanceof TouchEvent)
        ) {
          console.warn("Received ACTION_MOVE while there are no DOWN stored");
          const emulated = InteractionHandlerBase.createEmulatedMessage(
            MotionEvent.ACTION_DOWN,
            message
          );
          messages.push(emulated);
          storage.set(pointerId, emulated);
        }
      } else {
        messages.push(message);
        storage.set(pointerId, message);
      }
    }
    return messages;
  }

  public drawLine(point1: Point, point2: Point): void {
    if (!this.ctx) {
      return;
    }
    this.ctx.save();
    this.ctx.strokeStyle = InteractionHandlerBase.STROKE_STYLE;
    this.ctx.beginPath();
    this.ctx.moveTo(point1.x, point1.y);
    this.ctx.lineTo(point2.x, point2.y);
    this.ctx.stroke();
    this.ctx.restore();
  }

  public drawPointer(point: Point): void {
    this.drawPoint(
      point,
      InteractionHandlerBase.touchPointRadius,
      InteractionHandlerBase.touchPointImage
    );
    if (this.multiTouchCenter) {
      this.drawLine(this.multiTouchCenter, point);
    }
  }

  public drawCenter(point: Point): void {
    this.drawPoint(
      point,
      InteractionHandlerBase.centerPointRadius,
      InteractionHandlerBase.centerPointImage
    );
  }

  public clearCanvas(): void {
    const { clientWidth, clientHeight } = this.tag;
    const ctx = this.ctx;
    if (ctx && this.dirtyPlace.length) {
      const topLeft = this.dirtyPlace[0];
      const bottomRight = this.dirtyPlace[1];
      this.dirtyPlace.length = 0;
      const x = Math.max(topLeft.x, 0);
      const y = Math.max(topLeft.y, 0);
      const w = Math.min(clientWidth, bottomRight.x - x);
      const h = Math.min(clientHeight, bottomRight.y - y);
      ctx.clearRect(x, y, w, h);
      ctx.strokeStyle = InteractionHandlerBase.STROKE_STYLE;
    }
  }

  public formatTouchEvent(
    e: TouchEvent,
    screenInfo: ScreenInfo,
    storage: Map<number, TouchControlMessage>
  ): TouchControlMessage[] {
    const messages: TouchControlMessage[] = [];
    const touches = e.changedTouches;
    if (touches && touches.length) {
      for (let i = 0, l = touches.length; i < l; i++) {
        const touch = touches[i];
        const pointerId = InteractionHandlerBase.getPointerId(e.type, touch.identifier);
        if (touch.target !== this.tag) {
          continue;
        }
        const previous = storage.get(pointerId);
        const item: CommonTouchAndMouse = {
          clientX: touch.clientX,
          clientY: touch.clientY,
          type: e.type,
          buttons: MotionEvent.BUTTON_PRIMARY,
          target: e.target,
        };
        const event = InteractionHandlerBase.buildTouchOnClient(item, screenInfo);
        if (event) {
          const { action, buttons, position, invalid } = event.touch;
          let pressure = 1;
          if (action === MotionEvent.ACTION_UP) {
            pressure = 0;
          } else if (typeof touch.force === "number") {
            pressure = touch.force;
          }
          if (!invalid) {
            const message = new TouchControlMessage(action, pointerId, position, pressure, buttons);
            messages.push(...InteractionHandlerBase.validateMessage(e, message, storage));
          } else {
            if (previous) {
              messages.push(
                InteractionHandlerBase.createEmulatedMessage(MotionEvent.ACTION_UP, previous)
              );
              storage.delete(pointerId);
            }
          }
        } else {
          console.error(`Failed to format touch`, touch);
        }
      }
    } else {
      console.error('No "touches"', e);
    }
    return messages;
  }

  public buildTouchEvent(
    e: MiniMouseEvent,
    screenInfo: ScreenInfo,
    storage: Map<number, TouchControlMessage>
  ): TouchControlMessage[] {
    const touches = this.getTouch(e, screenInfo, e.ctrlKey, e.shiftKey);
    if (!touches) {
      return [];
    }
    const messages: TouchControlMessage[] = [];
    const points: Point[] = [];
    this.clearCanvas();
    touches.forEach((touch: Touch, pointerId: number) => {
      const { action, buttons, position } = touch;
      const previous = storage.get(pointerId);
      if (!touch.invalid) {
        let pressure = 1.0;
        if (action === MotionEvent.ACTION_UP) {
          pressure = 0;
        }
        const message = new TouchControlMessage(action, pointerId, position, pressure, buttons);
        messages.push(...InteractionHandlerBase.validateMessage(e, message, storage));
        points.push(touch.position.point);
      } else {
        if (previous) {
          points.push(previous.position.point);
        }
      }
    });
    if (this.multiTouchActive) {
      if (this.multiTouchCenter) {
        this.drawCenter(this.multiTouchCenter);
      }
      points.forEach((point) => {
        this.drawPointer(point);
      });
    }
    const hasActionUp = messages.find((message) => {
      return message.action === MotionEvent.ACTION_UP;
    });
    if (hasActionUp && storage.size) {
      console.warn("Looks like one of Multi-touch pointers was not raised up");
      storage.forEach((message) => {
        messages.push(InteractionHandlerBase.createEmulatedMessage(MotionEvent.ACTION_UP, message));
      });
      storage.clear();
    }
    return messages;
  }

  public release(): void {
    InteractionHandlerBase.unbindListeners(this);
  }

  protected abstract onInteraction(event: MouseEvent | TouchEvent): void;

  protected abstract onKey(event: KeyboardEvent): void;

  protected getTouch(
    e: CommonTouchAndMouse,
    screenInfo: ScreenInfo,
    ctrlKey: boolean,
    shiftKey: boolean
  ): Touch[] | null {
    const touchOnClient = InteractionHandlerBase.buildTouchOnClient(e, screenInfo);
    if (!touchOnClient) {
      return null;
    }
    const { client, touch } = touchOnClient;
    const result: Touch[] = [touch];
    if (!ctrlKey) {
      this.multiTouchActive = false;
      this.multiTouchCenter = undefined;
      this.multiTouchShift = false;
      this.clearCanvas();
      return result;
    }
    const { position, action, buttons } = touch;
    const { point, screenSize } = position;
    const { width, height } = screenSize;
    const { x, y } = point;
    if (!this.multiTouchActive) {
      if (shiftKey) {
        this.multiTouchCenter = point;
        this.multiTouchShift = true;
      } else {
        this.multiTouchCenter = new Point(client.width / 2, client.height / 2);
      }
    }
    this.multiTouchActive = true;
    let opposite: Point | undefined;
    let invalid = false;
    if (this.multiTouchShift && this.multiTouchCenter) {
      const oppoX = 2 * this.multiTouchCenter.x - x;
      const oppoY = 2 * this.multiTouchCenter.y - y;
      opposite = new Point(oppoX, oppoY);
      if (!(oppoX <= width && oppoX >= 0 && oppoY <= height && oppoY >= 0)) {
        invalid = true;
      }
    } else {
      opposite = new Point(client.width - x, client.height - y);
      invalid = touch.invalid;
    }
    if (opposite) {
      result.push({
        invalid,
        action,
        buttons,
        position: new Position(opposite, screenSize),
      });
    }
    return result;
  }

  protected drawCircle(ctx: CanvasRenderingContext2D, point: Point, radius: number): void {
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2, true);
    ctx.stroke();
  }

  protected drawPoint(point: Point, radius: number, image?: HTMLImageElement): void {
    if (!this.ctx) {
      return;
    }
    let { lineWidth } = this.ctx;
    if (InteractionHandlerBase.pointImagesLoaded && image) {
      radius = image.width / 2;
      lineWidth = 0;
      this.ctx.drawImage(image, point.x - radius, point.y - radius);
    } else {
      this.drawCircle(this.ctx, point, radius);
    }

    const topLeft = new Point(point.x - radius - lineWidth, point.y - radius - lineWidth);
    const bottomRight = new Point(point.x + radius + lineWidth, point.y + radius + lineWidth);
    this.updateDirty(topLeft, bottomRight);
  }

  protected updateDirty(topLeft: Point, bottomRight: Point): void {
    if (!this.dirtyPlace.length) {
      this.dirtyPlace.push(topLeft, bottomRight);
      return;
    }
    const currentTopLeft = this.dirtyPlace[0];
    const currentBottomRight = this.dirtyPlace[1];
    const newTopLeft = new Point(
      Math.min(currentTopLeft.x, topLeft.x),
      Math.min(currentTopLeft.y, topLeft.y)
    );
    const newBottomRight = new Point(
      Math.max(currentBottomRight.x, bottomRight.x),
      Math.max(currentBottomRight.y, bottomRight.y)
    );
    this.dirtyPlace.length = 0;
    this.dirtyPlace.push(newTopLeft, newBottomRight);
  }
}

export interface InteractionHandlerListener {
  sendMessage: (message: ControlMessage) => void;
}

export class InteractionHandler extends InteractionHandlerBase {
  public static SCROLL_EVENT_THROTTLING_TIME = 30; // one event per 50ms
  private static readonly touchEventsNames: InteractionEvents[] = [
    "touchstart",
    "touchend",
    "touchmove",
    "touchcancel",
    "mousedown",
    "mouseup",
    "mousemove",
    "wheel",
  ];
  private static readonly keyEventsNames: KeyEventNames[] = ["keydown", "keyup"];
  private readonly storedFromMouseEvent = new Map<number, TouchControlMessage>();
  private readonly storedFromTouchEvent = new Map<number, TouchControlMessage>();
  private lastScrollEvent?: { time: number; hScroll: number; vScroll: number };

  constructor(
    player: BasePlayer,
    public readonly listener: InteractionHandlerListener
  ) {
    super(player, InteractionHandler.touchEventsNames, InteractionHandler.keyEventsNames);
    this.tag.addEventListener("mouseleave", this.onMouseLeave);
    this.tag.addEventListener("mouseenter", this.onMouseEnter);
  }

  public buildScrollEvent(event: WheelEvent, screenInfo: ScreenInfo): ScrollControlMessage[] {
    const messages: ScrollControlMessage[] = [];
    const touchOnClient = InteractionHandlerBase.buildTouchOnClient(event, screenInfo);
    if (touchOnClient) {
      // eslint-disable-next-line no-compare-neg-zero
      const hScroll = event.deltaX > 0 ? -1 : event.deltaX < -0 ? 1 : 0;
      // eslint-disable-next-line no-compare-neg-zero
      const vScroll = event.deltaY > 0 ? -1 : event.deltaY < -0 ? 1 : 0;
      const time = Date.now();
      if (
        !this.lastScrollEvent ||
        time - this.lastScrollEvent.time > InteractionHandler.SCROLL_EVENT_THROTTLING_TIME ||
        this.lastScrollEvent.vScroll !== vScroll ||
        this.lastScrollEvent.hScroll !== hScroll
      ) {
        this.lastScrollEvent = { time, hScroll, vScroll };
        messages.push(new ScrollControlMessage(touchOnClient.touch.position, hScroll, vScroll));
      }
    }
    return messages;
  }

  public release(): void {
    super.release();
    this.tag.removeEventListener("mouseleave", this.onMouseLeave);
    this.tag.removeEventListener("mouseenter", this.onMouseEnter);
    this.storedFromMouseEvent.clear();
  }

  protected onInteraction(event: MouseEvent | TouchEvent): void {
    const screenInfo = this.player.getScreenInfo();
    if (!screenInfo) {
      return;
    }
    let messages: ControlMessage[];
    let storage: Map<number, TouchControlMessage>;
    if (event instanceof MouseEvent) {
      if (event.target !== this.tag) {
        return;
      }
      if (window["WheelEvent"] && event instanceof WheelEvent) {
        messages = this.buildScrollEvent(event, screenInfo);
      } else {
        storage = this.storedFromMouseEvent;
        messages = this.buildTouchEvent(event, screenInfo, storage);
      }
      if (this.over) {
        this.lastPosition = event;
      }
    } else if (window["TouchEvent"] && event instanceof TouchEvent) {
      // TODO: Research drag from out of the target inside it
      if (event.target !== this.tag) {
        return;
      }
      storage = this.storedFromTouchEvent;
      messages = this.formatTouchEvent(event, screenInfo, storage);
    } else {
      return;
    }
    if (event.cancelable) {
      event.preventDefault();
    }
    event.stopPropagation();
    messages.forEach((message) => {
      this.listener.sendMessage(message);
    });
  }

  protected onKey(event: KeyboardEvent): void {
    if (!this.lastPosition) {
      return;
    }
    const screenInfo = this.player.getScreenInfo();
    if (!screenInfo) {
      return;
    }
    const { ctrlKey, shiftKey } = event;
    const { target, button, buttons, clientY, clientX } = this.lastPosition;
    const type = InteractionHandlerBase.SIMULATE_MULTI_TOUCH;
    const props = { ctrlKey, shiftKey, type, target, button, buttons, clientX, clientY };
    this.buildTouchEvent(props, screenInfo, new Map());
  }

  private onMouseEnter = (): void => {
    this.over = true;
  };

  private onMouseLeave = (): void => {
    this.lastPosition = undefined;
    this.over = false;
    this.storedFromMouseEvent.forEach((message) => {
      this.listener.sendMessage(
        InteractionHandlerBase.createEmulatedMessage(MotionEvent.ACTION_UP, message)
      );
    });
    this.storedFromMouseEvent.clear();
    this.clearCanvas();
  };
}

export class KeyInputHandler {
  private static readonly repeatCounter: Map<number, number> = new Map();
  private static readonly listeners: Set<KeyEventListener> = new Set();

  public static addEventListener(listener: KeyEventListener): void {
    if (!this.listeners.size) {
      this.attachListeners();
    }
    this.listeners.add(listener);
  }

  public static removeEventListener(listener: KeyEventListener): void {
    this.listeners.delete(listener);
    if (!this.listeners.size) {
      this.detachListeners();
    }
  }

  private static handler = (event: Event): void => {
    const keyboardEvent = event as KeyboardEvent;
    const keyCode = KeyToCodeMap.get(keyboardEvent.code);
    if (!keyCode) {
      return;
    }
    let action: typeof KeyEvent.ACTION_DOWN | typeof KeyEvent.ACTION_DOWN;
    let repeatCount = 0;
    if (keyboardEvent.type === "keydown") {
      action = KeyEvent.ACTION_DOWN;
      if (keyboardEvent.repeat) {
        let count = KeyInputHandler.repeatCounter.get(keyCode);
        if (typeof count !== "number") {
          count = 1;
        } else {
          count++;
        }
        repeatCount = count;
        KeyInputHandler.repeatCounter.set(keyCode, count);
      }
    } else if (keyboardEvent.type === "keyup") {
      action = KeyEvent.ACTION_UP;
      KeyInputHandler.repeatCounter.delete(keyCode);
    } else {
      return;
    }
    const metaState =
      (keyboardEvent.getModifierState("Alt") ? KeyEvent.META_ALT_ON : 0) |
      (keyboardEvent.getModifierState("Shift") ? KeyEvent.META_SHIFT_ON : 0) |
      (keyboardEvent.getModifierState("Control") ? KeyEvent.META_CTRL_ON : 0) |
      (keyboardEvent.getModifierState("Meta") ? KeyEvent.META_META_ON : 0) |
      (keyboardEvent.getModifierState("CapsLock") ? KeyEvent.META_CAPS_LOCK_ON : 0) |
      (keyboardEvent.getModifierState("ScrollLock") ? KeyEvent.META_SCROLL_LOCK_ON : 0) |
      (keyboardEvent.getModifierState("NumLock") ? KeyEvent.META_NUM_LOCK_ON : 0);

    const controlMessage: KeyCodeControlMessage = new KeyCodeControlMessage(
      action,
      keyCode,
      repeatCount,
      metaState
    );
    KeyInputHandler.listeners.forEach((listener) => {
      listener.onKeyEvent(controlMessage);
    });
    event.preventDefault();
  };

  private static attachListeners(): void {
    document.body.addEventListener("keydown", this.handler);
    document.body.addEventListener("keyup", this.handler);
  }

  private static detachListeners(): void {
    document.body.removeEventListener("keydown", this.handler);
    document.body.removeEventListener("keyup", this.handler);
  }
}
