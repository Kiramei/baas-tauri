export default abstract class Canvas {
  protected constructor(protected readonly canvas: HTMLCanvasElement) {}
  public abstract decode(buffer: Uint8Array, width: number, height: number): void;
}
