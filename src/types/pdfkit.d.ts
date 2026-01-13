declare module "pdfkit" {
  import { EventEmitter } from "events";

  interface TextOptions {
    align?: "left" | "center" | "right" | "justify";
    width?: number;
    continued?: boolean;
    lineGap?: number;
  }

  interface ImageOptions {
    width?: number;
    height?: number;
    scale?: number;
    align?: string;
    valign?: string;
    opacity?: number;
  }

  export default class PDFDocument extends EventEmitter {
  y: number;

  constructor(options?: any);

  opacity(value: number): this;

  font(src: string): this;
  fontSize(size: number): this;
  fillColor(color: string): this;
  text(text: string, options?: TextOptions): this;
  text(text: string, x?: number, y?: number, options?: TextOptions): this;

  moveDown(lines?: number): this;
  moveUp(lines?: number): this;

  moveTo(x: number, y: number): this;
  lineTo(x: number, y: number): this;
  lineWidth(width: number): this;
  stroke(color?: string): this;
  rect(x: number, y: number, w: number, h: number): this;

  image(src: string, x?: number, y?: number, options?: ImageOptions): this;

  end(): void;
}

}
