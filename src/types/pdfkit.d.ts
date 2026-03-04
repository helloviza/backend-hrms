// apps/backend/src/types/pdfkit.d.ts
declare module "pdfkit" {
  import { EventEmitter } from "events";

  interface TextOptions {
    align?: "left" | "center" | "right" | "justify";
    width?: number;
    continued?: boolean;
    lineGap?: number;

    underline?: boolean;
    oblique?: boolean;
    characterSpacing?: number;
    lineBreak?: boolean;
    ellipsis?: boolean | string;
  }

  interface ImageOptions {
    width?: number;
    height?: number;
    scale?: number;
    align?: string;
    valign?: string;
    opacity?: number;
    fit?: [number, number];
  }

  interface PDFPage {
    width: number;
    height: number;
    // ✅ in real pdfkit this exists; make it required to avoid TS "possibly undefined"
    margins: { top: number; left: number; right: number; bottom: number };
  }

  class PDFDocument extends EventEmitter {
    x: number;
    y: number;
    page: PDFPage;

    constructor(options?: any);

    // lifecycle
    addPage(options?: any): this;
    end(): void;

    // state
    opacity(value: number): this;
    save(): this;
    restore(): this;

    // fonts / text
    font(src: string): this;
    fontSize(size: number): this;
    fillColor(color: string): this;
    strokeColor(color: string): this;

    text(text: string, options?: TextOptions): this;
    text(text: string, x?: number, y?: number, options?: TextOptions): this;

    // measuring helpers
    widthOfString(text: string, options?: TextOptions): number;
    heightOfString(text: string, options?: TextOptions): number;

    // flow helpers
    moveDown(lines?: number): this;
    moveUp(lines?: number): this;

    // drawing
    moveTo(x: number, y: number): this;
    lineTo(x: number, y: number): this;
    lineWidth(width: number): this;
    stroke(color?: string): this;

    rect(x: number, y: number, w: number, h: number): this;
    roundedRect(x: number, y: number, w: number, h: number, r: number): this;
    fill(color?: string): this;

    // images
    image(src: string | Buffer, x?: number, y?: number, options?: ImageOptions): this;

    // events
    on(event: "data", listener: (chunk: Buffer) => void): this;
    on(event: "end", listener: () => void): this;
    on(event: "error", listener: (err: any) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
  }

  // ✅ support codebases that use PDFKit.PDFDocument typing
  namespace PDFKit {
    export { PDFDocument };
  }

  export default PDFDocument;
}

export {};
